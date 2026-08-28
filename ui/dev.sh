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

# The installed electron package has no postinstall (its binary is downloaded
# lazily on first run), so after a fresh `npm install`/`npm ci` the binary is
# gone again. Fetch it explicitly with a clear message instead of a silent
# lazy download mid-launch.
ELECTRON_BIN="$DIR/node_modules/electron/dist/$(cat "$DIR/node_modules/electron/path.txt" 2>/dev/null || true)"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[clutch-ui] Electron binary missing (fresh npm install?) — downloading…"
  node "$DIR/node_modules/electron/install.js"
fi

# run electron in the foreground (no exec: the trap must survive to clean up)
"$DIR/node_modules/.bin/electron" "$DIR"
