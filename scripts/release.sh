#!/usr/bin/env bash
# Build the Clutch desktop release: bundled server binary + deb.
#
# Usage: bash scripts/release.sh [version]
#   version defaults to the VERSION file. The deb is written to
#   ui/dist/clutch-ui_<version>_amd64.deb.
#
# Env overrides:
#   ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR
#       default to npmmirror (fast in CN networks); point at GitHub upstreams
#       (https://github.com/electron/electron/releases/download/ and
#        https://github.com/electron-userland/electron-builder-binaries/releases/download/)
#       or a local mirror if you prefer.
#   USE_SYSTEM_FPM=1   use a system fpm instead of the downloaded one
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(cat VERSION)}"
echo "==> releasing Clutch ${VERSION} (deb)"

# 1. app icon — pure stdlib, regenerates ui/build/icon.png + ui/build/icon.svg
echo "==> generating icon"
"$ROOT/.venv/bin/python" scripts/make-icon.py

# 2. bundled server binary (PyInstaller onefile, host-bound OS/arch/glibc)
echo "==> building bundled server (PyInstaller onefile)"
bash scripts/build-server-bundle.sh "$VERSION" "$ROOT/dist/agent-server"

# 3. the exec-chunk limit must never drift between agent/ (Python) and ui/
#    (JS) — the committed copy is the single shipped source
echo "==> checking transport_defaults.json drift guard"
cmp -s agent/transport_defaults.json ui/transport_defaults.json || {
  echo "FATAL: ui/transport_defaults.json drifted from agent/transport_defaults.json" >&2
  echo "       refresh the committed copy: cp agent/transport_defaults.json ui/transport_defaults.json" >&2
  exit 1
}

# 4. deb (npm predist re-checks the drift guard)
echo "==> building deb"
cd ui
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}" \
  npx electron-builder --linux deb --publish never

echo "==> done: ui/dist/clutch-ui_${VERSION}_amd64.deb"
