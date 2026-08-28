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
  scripts/server_entry.py

mkdir -p "$(dirname "$OUT")"
cp dist/agent-server "$OUT"
chmod +x "$OUT"
rm -rf build dist agent-server.spec
echo "bundle written: $OUT"
