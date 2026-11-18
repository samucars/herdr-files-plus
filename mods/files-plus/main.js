// A file browser for the focused pane's folder that can also change files:
// right-click for New file/folder, Rename, Copy, Cut, Paste, Duplicate, Delete.
// A click on a file opens it whole in a new tab (an editor; ⌘S saves); Space previews it here.
// Keys (after clicking a row): ↑/↓ select, ←/→ fold, Space preview, Enter rename,
// ⌘C ⌘X ⌘V copy/cut/paste, ⌘D duplicate, ⌘⌫ delete, Esc back from a preview.
// Search box: ⌘F filters by file name, ⇧⌘F searches inside files, Esc clears.
// Drag a row onto a folder to move it (⌥ copies); drop files from Finder to copy them in.
// The same mod also draws its own menu (props.menu) and dialogs (props.dialog).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, run, readTextFile, writeTextFile, watchFolder, theme, settings, window, props, shared, setShared, openOverlay, closeOverlay, notify } from "herdr";
import * as ops from "./ops.js";
import ICONS from "./icons.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const ICON = (name) => `mods/files-plus/${name}.svg`;

// The vscode-icons icon for a file or folder, like VS Code picks it: exact name,
// then the longest extension ("d.ts" before "ts"), then the default.
function iconFor(name, dir, open) {
  const n = name.toLowerCase();
  let icon;
  if (dir) {
    const d = ICONS.dirs[n];
    icon = d ? d[open ? 1 : 0] : open ? ICONS.folderOpen : ICONS.folder;
  } else {
    icon = ICONS.names[n];
    for (let i = n.indexOf("."); !icon && i >= 0; i = n.indexOf(".", i + 1)) icon = ICONS.exts[n.slice(i + 1)];
    icon ??= ICONS.file;
  }
  return image(`mods/files-plus/icons/${icon}.svg`).size(16).flex_none();
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// ---- Search -----------------------------------------------------------------
// Both run in the space's folder on its machine and end with "__ok__" (see ops.js).
const MAX_FILES = 20000, MAX_NAME_HITS = 300, MAX_TEXT_HITS = 2000;

// Every file under root, relative to it: Git's view when it's a repo (tracked and
// untracked, minus ignored and deleted), else find without .git and node_modules.
async function listFiles(root, on) {
  const script = `{ if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then { git ls-files -co --exclude-standard; git ls-files -d; git ls-files -d; } | sort | uniq -u; else find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print | sed 's#^\\./##'; fi; } 2>/dev/null | head -n ${MAX_FILES}; printf '__ok__'`;
  const r = await exec("sh", ["-c", script], { cwd: root, on, timeout: 60000 });
  if (!r.stdout.endsWith("__ok__")) throw new Error(r.stderr || "Cannot list files");
  return r.stdout.slice(0, -6).split("\n").filter(Boolean);
}

// Lines containing q (case-insensitive, literal): ripgrep, else git grep, else grep.
async function grepFiles(root, on, q) {
  const script = `{ if command -v rg >/dev/null 2>&1; then rg -n -i -F --no-heading --color never -M 400 --max-count 50 -e "$1" .
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git grep -n -I -i -F --untracked --exclude-standard -e "$1"
else grep -rnIiF --exclude-dir=.git --exclude-dir=node_modules -e "$1" .; fi; } 2>/dev/null | head -n ${MAX_TEXT_HITS + 1}; printf '__ok__'`;
  const r = await exec("sh", ["-c", script, "files-plus", q], { cwd: root, on, timeout: 60000 });
  if (!r.stdout.endsWith("__ok__")) throw new Error(r.stderr || "Search failed");
  const files = new Map();
  let total = 0;
  for (const line of r.stdout.slice(0, -6).split("\n")) {
    const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
    if (!m || ++total > MAX_TEXT_HITS) continue;
    if (!files.has(m[1])) files.set(m[1], []);
    files.get(m[1]).push({ line: Number(m[2]), text: m[3] });
  }
  return { files: [...files].map(([rel, hits]) => ({ rel, hits })), more: total > MAX_TEXT_HITS };
}

// Files and folders whose path contains q, best first: name starts with it, name
// contains it, path contains it; shorter paths first.
function matchNames(files, q) {
  const needle = q.toLowerCase(), all = new Map();
  for (const f of files) {
    all.set(f, false);
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) all.set(f.slice(0, i), true);
  }
  const hits = [];
  for (const [rel, dir] of all) {
    const p = rel.toLowerCase();
    if (!p.includes(needle)) continue;
    const name = p.slice(p.lastIndexOf("/") + 1);
    hits.push({ rel, dir, score: name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2 });
  }
  hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return { hits: hits.slice(0, MAX_NAME_HITS), more: hits.length > MAX_NAME_HITS };
}

// Shows a matched line: trimmed, and cut around the match when long.
function snippet(text, q) {
  const s = text.trim(), at = s.toLowerCase().indexOf(q.toLowerCase());
  if (s.length <= 160) return s;
  const from = Math.max(0, at - 50);
  return (from ? "…" : "") + s.slice(from, from + 160) + "…";
}

// ---- Actions, shared by the panel's keys and the menu -----------------------
// ctx: { key, root, on, rel ("" = the root folder), dir }

const abs = (ctx) => ctx.rel ? `${ctx.root}/${ctx.rel}` : ctx.root;
const folderOf = (ctx) => ctx.dir ? abs(ctx) : ops.parent(abs(ctx));
const relOf = (ctx, path) => path === ctx.root ? "" : path.startsWith(ctx.root + "/") ? path.slice(ctx.root.length + 1) : null;
const canTrash = (ctx) => !ctx.on && window()?.platform === "macos";
const fail = (e) => notify({ title: "Files", body: String(e?.message ?? e), level: "error" });
// Asks the panel to show a path: expand its folders, select it, preview it if `preview`.
const reveal = (ctx, path, preview = false) => {
  const rel = relOf(ctx, path);
  if (rel !== null) setShared("files-plus.reveal", { key: ctx.key, rel, preview, n: Date.now() });
};

