#!/usr/bin/env bash
# Builds "MCP Manager.app" (SwiftUI shell + bundled Node engine) into ./build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="$ROOT/build/MCP Manager.app"
CONFIG="${CONFIG:-release}"

echo "==> Bundling engine"
npm run --silent build:engine

# Without Xcode, the Command Line Tools ship newer SDKs whose SwiftUI macros (@State…) need an
# Xcode-only compiler plugin. Fall back to the newest SDK that still builds with plain CLT.
if ! xcodebuild -version >/dev/null 2>&1 && [ -z "${SDKROOT:-}" ]; then
  for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX2[0-6].*.sdk /Library/Developer/CommandLineTools/SDKs/MacOSX1[0-9].*.sdk 2>/dev/null | sort -t X -k2 -V -r); do
    export SDKROOT="$sdk"; break
  done
  [ -n "${SDKROOT:-}" ] && echo "==> No Xcode found; using SDK $SDKROOT"
fi

echo "==> Building Swift app ($CONFIG)"
swift build -c "$CONFIG" --package-path macos
BIN="$(swift build -c "$CONFIG" --package-path macos --show-bin-path)/MCPManager"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine/dist" "$APP/Contents/Resources/engine/presets"
cp "$BIN" "$APP/Contents/MacOS/MCPManager"
cp macos/Resources/Info.plist "$APP/Contents/Info.plist"
cp dist/cli.js "$APP/Contents/Resources/engine/dist/cli.js"
cp presets/catalog.json "$APP/Contents/Resources/engine/presets/catalog.json"
printf '{\n  "name": "mcp-manager-engine",\n  "type": "module",\n  "private": true\n}\n' > "$APP/Contents/Resources/engine/package.json"

echo "==> Rendering icon"
ICONSET="$ROOT/build/AppIcon.iconset"
rm -rf "$ICONSET"
swift scripts/make-icon.swift "$ICONSET" >/dev/null
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null

echo "Built: $APP"
