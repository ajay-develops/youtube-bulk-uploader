#!/bin/bash
# Builds "YouTube Bulk Uploader.app" (Apple Silicon) into ./dist and, with --install,
# copies it to /Applications. Uses the Electron.app already in node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/homebrew/bin:$PATH

NAME="YouTube Bulk Uploader"
APP="dist/$NAME.app"
STAGE="$(mktemp -d)"

rm -rf dist && mkdir -p dist
ditto node_modules/electron/dist/Electron.app "$APP"

# Production-only app payload (no credentials, data, logs or legacy files).
mkdir -p "$STAGE/app"
cp -R package.json src "$STAGE/app/"
(cd "$STAGE/app" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm -f "$APP/Contents/Resources/default_app.asar"
ditto "$STAGE/app" "$APP/Contents/Resources/app"
rm -rf "$STAGE"

PL="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "$NAME" "$PL"
plutil -replace CFBundleDisplayName -string "$NAME" "$PL"
plutil -replace CFBundleIdentifier -string "com.ajay.youtube-bulk-uploader" "$PL"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"

if [ "${1:-}" = "--install" ]; then
  rm -rf "/Applications/$NAME.app"
  ditto "$APP" "/Applications/$NAME.app"
  echo "Installed /Applications/$NAME.app"
fi
