#!/usr/bin/env bash
# Dev convenience: start the backend API + the Electron UI from one command.
# The backend is cleaned up when the UI exits. Server logs go to a file so the
# background process never holds this command's output pipe open.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
LOG="/tmp/clutch-server.log"

# start the API server in the background (cwd = repo root so `agent` imports)
( cd "$ROOT" && exec "$ROOT/.venv/bin/python" -m agent.server >"$LOG" 2>&1 ) &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT INT TERM

# wait for the server so the UI's first requests don't race startup
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:8890/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

# run electron in the foreground (no exec: the trap must survive to clean up)
"$DIR/node_modules/.bin/electron" "$DIR"
