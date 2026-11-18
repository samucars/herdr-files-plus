// File operations for files-plus. Every one runs `sh` on the space's machine
// (`on`, null = here) and reports through stdout: some remote transports drop
// stderr and exit codes, so success is the "__ok__" marker, not the code.
import { exec, shared, setShared } from "herdr";

const PRELUDE = `exec 2>&1
taken() { [ -e "$1" ] || [ -L "$1" ]; }
free() { d=$1; b=$2; case "$b" in ?*.*) s=\${b%.*}; e=.\${b##*.};; *) s=$b; e=;; esac
  t="$d/$b"; n=1
  while taken "$t"; do if [ $n -eq 1 ]; then t="$d/$s copy$e"; else t="$d/$s copy $n$e"; fi; n=$((n+1)); done
  printf %s "$t"; }
`;

const SCRIPTS = {
  // $1 source, $2 destination folder
  copy: `t=$(free "$2" "\${1##*/}") && cp -Rp "$1" "$t"`,
  // $1 source, $2 destination folder
  move: `t="$2/\${1##*/}"; if taken "$t"; then echo "\\"\${1##*/}\\" already exists there"; exit 1; fi; mv "$1" "$t"`,
  // $1 old path, $2 new path, $3 "case" when only the letter case changes
  rename: `if [ "$3" != case ] && taken "$2"; then echo "\\"\${2##*/}\\" already exists"; exit 1; fi; mv "$1" "$2"`,
  newFile: `if taken "$1"; then echo "\\"\${1##*/}\\" already exists"; exit 1; fi; : > "$1"`,
  newFolder: `if taken "$1"; then echo "\\"\${1##*/}\\" already exists"; exit 1; fi; mkdir "$1"`,
  // $1 path, $2 "trash" or "rm"
  delete: `if [ "$2" = trash ]; then command -v trash >/dev/null || { echo "No trash command on this machine"; exit 1; }; trash "$1"; else rm -rf -- "$1"; fi`,
};

async function sh(op, args, on) {
  const r = await exec("sh", ["-c", `${PRELUDE}{ ${SCRIPTS[op]}; } && printf '\\n__ok__'`, "files-plus", ...args], { on, timeout: 600000 });
  if (!r.stdout.includes("__ok__")) throw new Error((r.stdout || r.stderr || `${op} failed`).trim());
}

export const parent = (abs) => abs.slice(0, abs.lastIndexOf("/")) || "/";
export const base = (abs) => abs.slice(abs.lastIndexOf("/") + 1);
export const changed = () => setShared("files-plus.rev", ((shared("files-plus.rev") ?? 0) + 1));

export function checkName(name) {
  if (!name.trim()) return "Type a name";
  if (name.includes("/")) return "A name can't contain /";
  if (name === "." || name === "..") return "That name is reserved";
  return null;
}

export const copy = (src, dir, on) => sh("copy", [src, dir], on);
export const move = (src, dir, on) => sh("move", [src, dir], on);
export const remove = (abs, trash, on) => sh("delete", [abs, trash ? "trash" : "rm"], on);
export const create = (abs, folder, on) => sh(folder ? "newFolder" : "newFile", [abs], on);
export const rename = (abs, name, on) =>
  sh("rename", [abs, `${parent(abs)}/${name}`, base(abs).toLowerCase() === name.toLowerCase() ? "case" : ""], on);

// Pastes the shared clipboard ({mode, on, paths}) into dir. Returns how many went in.
export async function paste(dir, on) {
  const clip = shared("files-plus.clipboard");
  if (!clip?.paths?.length) return 0;
  if ((clip.on ?? null) !== (on ?? null)) throw new Error("Copying between machines isn't supported");
  let n = 0;
  for (const src of clip.paths) {
    if (clip.mode === "cut") {
      if (dir === src || dir.startsWith(src + "/")) throw new Error(`Can't move "${base(src)}" into itself`);
      if (parent(src) === dir) continue;
      await sh("move", [src, dir], on);
    } else await sh("copy", [src, dir], on);
    n++;
  }
  if (clip.mode === "cut") setShared("files-plus.clipboard", null);
  return n;
}
