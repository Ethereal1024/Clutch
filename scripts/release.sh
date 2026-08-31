#!/usr/bin/env bash
# Build the Clutch desktop release: bundled server binary + deb.
#
# Usage: bash scripts/release.sh [version]
#   version defaults to the VERSION file; the deb is written to
#   ui/dist/clutch-ui_<version>_amd64.deb.
#
# Env overrides: ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR (default
# npmmirror; set to GitHub upstreams or a local mirror), USE_SYSTEM_FPM=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(cat VERSION)}"
echo "==> releasing Clutch ${VERSION} (deb)"

# 1. app icon (pure stdlib)
echo "==> generating icon"
"$ROOT/.venv/bin/python" scripts/make-icon.py

# 2. bundled server binary (PyInstaller onefile)
echo "==> building bundled server (PyInstaller onefile)"
bash scripts/build-server-bundle.sh "$VERSION" "$ROOT/dist/agent-server"

# 3. exec-chunk limit must not drift between agent/ and ui/
echo "==> checking transport_defaults.json drift guard"
cmp -s agent/transport_defaults.json ui/transport_defaults.json || {
  echo "FATAL: ui/transport_defaults.json drifted from agent/transport_defaults.json" >&2
  echo "       refresh the committed copy: cp agent/transport_defaults.json ui/transport_defaults.json" >&2
  exit 1
}

# 4. deb
echo "==> building deb"
cd ui
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}" \
  npx electron-builder --linux deb --publish never

echo "==> done: ui/dist/clutch-ui_${VERSION}_amd64.deb"
