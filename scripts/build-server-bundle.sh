#!/usr/bin/env bash
# Build the standalone clutch-server binary (PyInstaller onefile) for THIS host's
# platform, and copy it to the given output path.
#
# Usage: build-server-bundle.sh <version> <out-path>
#
# The artifact is self-contained (no python/pip needed on the target) but is
# bound to the build host's OS/arch/glibc family. Cross-platform remotes are
# handled by the adaptive installer (venv+pip, portable site-packages, or the
# client-side LLM assist) instead of a pre-built matrix.
set -euo pipefail

VERSION="${1:?version required}"
OUT="${2:?output path required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

"$ROOT/.venv/bin/python" -m PyInstaller --noconfirm --onefile --name agent-server \
  --add-data "agent/prompts:agent/prompts" \
  --add-data "agent/skills:agent/skills" \
  --add-data "agent/transport_defaults.json:agent/" \
  scripts/server_entry.py

mkdir -p "$(dirname "$OUT")"
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  cp dist/agent-server "$OUT"
fi
chmod +x "$OUT"
# remove PyInstaller scratch dirs, but never $OUT (it may live inside dist/)
rm -rf build agent-server.spec
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  rm -rf dist
fi
echo "bundle written: $OUT"
