#!/usr/bin/env bash
# Build the standalone clutch-server binaries (PyInstaller onefile) for THIS
# host's platform:
#   - agent-server       the agent API backend (session child)
#   - agent-supervisor   the per-machine supervisor (spawns session children)
#
# Usage: build-server-bundle.sh <version> <out-path>
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

"$ROOT/.venv/bin/python" -m PyInstaller --noconfirm --onefile --name agent-supervisor \
  scripts/supervisor_entry.py

mkdir -p "$(dirname "$OUT")"
# OUT = the agent-server path; when external, also deliver the supervisor under
# a sibling version-keyed name (agent-supervisor-<same-suffix>).
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  SUPERVISOR_OUT="$(dirname "$OUT")/$(basename "$OUT" | sed 's/^agent-server/agent-supervisor/')"
  cp dist/agent-server "$OUT"
  cp dist/agent-supervisor "$SUPERVISOR_OUT"
  chmod +x "$SUPERVISOR_OUT"
fi
chmod +x "$OUT"
# remove PyInstaller scratch dirs, but never $OUT (it may live inside dist/)
rm -rf build agent-server.spec agent-supervisor.spec
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  rm -rf dist
fi
echo "bundle written: $OUT (+ supervisor sibling)"
