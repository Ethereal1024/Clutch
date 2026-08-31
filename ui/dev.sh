#!/usr/bin/env bash
# Dev convenience: start backend API + Electron UI from one command; the
# backend is cleaned up when the UI exits. Server logs go to a file so the
# background process never holds this command's output pipe open.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
LOG="/tmp/clutch-server.log"

# a stale server on 8890 would serve old code and block our bind; kill only
# the LISTENER — lsof would also match the Electron client.
if curl -sf "http://127.0.0.1:8890/api/health" >/dev/null 2>&1; then
  echo "[clutch-ui] clearing existing clutch-server on 8890 (stale?)"
  PIDS=$(ss -ltnp 2>/dev/null | awk -F'pid=' '/:8890 /{split($2,a,","); print a[1]}' | sort -u)
  if [ -z "$PIDS" ]; then PIDS=$(fuser 8890/tcp 2>/dev/null || true); fi
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null || true
    sleep 0.3
  else
    echo "[clutch-ui] warning: could not identify the pid on 8890; our server may fail to bind"
  fi
fi

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

# The installed electron package downloads its binary lazily on first run; a
# fresh npm install leaves it missing, so fetch it explicitly.
ELECTRON_BIN="$DIR/node_modules/electron/dist/$(cat "$DIR/node_modules/electron/path.txt" 2>/dev/null || true)"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[clutch-ui] Electron binary missing (fresh npm install?) — downloading…"
  node "$DIR/node_modules/electron/install.js"
fi

# run electron in the foreground (no exec: the trap must survive to clean up)
"$DIR/node_modules/.bin/electron" "$DIR"
