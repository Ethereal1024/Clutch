#!/usr/bin/env bash
# Build the Clutch macOS release: bundled server binary + unsigned dmg.
# Run this ON a Mac (electron-builder cannot cross-build mac targets from
# Linux); for the CI equivalent see the `dmg` job in
# .github/workflows/release.yml.
#
# Usage:
#   bash scripts/release-mac.sh [version]             # build ui/dist/Clutch-<version>-<arch>.dmg
#   bash scripts/release-mac.sh [version] --install   # ...then install to /Applications
#
#   version defaults to the VERSION file. The architecture follows the Mac
#   the script runs on (arm64 for Apple Silicon, x64 for Intel) because the
#   PyInstaller backend cannot be cross-compiled.
#
# Unsigned build (mac.identity: null): Gatekeeper blocks the first launch —
# on macOS 15+ with a misleading "damaged" notice (the right-click -> Open
# bypass was removed). Clear it once:
#   xattr -cr /Applications/Clutch.app
#
# Env overrides: ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR (default
# npmmirror, same as scripts/release.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "FATAL: release-mac.sh builds the macOS app and must run on a Mac." >&2
  echo "       On Linux use scripts/release.sh (deb)." >&2
  exit 1
fi

# --- args: [version] --install ---------------------------------------------
INSTALL=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
VERSION="${POSITIONAL[0]:-$(cat VERSION)}"
ARCH="$(uname -m)" # arm64 | x86_64
EB_ARCH="arm64"
[[ "$ARCH" == "x86_64" ]] && EB_ARCH="x64"
DMG="ui/dist/Clutch-${VERSION}-${EB_ARCH}.dmg"

echo "==> releasing Clutch ${VERSION} (macOS dmg ${EB_ARCH}, unsigned)"

# --- python env: PyInstaller is required -----------------------------------
PY="$ROOT/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3)"
"$PY" -c "import PyInstaller" 2>/dev/null || {
  echo "FATAL: PyInstaller not found in the python environment ($PY)." >&2
  echo "       Set it up first:  pip install uv && uv sync" >&2
  exit 1
}

# --- 1. app icon (pure stdlib, same as the Linux pipeline) -----------------
echo "==> generating icon"
"$PY" scripts/make-icon.py

# --- 2. bundled server binary (PyInstaller onefile) ------------------------
echo "==> building bundled server (PyInstaller onefile)"
bash scripts/build-server-bundle.sh "$VERSION" "$ROOT/dist/agent-server"

# --- 3. exec-chunk limit must not drift between agent/ and ui/ -------------
bash "$ROOT/scripts/check-transport-defaults.sh"

# --- 4. dmg (unsigned) ------------------------------------------------------
[[ -d ui/node_modules ]] || {
  echo "FATAL: ui/node_modules missing — install UI deps first:  cd ui && npm install" >&2
  exit 1
}
echo "==> building dmg (arm64/x64 per this Mac, no codesign identity)"
cd ui
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}" \
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac dmg --"$EB_ARCH" --publish never
cd "$ROOT"

[[ -f "$DMG" ]] || DMG="$(ls -t "$ROOT"/ui/dist/*.dmg | head -1)"
echo "==> done: $DMG"

# --- 5. optional: install to /Applications ---------------------------------
if [[ "$INSTALL" -eq 1 ]]; then
  echo "==> installing Clutch.app to /Applications"
  hdiutil attach "$DMG" -nobrowse -quiet
  cp -R "/Volumes/Clutch/Clutch.app" /Applications/
  hdiutil detach "/Volumes/Clutch" -quiet
  # strip the quarantine flag so the unsigned app opens without the
  # Gatekeeper "cannot verify the developer" prompt
  xattr -cr /Applications/Clutch.app
  echo "==> installed. Launch Clutch from Applications (first launch may take a few seconds)."
else
  echo "==> install it with:  open $DMG   (then drag Clutch.app to Applications)"
  echo "==> first launch (unsigned): macOS may say \"damaged\" — it isn't. Run:"
  echo "    xattr -cr /Applications/Clutch.app"
  echo "    (or 系统设置 -> 隐私与安全性 -> 仍要打开)"
fi
