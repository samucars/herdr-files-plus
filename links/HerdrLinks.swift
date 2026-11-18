// Herdr Links: opens file links in a Files Plus tab in Herdr.
//
// Terminal programs print clickable file links, and the click goes to whatever the system
// opens them with: Codex prints editor links (vscode://file/<path>:<line>), Claude Code
// prints file:// links, which open in the default app for the file type. This app takes
// both, and files from Finder, and runs `herdr-app do tab.new` with the files-plus mod.
//
//   HerdrLinks <link or path>         open it in Herdr (what the app does when clicked)
//   HerdrLinks --utis                 the content types of EXTENSIONS, for Info.plist
//   HerdrLinks --set-defaults <file>  make this app their default, saving the old ones in <file>
//   HerdrLinks --restore <file>       put the saved defaults back
import AppKit
import UniformTypeIdentifiers

// Text and code files this app becomes the default for. Not html, csv, log, svg:
// those have better homes (a browser, a spreadsheet, Console, an image viewer).
let EXTENSIONS = [
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "lock",
  "js", "mjs", "cjs", "jsx", "ts", "cts", "tsx", "vue", "svelte", "astro",
  "css", "scss", "sass", "less",
  "py", "pyi", "rb", "go", "rs", "swift", "java", "kt", "kts", "scala", "groovy", "gradle",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "cs", "fs", "zig", "nim",
  "php", "lua", "dart", "ex", "exs", "erl", "hrl", "clj", "cljs", "elm", "hs", "ml", "r", "jl", "pl", "pm",
  "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql", "proto", "prisma", "tf", "tfvars", "hcl", "nix", "dockerfile",
  "xml", "plist", "patch", "diff",
]
// The scheme Codex's `file_opener = "vscode-insiders"` prints (VS Code Insiders isn't installed).
let SCHEME = "vscode-insiders"
let HERDR_ID = "dev.herdr.app"

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

// MARK: Opening a link

struct Target { var path: String; var line: Int }