// ---- Files in their own tab ---------------------------------------------------
// A click opens the file in a tab whose only pane is this mod ({ file, on, line }).
// "files-plus.tabs" maps "<machine>:<path>" to the tab showing it, so a second
// click selects that tab instead of opening another.
const tabKey = (path, on) => `${on ?? ""}:${path}`;
// Tabs that hold a pane of this mod (a file tab; the panel lives in the layout, not a tab).
const fileTabs = () => new Set(panes().filter(p => p.mod === "files-plus" && !p.terminal).map(p => p.tab));
const lastOpen = new Map();
function openFile(path, on, line = 0) {
  const k = tabKey(path, on), id = (shared("files-plus.tabs") ?? {})[k];
  const space = id && fileTabs().has(id) && spaces().find(s => s.tabs.some(t => t.id === id));
  if (space) {
    if (!space.active) run("space.select", { id: space.id });
    run("tab.select", { id });
    if (line > 0) setShared("files-plus.goto", { key: k, line, n: Date.now() });
    return;
  }
  // A double-click sends two clicks: the tab from the first isn't registered yet.
  if (Date.now() - (lastOpen.get(k) ?? 0) < 1500) return;
  lastOpen.set(k, Date.now());
  run("tab.new", { name: ops.base(path), mod: "files-plus", props: { file: path, on: on ?? null, line } });
}

async function act(name, ctx) {
  try {
    switch (name) {
      case "open": return openFile(abs(ctx), ctx.on);
      case "rename": return openOverlay({ mod: "files-plus", kind: "dialog", width: 420, props: { dialog: "rename", ctx, value: ops.base(abs(ctx)) } });
      case "newFile": case "newFolder":
        return openOverlay({ mod: "files-plus", kind: "dialog", width: 420, props: { dialog: name, ctx: { ...ctx, rel: relOf(ctx, folderOf(ctx)), dir: true }, value: "" } });
      case "delete": return openOverlay({ mod: "files-plus", kind: "dialog", width: 420, height: 170, props: { dialog: "delete", ctx } });
      case "copy": case "cut": return setShared("files-plus.clipboard", { mode: name, on: ctx.on ?? null, paths: [abs(ctx)] });
      case "paste": {
        const n = await ops.paste(folderOf(ctx), ctx.on);
        if (n) { ops.changed(); if (ctx.dir && ctx.rel) reveal(ctx, folderOf(ctx)); }
        return;
      }
      case "duplicate": await ops.copy(abs(ctx), ops.parent(abs(ctx)), ctx.on); return ops.changed();
      case "reveal": return exec("open", ["-R", abs(ctx)]);
      case "copyPath": return exec("sh", ["-c", 'printf %s "$1" | pbcopy', "files-plus", abs(ctx)]);
    }
  } catch (e) { ops.changed(); fail(e); }
}

// An item is [action, label, hint, disabled, danger]; "-" is a separator.
function menuItems(ctx) {
  const clip = shared("files-plus.clipboard"), mac = window()?.platform === "macos", top = !ctx.rel;
  const canPaste = Boolean(clip?.paths?.length) && (clip.on ?? null) === (ctx.on ?? null);
  return [
    !ctx.dir && ["open", "Open", "Space"],
    (ctx.dir || top) && ["newFile", "New file…"],
    (ctx.dir || top) && ["newFolder", "New folder…"],
    "-",
    !top && ["rename", "Rename…", "↩"],
    !top && ["duplicate", "Duplicate", "⌘D"],
    !top && "-",
    !top && ["cut", "Cut", "⌘X"],
    !top && ["copy", "Copy", "⌘C"],
    ["paste", clip?.paths?.length > 1 ? `Paste ${clip.paths.length} items` : "Paste", "⌘V", !canPaste],
    "-",
    mac && ["copyPath", "Copy path"],
    mac && !ctx.on && ["reveal", "Reveal in Finder"],
    !top && "-",
    !top && ["delete", canTrash(ctx) ? "Move to Trash" : "Delete…", "⌘⌫", false, true],
  ].filter(Boolean).filter((it, i, all) => it !== "-" || (i > 0 && all[i - 1] !== "-" && i < all.length - 1));
}

// ---- Menu and dialogs (overlay copies) --------------------------------------

