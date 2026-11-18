#!/bin/sh
# Builds "Herdr Links.app" and makes it the opener for file links from terminal agents:
#   - default app for text and code files (Claude Code's file:// links, and Finder)
#   - handler of vscode-insiders:// links, which Codex prints with file_opener = "vscode-insiders"
# The previous defaults are saved; links/uninstall.sh puts them back.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="${HERDR_LINKS_APP:-$HOME/Applications/Herdr Links.app}"
state="$HOME/.config/herdr-app/data/herdr-links"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
mkdir -p "$state" "$app/Contents/MacOS" "$app/Contents/Resources"

swiftc -O "$here/HerdrLinks.swift" -o "$app/Contents/MacOS/HerdrLinks"

herdr=$(mdfind "kMDItemCFBundleIdentifier == 'dev.herdr.app'" | head -1)
[ -n "$herdr" ] && cp "$herdr/Contents/Resources/Herdr.icns" "$app/Contents/Resources/HerdrLinks.icns"

utis=$("$app/Contents/MacOS/HerdrLinks" --utis | sed 's/.*/<string>&<\/string>/' | tr -d '\n')
exts=$(sed -n '/^let EXTENSIONS = \[/,/^\]/p' "$here/HerdrLinks.swift" | grep -o '"[^"]*"' | tr -d '"' \
  | sed 's/.*/<string>&<\/string>/' | tr -d '\n')
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.herdr.links</string>
  <key>CFBundleName</key><string>Herdr Links</string>
  <key>CFBundleExecutable</key><string>HerdrLinks</string>
  <key>CFBundleIconFile</key><string>HerdrLinks</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Editor file links</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>CFBundleURLSchemes</key><array><string>vscode-insiders</string></array>
  </dict></array>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Text and code</string>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array>$utis</array>
    <key>CFBundleTypeExtensions</key><array>$exts</array>
  </dict></array>
</dict></plist>
EOF
codesign --force --sign - "$app" >/dev/null 2>&1
"$lsregister" -f "$app"

"$app/Contents/MacOS/HerdrLinks" --set-defaults "$state/defaults-before.json"

# Codex: print vscode-insiders:// links (a top-level key, so before the first [table]).
codex="$HOME/.codex/config.toml"
if [ -f "$codex" ] && ! grep -q '^file_opener *= *"vscode-insiders"' "$codex"; then
  old=$(grep '^file_opener *=' "$codex" || true)
  [ -f "$state/codex-file_opener" ] || printf '%s\n' "$old" > "$state/codex-file_opener"
  cp "$codex" "$state/codex-config.toml.bak"
  { echo 'file_opener = "vscode-insiders"  # Herdr Links opens these in Herdr'; grep -v '^file_opener *=' "$codex"; } > "$codex.tmp"
  mv "$codex.tmp" "$codex"
  echo "Codex: file_opener = \"vscode-insiders\" (restart Codex sessions to pick it up)"
fi
echo "Installed $app"