// "/a/b.ts", "/a/b.ts:12", "/a/b.ts:12:3", file:///a/b.ts, file:///a/b.ts#L12,
// vscode://file/a/b.ts:12:3 (any scheme with a /file/ host, as editors print them).
func parse(_ raw: String) -> Target? {
  var path = raw, fragment: String? = nil
  if let c = URLComponents(string: raw), let scheme = c.scheme, scheme.count > 1 {
    guard scheme == "file" || c.host == "file" else { return nil }
    path = c.percentEncodedPath.removingPercentEncoding ?? c.path
    fragment = c.fragment
  }
  if path.hasPrefix("~/") { path = NSHomeDirectory() + path.dropFirst(1) }
  var line = 0
  if let f = fragment, let n = Int(f.drop(while: { $0 == "L" }).prefix(while: { $0.isNumber })) { line = n }
  // A :line or :line:col suffix, unless that's really part of the file's name.
  if !FileManager.default.fileExists(atPath: path),
     let m = path.firstMatch(of: try! Regex(#"^(.+?):(\d+)(?::\d+)?$"#)),
     let file = m[1].substring, let n = m[2].substring {
    path = String(file); line = Int(n) ?? 0
  }
  guard path.hasPrefix("/") else { return nil }
  return Target(path: (path as NSString).standardizingPath, line: line)
}

func herdrApp() -> String? {
  let link = NSHomeDirectory() + "/.local/bin/herdr-app"
  if FileManager.default.isExecutableFile(atPath: link) { return link }
  return NSWorkspace.shared.urlForApplication(withBundleIdentifier: HERDR_ID)?
    .appendingPathComponent("Contents/MacOS/Herdr").path
}

@discardableResult
func run(_ exe: String, _ args: [String]) -> (ok: Bool, out: String) {
  let p = Process(), pipe = Pipe()
  p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
  p.standardOutput = pipe; p.standardError = pipe
  do { try p.run() } catch { return (false, "\(error)") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  let out = String(data: data, encoding: .utf8) ?? ""
  return (p.terminationStatus == 0 && !out.contains("\"error\""), out)
}

func open(_ raw: String) {
  guard let t = parse(raw) else { return log("not a local file link: \(raw)") }
  var isDir: ObjCBool = false
  guard FileManager.default.fileExists(atPath: t.path, isDirectory: &isDir) else { return log("no such file: \(t.path)") }
  if isDir.boolValue {  // Files Plus opens files; a folder goes to Finder.
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: t.path)]); return
  }
  guard let herdr = herdrApp() else { return log("Herdr isn't installed") }
  let args: [String: Any] = [
    "name": (t.path as NSString).lastPathComponent, "mod": "files-plus",
    "props": ["file": t.path, "on": NSNull(), "line": t.line, "link": true],
  ]
  let json = String(data: try! JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
  _ = run("/usr/bin/open", ["-b", HERDR_ID])  // start it or bring it to the front
  // A Herdr that is just starting refuses commands until its window is up.
  var last = ""
  for _ in 0..<40 {
    let r = run(herdr, ["do", "tab.new", json])
    if r.ok { return }
    last = r.out
    Thread.sleep(forTimeInterval: 0.5)
  }
  log("herdr-app didn't open it: \(last)")
}

func log(_ message: String) {
  FileHandle.standardError.write(("Herdr Links: " + message + "\n").data(using: .utf8)!)
  NSLog("Herdr Links: %@", message)
}

// MARK: Defaults

func utis() -> [String] {
  var seen = Set<String>()
  return EXTENSIONS.compactMap { UTType(filenameExtension: $0)?.identifier }.filter { seen.insert($0).inserted }
}

func wait(_ body: (@escaping (Error?) -> Void) -> Void) -> Error? {
  let s = DispatchSemaphore(value: 0); var result: Error?
  body { result = $0; s.signal() }
  s.wait(); return result
}

// The backup maps a content type (or "scheme:<name>") to the app path that opened it.
func setDefaults(backup: String) {
  let me = Bundle.main.bundleURL, ws = NSWorkspace.shared
  var old: [String: String] = [:]
  if let data = FileManager.default.contents(atPath: backup),
     let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String] { old = saved }
  for id in utis() {
    guard let type = UTType(id) else { continue }
    if old[id] == nil, let cur = ws.urlForApplication(toOpen: type), cur.standardizedFileURL != me.standardizedFileURL {
      old[id] = cur.path
    }
    if let e = wait({ ws.setDefaultApplication(at: me, toOpen: type, completion: $0) }) { log("\(id): \(e.localizedDescription)") }
  }
  if let e = wait({ ws.setDefaultApplication(at: me, toOpenURLsWithScheme: SCHEME, completion: $0) }) { log("\(SCHEME): \(e.localizedDescription)") }
  let data = try! JSONSerialization.data(withJSONObject: old, options: [.prettyPrinted, .sortedKeys])
  FileManager.default.createFile(atPath: backup, contents: data)
  print("Herdr Links opens \(utis().count) file types and \(SCHEME):// links; old defaults saved in \(backup)")
}

func restore(backup: String) {
  guard let data = FileManager.default.contents(atPath: backup),
        let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { fail("no backup at \(backup)") }
  let ws = NSWorkspace.shared
  for (id, app) in saved.sorted(by: { $0.key < $1.key }) {
    guard let type = UTType(id), FileManager.default.fileExists(atPath: app) else { continue }
    if let e = wait({ ws.setDefaultApplication(at: URL(fileURLWithPath: app), toOpen: type, completion: $0) }) {
      log("\(id): \(e.localizedDescription)")
    }
  }
  print("Restored \(saved.count) defaults from \(backup)")
}

// MARK: The app

class Delegate: NSObject, NSApplicationDelegate {
  var pending = 0
  func applicationDidFinishLaunching(_ n: Notification) {
    // Opened by itself (no link): nothing to do.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if self.pending == 0 { NSApp.terminate(nil) } }
  }
  func application(_ app: NSApplication, open urls: [URL]) {
    pending += 1
    DispatchQueue.global().async {
      for u in urls { open(u.absoluteString) }
      DispatchQueue.main.async { self.pending -= 1; if self.pending == 0 { NSApp.terminate(nil) } }
    }
  }
}

let argv = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
switch argv.first {
case "--utis": utis().forEach { print($0) }
case "--set-defaults":
  guard argv.count > 1 else { fail("--set-defaults <backup.json>") }
  setDefaults(backup: argv[1])
case "--restore":
  guard argv.count > 1 else { fail("--restore <backup.json>") }
  restore(backup: argv[1])
case let arg?: open(arg)
case nil:
  let app = NSApplication.shared, delegate = Delegate()
  app.delegate = delegate
  app.setActivationPolicy(.prohibited)
  app.run()
}