class Menu {
  constructor(cx) { this.handle = cx.focus_handle(); this.handle.focus(); this.at = -1; }
  render(cx) {
    const t = theme(), p = props(), items = menuItems(p.ctx);
    const choose = (it) => { closeOverlay(p.overlay); act(it[0], p.ctx); };
    const runnable = items.map((it, i) => (it !== "-" && !it[3] ? i : -1)).filter(i => i >= 0);
    return v_flex().id("fp-menu").track_focus(this.handle).size_full().p(5).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .on_key_down((e, cx) => {
        const k = e.key, at = runnable.indexOf(this.at), n = runnable.length;
        if ((k === "down" || k === "up") && n) this.at = runnable[at < 0 ? (k === "down" ? 0 : n - 1) : (at + (k === "down" ? 1 : n - 1)) % n];
        else if (k === "enter" && this.at >= 0) choose(items[this.at]);
        else if (k === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .children(items.map((it, i) => it === "-"
        ? div().h(1).my(4).mx(6).flex_none().bg(t.border)
        : h_flex().id(`fp-mi-${it[0]}`).h(26).flex_none().px(9).gap(8).items_center().rounded(6)
          .bg(this.at === i ? t.hover : t.popover)
          .text_color(it[3] ? t.dim : it[4] ? t.ansi1 : t.foreground)
          .when(!it[3], el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(() => choose(it)))
          .child(div().flex_1().truncate().child(it[1]))
          .when(Boolean(it[2]), el => el.child(div().text_size(11).text_color(t.dim).child(it[2])))));
  }
}

class NameDialog {
  constructor(cx) {
    const p = props();
    this.text = p.value ?? "";
    this.input = InputState.new({ value: this.text });
    const dot = this.text.lastIndexOf(".");
    if (this.text) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }
  submit(cx) {
    const p = props(), ctx = p.ctx, name = this.text.trim();
    if (this.busy) return;
    this.error = ops.checkName(name);
    if (this.error) return cx.notify();
    if (p.dialog === "rename" && name === ops.base(abs(ctx))) return closeOverlay(p.overlay);
    this.busy = true; cx.notify();
    const target = p.dialog === "rename" ? `${ops.parent(abs(ctx))}/${name}` : `${abs(ctx)}/${name}`;
    cx.spawn(async cx => {
      try {
        if (p.dialog === "rename") await ops.rename(abs(ctx), name, ctx.on);
        else await ops.create(target, p.dialog === "newFolder", ctx.on);
        closeOverlay(p.overlay); ops.changed(); reveal(ctx, target);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme(), p = props();
    const title = { rename: "Rename", newFile: "New file", newFolder: "New folder" }[p.dialog];
    const where = p.dialog === "rename" ? ops.parent(abs(p.ctx)) : abs(p.ctx);
    return v_flex().id("fp-name").w_full().p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(4).text_size(11.5).text_color(t.dim).truncate().child(`in ${where}`))
      .child(Input.new(this.input).mt(14).h(36).px(10).rounded(9).border_1().border_color(this.error ? t.ansi1 : t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(Boolean(this.error), el => el.child(div().pt(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(button("fp-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fp-save", this.busy ? "Saving…" : p.dialog === "rename" ? "Rename" : "Create", true, (_e, cx) => this.submit(cx))));
  }
}

class DeleteDialog {
  constructor(cx) { this.handle = cx.focus_handle(); this.handle.focus(); }
  yes(cx) {
    const p = props(), ctx = p.ctx;
    if (this.busy) return;
    this.busy = true; cx.notify();
    cx.spawn(async cx => {
      try {
        await ops.remove(abs(ctx), canTrash(ctx), ctx.on);
        const clip = shared("files-plus.clipboard");
        if (clip?.paths?.includes(abs(ctx))) setShared("files-plus.clipboard", null);
        closeOverlay(p.overlay); ops.changed();
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme(), p = props(), trash = canTrash(p.ctx), name = ops.base(abs(p.ctx));
    return v_flex().id("fp-delete").track_focus(this.handle).size_full().p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes(cx);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(trash ? `Move “${name}” to Trash?` : `Delete “${name}”?`))
      .child(div().flex_1().text_color(this.error ? t.ansi1 : t.muted).child(this.error ?? (trash
        ? "You can put it back from the Trash."
        : `This deletes it permanently${p.ctx.dir ? ", with everything inside" : ""}. It can't be undone.`)))
      .child(h_flex().justify_end().gap(8)
        .child(button("fp-no", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fp-yes", this.busy ? "Deleting…" : trash ? "Move to Trash" : "Delete", true, (_e, cx) => this.yes(cx), true)));
  }
}

// The whole file in an editor, in its own tab. ⌘S saves (this computer only:
// writeTextFile can't reach other machines, so files there are read-only).
// A save refuses to overwrite changes made on disk since the file was read.
// The find box (⌘F): while it has text, the editor gives way to a read-only view of
// the file with every match marked (the editor can't mark text) and the current one
// highlighted; Enter / ⌘G next, ⇧Enter / ⇧⌘G previous. Esc, or a click on a line,
// goes back to the editor with that match selected.
const SYNTAX = (t) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 });
const MAX_FIND = 10000, ROW = 20;
// A theme color at some opacity ("#rrggbb" + alpha), or the fallback for other forms.
const tint = (hex, alpha, fallback) => /^#[0-9a-f]{6}$/i.test(hex ?? "") ? hex + alpha : fallback;
const lineRange = (text, line) => {
  let start = 0;
  for (let i = 1; i < line && start >= 0; i++) start = text.indexOf("\n", start) + 1 || -1;
  if (start < 0) return null;
  const end = text.indexOf("\n", start);
  return { start, end: end < 0 ? text.length : end };
};

class FileTab {
  constructor(cx) {
    const p = props();
    this.path = p.file; this.on = p.on ?? null; this.key = tabKey(this.path, this.on);
    this.name = ops.base(this.path);
    this.readonly = Boolean(this.on);
    this.gotoN = shared("files-plus.goto")?.n;
    this.matches = []; this.at = -1; this.lines = [];
    this.scroll = VirtualListScrollHandle.new();
    this.find = InputState.new({ placeholder: "Find in file…" });
    this.find.on("change", (_e, cx) => this.runFind(cx, true));
    this.find.on("submit", (e, cx) => this.step(e?.shift ? -1 : 1, cx));
    this.find.on("focus", (_e, cx) => { this.findFocused = true; cx.notify(); });
    this.find.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    this.load(cx, p.line);
    if (!this.on) this.watch(cx);
  }

  // Every match of the find box's text. `jump`: select the first one at or after the cursor.
  // Also splits the text into lines and notes each match's line, for the find view.
  runFind(cx, jump) {
    const q = this.find.value().toLowerCase();
    this.matches = []; this.more = false; this.matchLine = []; this.hits = new Map();
    if (q && this.code) {
      const original = this.code.value(), text = original.toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        if (this.matches.length >= MAX_FIND) { this.more = true; break; }
        this.matches.push(i);
      }
      this.lines = original.split("\n");
      let line = 0, start = 0;
      this.matches.forEach((m, i) => {
        while (line < this.lines.length - 1 && m >= start + this.lines[line].length + 1) start += this.lines[line++].length + 1;
        this.matchLine.push(line);
        if (!this.hits.has(line)) this.hits.set(line, []);
        this.hits.get(line).push({ col: m - start, i });
      });
    } else this.lines = [];
    if (!this.matches.length) this.at = -1;
    else if (jump) {
      const from = this.code.selected_range().start, i = this.matches.findIndex(m => m >= from);
      this.select(i < 0 ? 0 : i);
    } else this.at = Math.min(Math.max(this.at, 0), this.matches.length - 1);
    cx.notify();
  }

  select(i) {
    this.at = i;
    const start = this.matches[i];
    this.code.set_selected_range({ start, end: start + this.find.value().length });
    this.scroll.scroll_to_item(this.matchLine[i], "center");
  }

  // Leaves the find view for the editor, with the current match selected.
  closeFind(cx) {
    this.find.set_value(""); this.matches = []; this.lines = []; this.hits = new Map(); this.at = -1;
    this.code?.focus(); cx.notify();
  }

  // A click on a line in the find view: its first match, else the line's start.
  pickLine(line, cx) {
    const hit = this.hits.get(line)?.[0];
    if (hit) this.select(hit.i);
    else {
      let start = 0;
      for (let l = 0; l < line; l++) start += this.lines[l].length + 1;
      this.code.set_selected_range({ start, end: start });
    }
    this.closeFind(cx);
  }

  findView(t) {
    const font = settings().font_family, q = this.find.value().length, mark = tint(t.ansi3, "55", t.selected);
    const row = (n) => {
      const text = this.lines[n] ?? "", spans = [];
      let at = 0;
      const plain = (to) => { if (to > at) spans.push(div().flex_none().child(text.slice(at, to).replace(/\t/g, "    "))); };
      for (const h of this.hits.get(n) ?? []) {
        if (h.col > 2000) break;
        plain(h.col);
        const current = h.i === this.at;
        spans.push(div().flex_none().rounded(2).bg(current ? t.ansi3 : mark).text_color(current ? t.background : t.foreground)
          .child(text.slice(h.col, h.col + q).replace(/\t/g, "    ")));
        at = h.col + q;
      }
      plain(Math.min(text.length, Math.max(at, 2000)));
      return h_flex().h(ROW).items_center().whitespace_nowrap().cursor_pointer().hover(s => s.bg(t.hover))
        .bg(this.matchLine[this.at] === n ? t.hover : t.background)
        .child(div().w(52).flex_none().pr(12).text_right().text_color(this.hits.has(n) ? t.muted : t.dim).child(String(n + 1)))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().children(spans));
    };
    return v_flex().relative().flex_1().min_h(0).font_family(font).text_size(13).text_color(t.foreground)
      .child(v_virtual_list("fp-lines", this.lines.length, ROW, (i) => String(i),
        (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(row(i)); return out; })
        .track_scroll(this.scroll).on_item_click((key, cx) => this.pickLine(Number(key), cx)).size_full())
      .child(Scrollbar.vertical("fp-lines").absolute().inset_0());
  }

  step(by, cx) {
    const n = this.matches.length;
    if (!n) return;
    this.select(((this.at < 0 ? (by > 0 ? -1 : 0) : this.at) + by + n) % n);
    cx.notify();
  }

  openFind(cx) {
    const sel = this.code?.selected_range(), picked = sel && sel.end > sel.start && sel.end - sel.start < 200
      ? this.code.value().slice(sel.start, sel.end) : null;
    if (picked && !picked.includes("\n")) this.find.set_value(picked);
    const v = this.find.value();
    this.find.set_selected_range({ start: 0, end: v.length });
    this.find.focus();
    this.runFind(cx, false);
  }

  // Which tab shows this copy: props() doesn't say, so it's the file tab no other file
  // has claimed (files open one at a time, and the map is kept across restarts).
  register() {
    const tabs = shared("files-plus.tabs") ?? {}, live = fileTabs();
    if (live.has(tabs[this.key])) { this.tab = tabs[this.key]; return; }
    const claimed = new Set(Object.entries(tabs).filter(([k, id]) => k !== this.key && live.has(id)).map(([, id]) => id));
    const free = [...live].filter(id => !claimed.has(id)), f = focused()?.tab;
    this.tab = free.length === 1 ? free[0] : free.includes(f) ? f : null;
    if (!this.tab) return;
    const keep = Object.fromEntries(Object.entries(tabs).filter(([, id]) => live.has(id)));
    setShared("files-plus.tabs", { ...keep, [this.key]: this.tab });
  }

  load(cx, line) {
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.path, { on: this.on });
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const ext = this.name.includes(".") ? this.name.split(".").pop().toLowerCase() : "txt";
        this.disk = text;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: this.readonly, value: text,
          font_family: settings().font_family, font_size: 13, syntax: SYNTAX(theme()) });
        this.code.on("change", (_e, cx) => { this.setDirty(this.code.value() !== this.disk, cx); if (this.find.value()) this.runFind(cx, false); });
        if (line > 0) this.goto(line);
        this.code.focus();
      } catch { this.error = "Cannot open this file (binary, over 1 MB, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  goto(line) {
    const r = this.code && lineRange(this.code.value(), line);
    if (r) { this.code.set_selected_range(r); this.code.focus(); }
  }

  setDirty(dirty, cx) {
    if (this.dirty === dirty) return;
    this.dirty = dirty; this.conflict = false;
    if (this.tab) run("tab.rename", { id: this.tab, name: dirty ? `● ${this.name}` : this.name });
    cx.notify();
  }

  // Reloads changes made on disk while there are no unsaved edits here.
  watch(cx) {
    cx.spawn(async cx => {
      try {
        for (;;) {
          await watchFolder(ops.parent(this.path));
          if (this.closed) return;
          if (!this.code || this.dirty || this.saving) continue;
          const text = await readTextFile(this.path).catch(() => undefined);
          if (text == null || text === this.disk || text.includes("\0")) continue;
          const at = this.code.selected_range();
          this.disk = text; this.code.set_value(text);
          this.code.set_selected_range({ start: Math.min(at.start, text.length), end: Math.min(at.end, text.length) });
          if (this.find.value()) this.runFind(cx, false);
          cx.notify();
        }
      } catch { /* the folder went away: stop watching */ }
    });
  }

  save(cx, force = false) {
    if (!this.code || this.readonly || this.saving) return;
    const text = this.code.value();
    this.saving = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const expected = force ? await readTextFile(this.path) : this.disk;
        await writeTextFile(this.path, text, expected);
        this.disk = text; this.conflict = false;
        this.setDirty(this.code.value() !== text, cx);
        ops.changed();
      } catch (e) {
        const now = await readTextFile(this.path).catch(() => null);
        if (now !== this.disk) this.conflict = true;
        else fail(e);
      } finally { this.saving = false; cx.notify(); }
    });
  }

  reload(cx) {
    this.code?.release(); this.code = null; this.dirty = false; this.conflict = false; this.error = null;
    if (this.tab) run("tab.rename", { id: this.tab, name: this.name });
    this.matches = []; this.at = -1;
    this.load(cx);
    cx.notify();
  }

  async close() {
    this.closed = true;
    this.find.release(); this.scroll.release();
    const tabs = shared("files-plus.tabs") ?? {};
    if (tabs[this.key] && tabs[this.key] === this.tab) { const { [this.key]: _, ...rest } = tabs; setShared("files-plus.tabs", rest); }
  }

  findBar(t) {
    const q = this.find.value(), n = this.matches.length;
    const count = !q ? "" : n ? `${this.at + 1}/${n}${this.more ? "+" : ""}` : "No results";
    const arrow = (id, text, by) => div().id(id).w(18).flex_none().text_center().rounded(4)
      .text_color(n ? t.muted : t.dim).when(n > 0, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => this.step(by, cx)).child(text);
    return h_flex().flex_none().gap(4).items_center().pl(6)
      .child(Input.new(this.find).w(200).h(22).px(7).rounded(6).border_1()
        .border_color(this.findFocused ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground))
      .child(div().w(62).flex_none().text_right().text_size(11).text_color(q && !n ? t.ansi1 : t.dim).child(count))
      .child(arrow("fp-find-prev", "↑", -1))
      .child(arrow("fp-find-next", "↓", 1));
  }

  render(cx) {
    this.register();
    const g = shared("files-plus.goto");
    if (g && g.n !== this.gotoN) { this.gotoN = g.n; if (g.key === this.key) this.goto(g.line); }
    const t = theme();
    const status = this.saving ? "Saving…" : this.readonly ? `Read-only on ${this.on}` : this.dirty ? "Modified · ⌘S to save" : "Saved";
    const link = (id, text, action) => div().id(id).flex_none().cursor_pointer().text_color(t.accent).hover(s => s.opacity(0.8)).on_click(action).child(text);
    return v_flex().id("fp-tab").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {}, cmd = m.platform || m.control;
        if (cmd && e.key === "s") this.save(cx);
        else if (cmd && e.key === "f" && this.code) this.openFind(cx);
        else if (cmd && e.key === "g") this.step(m.shift ? -1 : 1, cx);
        else if (e.key === "escape" && (this.findFocused || this.find.value())) this.closeFind(cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(iconFor(this.name, false, false))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.on ? `${this.on}:${this.path}` : this.path))
        .when(Boolean(this.conflict), el => el
          .child(div().flex_none().text_color(t.ansi1).child("Changed on disk"))
          .child(link("fp-reload", "Reload", (_e, cx) => this.reload(cx)))
          .child(link("fp-overwrite", "Overwrite", (_e, cx) => this.save(cx, true))))
        .when(!this.conflict, el => el.child(div().flex_none().text_color(this.dirty ? t.blocked : t.dim).child(status)))
        .when(Boolean(this.code), el => el.child(this.findBar(t))))
      .child(this.code && this.find.value() ? this.findView(t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(14).text_color(t.dim).child(this.error || "Loading file…"));
  }
}

function button(id, text, primary, action, danger = false) {
  const t = theme(), bg = danger ? t.ansi1 : primary ? t.solid : t.raised;
  return h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary ? bg : t.input).bg(bg)
    .text_color(danger ? t.background : primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
    .hover(s => s.opacity(0.88)).on_click(action).child(text);
}

// ---- The panel --------------------------------------------------------------

export default class Files extends View {
  init(_props, cx) {
    const p = props();
    if (p?.file) { this.part = new FileTab(cx); return; }
    if (p?.menu) { this.part = new Menu(cx); return; }
    if (p?.dialog === "delete") { this.part = new DeleteDialog(cx); return; }
    if (p?.dialog) { this.part = new NameDialog(cx); return; }
    this.handle = cx.focus_handle();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.visible = []; this.overN = 0;
    this.rev = shared("files-plus.rev"); this.revealN = shared("files-plus.reveal")?.n;
    // Search: mode "name" filters by file name, "text" searches inside files.
    this.mode = "name"; this.query = ""; this.found = null; this.searchN = 0;
    this.search = InputState.new({ placeholder: "Search…" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.schedule(cx); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.schedule(cx, 0); });
    this.search.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  async close(cx) { await this.part?.close?.(cx); }

  ctx(rel, dir) {
    return { key: this.context.key, root: this.root, on: this.on ?? null, rel, dir };
  }

  selectedCtx() {
    const sel = this.visible.find(v => v.rel === this.selected);
    return sel ? this.ctx(sel.rel, sel.dir) : null;
  }

  menu(rel, dir) {
    if (!this.root) return;
    this.selected = rel || null;
    openOverlay({ mod: "files-plus", kind: "popup", width: 210, props: { menu: true, ctx: this.ctx(rel, dir) } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.again = false; this.selected = null;
      this.files = null; this.found = null; if (this.query.trim()) this.schedule(cx, 0);
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd) return;
    // A change while loading: load again when this one ends.
    if (this.loading) { this.again = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        await this.loadFolder("", context);
        for (const path of [...this.folders]) {
          if (!this.current(context)) return;
          // A folder that was renamed, moved or deleted just closes.
          try { await this.loadFolder(path, context); }
          catch { this.folders.delete(path); this.entries.delete(path); }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (this.again) { this.again = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  // open: true only opens, false only closes, undefined flips.
  toggle(path, cx, open) {
    if (this.folders.has(path)) {
      if (open === true) return;
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      if (open === false) return;
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Searches after a short pause in typing; a newer search makes older results stale.
  schedule(cx, delay = 250) {
    const n = ++this.searchN;
    if (!this.query.trim()) { this.found = null; this.searching = false; return; }
    cx.timer.after(delay, cx => { if (n === this.searchN) this.runSearch(n, cx); });
  }

  runSearch(n, cx) {
    const q = this.query.trim(), mode = this.mode, context = this.context, root = this.root, on = this.on;
    if (!q || !root) return;
    this.searching = true; cx.notify();
    cx.spawn(async cx => {
      try {
        let found;
        if (mode === "name") {
          // The file list is kept until something changes (rev) or 15 s pass.
          if (!this.files || this.files.rev !== this.rev || Date.now() - this.files.at > 15000)
            this.files = { list: await listFiles(root, on), rev: this.rev, at: Date.now() };
          found = { mode, q, ...matchNames(this.files.list, q) };
        } else found = { mode, q, ...(await grepFiles(root, on, q)) };
        if (n !== this.searchN || !this.current(context)) return;
        this.found = found; this.searchError = null;
      } catch (e) { if (n === this.searchN) this.searchError = String(e?.message ?? e); }
      finally { if (n === this.searchN) this.searching = false; cx.notify(); }
    });
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode; this.found = null; this.schedule(cx, 0); this.search.focus();
  }

  clearSearch(cx) {
    this.search.set_value(""); this.query = ""; this.found = null; this.searchN++; this.searching = false;
    this.handle.focus(); cx.notify();
  }

  show(path, cx, line) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        // From a text search: select the matched line (offsets are UTF-16, like JS strings).
        if (line > 0) {
          let start = 0;
          for (let i = 1; i < line && start >= 0; i++) start = text.indexOf("\n", start) + 1 || -1;
          if (start >= 0 && start < 400000) {
            const end = text.indexOf("\n", start);
            this.code.set_selected_range({ start, end: end < 0 ? text.length : end });
          }
        }
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Requests from the menu and dialogs: reload after a change, show a path.
  sync(cx) {
    const rev = shared("files-plus.rev");
    if (rev !== this.rev) { this.rev = rev; if (this.context) { this.refresh(cx); if (this.query.trim()) this.schedule(cx, 0); } }
    const r = shared("files-plus.reveal");
    if (r && r.n !== this.revealN) {
      this.revealN = r.n;
      if (r.key !== this.context?.key) return;
      const parts = r.rel.split("/");
      for (let i = 1; i < parts.length; i++) this.toggle(parts.slice(0, i).join("/"), cx, true);
      this.selected = r.rel || null;
      if (r.preview) this.show(r.rel, cx);
    }
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {}, cmd = m.platform || m.control;
    if (this.drag && k === "escape") { this.endDrag(cx); cx.stop_propagation(); return; }
    if (cmd && k === "f") { this.show(null); if (m.shift) this.setMode("text", cx); else this.setMode("name", cx); this.search.focus(); cx.stop_propagation(); cx.notify(); return; }
    if (this.file) { if (k === "escape") { this.show(null); cx.notify(); cx.stop_propagation(); } return; }
    // Typing in the search box: only Esc (clear) and ↓ (into the results) are ours.
    if (this.searchFocused) {
      if (k === "escape") this.clearSearch(cx);
      else if (k === "down" && this.visible.length) { this.handle.focus(); this.selected = this.visible[0].rel; }
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    if (k === "escape" && this.query) { this.clearSearch(cx); cx.stop_propagation(); return; }
    if (k === "enter" && this.found?.mode === "text") {
      const sel = this.visible.find(v => v.rel === this.selected);
      if (sel) { openFile(`${this.root}/${sel.rel}`, this.on, sel.line); cx.stop_propagation(); cx.notify(); }
      return;
    }
    const list = this.visible, i = list.findIndex(v => v.rel === this.selected), sel = list[i];
    const ctx = this.selectedCtx(), here = ctx ?? (this.root ? this.ctx("", true) : null);
    if (k === "down" || k === "up") this.selected = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (k === "down" ? 1 : -1)))]?.rel ?? null;
    else if ((k === "right" || k === "left") && sel?.dir && this.folders.has(sel.rel) === (k === "left")) this.toggle(sel.rel, cx, k === "right");
    else if (k === "left" && sel?.rel.includes("/")) this.selected = sel.rel.slice(0, sel.rel.lastIndexOf("/"));
    else if (k === "space" && sel && !sel.dir) this.show(sel.rel, cx);
    else if (k === "enter" && ctx) act("rename", ctx);
    else if (cmd && k === "c" && ctx) act("copy", ctx);
    else if (cmd && k === "x" && ctx) act("cut", ctx);
    else if (cmd && k === "v" && here) act("paste", here);
    else if (cmd && k === "d" && ctx) act("duplicate", ctx);
    else if ((k === "delete" || (cmd && k === "backspace")) && ctx) act("delete", ctx);
    else if (k === "escape") this.selected = null;
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // ---- Drag and drop ----------------------------------------------------------
  // Press a row, move 5 px, release over a folder (or a file: its folder; or the
  // space below the list: the root). ⌥ copies instead of moving. Built from mouse
  // events: native drags (drag_paths) only reach terminals. Files dropped from
  // Finder are copied in.

  dragTarget(rel, dir) {
    return dir ? rel : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  }

  canDrop(target, copy) {
    const d = this.drag;
    if (!d || target == null) return false;
    if (d.dir && (target === d.rel || target.startsWith(d.rel + "/"))) return false;
    return copy || target !== this.dragTarget(d.rel, false);
  }

  over(target, cx) {
    if (!this.drag || this.dropTarget === target) return;
    this.dropTarget = target; cx.notify();
    // Hovering a closed folder opens it after a moment.
    const n = ++this.overN;
    if (target && !this.folders.has(target) && this.canDrop(target, true))
      cx.timer.after(700, cx => { if (n === this.overN && this.drag && this.dropTarget === target) this.toggle(target, cx, true); });
  }

  endDrag(cx) {
    if (this.drag) this.dropAt = Date.now();
    this.press = null; this.drag = null; this.dropTarget = null; this.dragPos = null; this.overN++;
    cx.notify();
  }

  drop(copy, cx) {
    const d = this.drag, target = this.dropTarget, ok = this.canDrop(target, copy);
    this.endDrag(cx);
    if (!d || !ok) return;
    const ctx = this.ctx(d.rel, d.dir), dir = target ? `${this.root}/${target}` : this.root;
    cx.spawn(async () => {
      try {
        await (copy ? ops.copy : ops.move)(abs(ctx), dir, ctx.on);
        ops.changed();
        reveal(ctx, copy ? dir : `${dir}/${d.name}`);
      } catch (e) { ops.changed(); fail(e); }
    });
  }

  dropFiles(paths, target, cx) {
    if (!paths?.length || !this.root) return;
    if (this.on) return fail("Dropping files from this computer onto another machine isn't supported");
    const dir = target ? `${this.root}/${target}` : this.root;
    cx.spawn(async () => {
      try { for (const p of paths) if (ops.parent(p) !== dir) await ops.copy(p, dir, null); ops.changed(); }
      catch (e) { ops.changed(); fail(e); }
    });
  }

  rows(prefix, depth, out, t, cut) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const selected = this.selected === path;
      const dragged = this.drag?.rel === path, isTarget = entry.dir && this.dropTarget === path && this.canDrop(path, this.dragCopy);
      this.visible.push({ rel: path, dir: entry.dir });
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .bg(selected ? t.selected : t.background).hover(s => s.bg(selected ? t.selected : t.hover))
        .when(Boolean(cut?.has(`${this.root}/${path}`)) || dragged, el => el.opacity(0.5))
        .when(isTarget, el => el.bg(t.selected).border_1().border_color(t.accent))
        .on_mouse_down("left", e => { this.press = { rel: path, dir: entry.dir, name: entry.name, x: e.position.x, y: e.position.y }; })
        .on_mouse_move((_e, cx) => this.over(this.dragTarget(path, entry.dir), cx))
        .on_mouse_up("left", (e, cx) => { if (this.drag) this.drop(e.modifiers?.alt, cx); })
        .on_drop((e, cx) => this.dropFiles(e.paths, this.dragTarget(path, entry.dir), cx))
        .on_click((e, cx) => {
          if (Date.now() - (this.dropAt ?? 0) < 400) return;
          this.handle.focus(); this.selected = path;
          if (entry.dir) this.toggle(path, cx);
          else if (e.click_count < 2) openFile(`${this.root}/${path}`, this.on);
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.menu(path, entry.dir); cx.notify(); })
        .child(entry.dir ? svg(ICON(`chevron-${open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(iconFor(entry.name, entry.dir, open))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, cut);
    }
    return out;
  }

  // Search results, flat: name hits as rows, text hits grouped under their file.
  results(t, cut) {
    const f = this.found, q = this.query.trim(), out = [];
    if (!f || f.q !== q || f.mode !== this.mode) return out;
    const row = (id, rel, dir, extra) => {
      const selected = this.selected === rel, name = rel.slice(rel.lastIndexOf("/") + 1), folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      return h_flex().id(id).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .bg(selected ? t.selected : t.background).hover(s => s.bg(selected ? t.selected : t.hover))
        .when(Boolean(cut?.has(`${this.root}/${rel}`)), el => el.opacity(0.5))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.menu(rel, dir); cx.notify(); })
        .child(iconFor(name, dir, false))
        .child(div().flex_none().max_w(200).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder))
        .when(extra != null, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(extra))));
    };
    if (f.mode === "name") {
      for (const h of f.hits) {
        this.visible.push({ rel: h.rel, dir: h.dir });
        out.push(row(`fp-n-${h.rel}`, h.rel, h.dir).on_click((e, cx) => {
          this.handle.focus(); this.selected = h.rel;
          if (h.dir) { const ctx = this.ctx(h.rel, true); this.clearSearch(cx); reveal(ctx, abs(ctx)); }
          else openFile(`${this.root}/${h.rel}`, this.on);
          cx.notify();
        }));
      }
    } else {
      for (const file of f.files) {
        this.visible.push({ rel: file.rel, dir: false, line: file.hits[0].line });
        out.push(row(`fp-t-${file.rel}`, file.rel, false, file.hits.length)
          .on_click((_e, cx) => { this.handle.focus(); this.selected = file.rel; openFile(`${this.root}/${file.rel}`, this.on, file.hits[0].line); cx.notify(); }));
        for (const hit of file.hits) out.push(h_flex().id(`fp-t-${file.rel}:${hit.line}`).h(24).flex_none().pl(29).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
          .text_size(12).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.handle.focus(); this.selected = file.rel; openFile(`${this.root}/${file.rel}`, this.on, hit.line); cx.notify(); })
          .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(hit.line)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(snippet(hit.text, q))));
      }
    }
    return out;
  }

  searchSummary() {
    const f = this.found, q = this.query.trim();
    if (this.searchError) return this.searchError;
    if (!f || f.q !== q || f.mode !== this.mode) return this.searching ? "Searching…" : "";
    if (f.mode === "name") return f.hits.length ? `${f.hits.length}${f.more ? "+" : ""} match${f.hits.length === 1 ? "" : "es"}` : "No file names match";
    const n = f.files.reduce((s, x) => s + x.hits.length, 0);
    return n ? `${n}${f.more ? "+" : ""} result${n === 1 ? "" : "s"} in ${f.files.length} file${f.files.length === 1 ? "" : "s"}` : "No files contain this";
  }

  render(cx) {
    if (this.part) return this.part.render(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    this.sync(cx);
    const t = theme();
    const clip = shared("files-plus.clipboard");
    const cut = clip?.mode === "cut" && (clip.on ?? null) === (this.on ?? null) ? new Set(clip.paths) : null;
    this.visible = [];
    const searching = Boolean(this.query.trim());
    const rows = this.file ? [] : searching ? this.results(t, cut) : this.rows("", 0, [], t, cut);
    const pill = (id, mode, label) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(this.mode === mode ? t.selected : t.background).text_color(this.mode === mode ? t.foreground : t.muted)
      .hover(s => s.text_color(t.foreground)).on_click((_e, cx) => { this.setMode(mode, cx); cx.notify(); }).child(label);
    const summary = searching ? this.searchSummary() : "";
    const target = () => this.selectedCtx() ?? this.ctx("", true);
    const tool = (id, icon, action) => h_flex().id(id).h(24).px(5).gap(2).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { action(); cx.notify(); })
      .child("+").child(svg(ICON(icon)).size(13));
    const d = this.drag, rootName = this.root?.split(/[\\/]/).pop() ?? "";
    const droppable = d && this.canDrop(this.dropTarget, this.dragCopy);
    const ghost = () => h_flex().absolute().left(this.dragPos.x + 14).top(this.dragPos.y + 8).h(26).px(8).gap(6).items_center()
      .rounded(7).border_1().border_color(droppable ? t.accent : t.border).bg(t.popover).shadow_md().text_size(12)
      .child(iconFor(d.name, d.dir, false))
      .child(div().max_w(160).truncate().child(d.name))
      .child(div().text_color(droppable ? t.muted : t.dim).child(droppable
        ? `${this.dragCopy ? "copy to" : "→"} ${this.dropTarget ? this.dropTarget.split("/").pop() : rootName}`
        : "can't drop here"));
    const rootDrop = !searching && d && this.dropTarget === "" && droppable;
    return v_flex().id("files").relative().track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_move((e, cx) => {
        if (!this.press) return;
        if (!this.drag) {
          if (Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) < 5) return;
          if (this.query.trim() || this.file) { this.press = null; return; }
          this.drag = this.press;
        }
        this.dragPos = e.local_position; this.dragCopy = Boolean(e.modifiers?.alt); cx.notify();
      })
      // Released where nothing takes the drop: end it after the rows had their turn.
      .on_mouse_up("left", (_e, cx) => {
        const dragging = this.drag;
        if (!dragging) { this.press = null; return; }
        cx.timer.after(0, cx => { if (this.drag === dragging) this.endDrag(cx); });
      })
      .on_hover((hovered, cx) => { if (!hovered && (this.drag || this.press)) this.endDrag(cx); })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file && Boolean(this.root), el => el
          .child(tool("fp-new-file", "file", () => act("newFile", target())))
          .child(tool("fp-new-folder", "folder", () => act("newFolder", target())))))
      .when(!this.file && Boolean(this.root), el => el.child(v_flex().flex_none().px(8).pt(8).pb(4).gap(6)
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.search).flex_1().min_w(0).h(28).px(8).rounded(7).border_1()
            .border_color(this.searchFocused ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
          .when(searching, el => el.child(div().id("fp-clear").w(18).flex_none().cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => this.clearSearch(cx)).child("×"))))
        .child(h_flex().gap(4).items_center()
          .child(pill("fp-mode-name", "name", "File names"))
          .child(pill("fp-mode-text", "text", "Inside files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(summary)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(Boolean(rootDrop), el => el.border_1().border_color(t.accent))
        .on_click(() => this.handle.focus())
        .on_mouse_down("right", (_e, cx) => { this.menu("", true); cx.notify(); })
        .children(rows)
        // The space below the list: drops here go to the root folder.
        .when(!searching, el => el.child(div().id("fp-drop-root").flex_1().min_h(56)
          .on_mouse_move((_e, cx) => this.over("", cx))
          .on_mouse_up("left", (e, cx) => { if (this.drag) this.drop(e.modifiers?.alt, cx); })
          .on_drop((e, cx) => this.dropFiles(e.paths, "", cx))))
        .when(!searching && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(!searching && this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))
        .when(searching && this.found?.more, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.mode === "name" ? `Showing the first ${MAX_NAME_HITS} matches` : `Showing the first ${MAX_TEXT_HITS} lines`)))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(Boolean(d && this.dragPos), el => el.child(ghost()));
  }
}
