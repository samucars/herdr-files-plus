#!/bin/sh
# Undoes links/install.sh: the old default apps, Codex's file_opener, and the app itself.
set -eu
app="${HERDR_LINKS_APP:-$HOME/Applications/Herdr Links.app}"
state="$HOME/.config/herdr-app/data/herdr-links"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -f "$state/defaults-before.json" ] && "$app/Contents/MacOS/HerdrLinks" --restore "$state/defaults-before.json"

codex="$HOME/.codex/config.toml"
if [ -f "$codex" ] && grep -q '^file_opener *= *"vscode-insiders"' "$codex"; then
  old=$(cat "$state/codex-file_opener" 2>/dev/null || true)
  { [ -n "$old" ] && echo "$old"; grep -v '^file_opener *= *"vscode-insiders"' "$codex"; } > "$codex.tmp"
  mv "$codex.tmp" "$codex"
  echo "Codex: file_opener restored"
fi

"$lsregister" -u "$app" 2>/dev/null || true
rm -rf "$app" "$state"
echo "Removed $app"
