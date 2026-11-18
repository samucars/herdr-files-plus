"""Builds files-plus/icons/ and icons.js from an unpacked vscode-icons VSIX.

Usage: python3 scripts/build_icons.py <unpacked-vsix>/extension mods/files-plus
"""
import json, os, shutil, sys
src, out = sys.argv[1], sys.argv[2]
vs = json.load(open(os.path.join(src, "dist/src/vsicons-icon-theme.json")))
zed = json.load(open(os.path.join(src, "dist/src/vsicons-icon-theme-zed.json")))["themes"][0]
icon_of = {}  # id -> svg basename without .svg
for k, v in vs["iconDefinitions"].items(): icon_of[k] = os.path.basename(v["iconPath"])[:-4]
for k, v in zed["file_icons"].items(): icon_of.setdefault(k, os.path.basename(v["path"])[:-4])
used = set()
def ic(i):
    n = icon_of.get(i)
    if n and os.path.exists(os.path.join(src, "icons", n + ".svg")): used.add(n); return n
names, exts, dirs = {}, {}, {}
for k, v in zed["file_stems"].items():
    n = ic(v); n and names.setdefault(k.lower(), n)
for k, v in vs["fileNames"].items():
    n = ic(v); n and names.__setitem__(k.lower(), n)
for k, v in zed["file_suffixes"].items():
    n = ic(v); n and exts.setdefault(k.lower(), n)
for k, v in vs["fileExtensions"].items():
    n = ic(v); n and exts.__setitem__(k.lower(), n)
# Zed maps some languages to framework icons; use the plain language icon like VS Code does.
for e, i in {"css": "_f_css", "scss": "_f_scss", "less": "_f_less"}.items():
    n = ic(i); n and exts.__setitem__(e, n)
for k, v in vs["folderNames"].items():
    c, o = ic(v), ic(vs["folderNamesExpanded"].get(k, v))
    if c: dirs[k.lower()] = [c, o or c]
for k, v in zed["named_directory_icons"].items():
    c, o = os.path.basename(v["collapsed"])[:-4], os.path.basename(v["expanded"])[:-4]
    if k.lower() not in dirs and os.path.exists(os.path.join(src, "icons", c + ".svg")):
        used.update([c, o]); dirs[k.lower()] = [c, o]
base = {"file": ic(vs["file"]), "folder": ic(vs["folder"]), "folderOpen": ic(vs["folderExpanded"])}
d = os.path.join(out, "icons")
shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
for n in sorted(used): shutil.copy(os.path.join(src, "icons", n + ".svg"), d)
shutil.copy(os.path.join(src, "LICENSE.txt"), os.path.join(d, "LICENSE.txt"))
with open(os.path.join(out, "icons.js"), "w") as f:
    f.write("// Generated from vscode-icons 13.0.0 (MIT, github.com/vscode-icons/vscode-icons); icons in ./icons.\n")
    f.write("// Values are SVG names in icons/ without .svg. Rebuild instead of editing.\n")
    f.write("export default " + json.dumps({**base, "names": names, "exts": exts, "dirs": dirs}, separators=(",", ":"), sort_keys=True) + ";\n")
print(len(used), "icons;", len(names), "names;", len(exts), "exts;", len(dirs), "dirs")
