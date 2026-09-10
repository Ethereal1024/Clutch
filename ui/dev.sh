#!/usr/bin/env bash
# Dev convenience: start backend API + Electron UI from one command; the
# backend is cleaned up when the UI exits. Server logs go to a file so the
# background process never holds this command's output pipe open.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
LOG="/tmp/clutch-server.log" # Git Bash maps /tmp to %TEMP%, so this works on Windows too

# the venv interpreter: a POSIX venv keeps it in bin/, a Windows venv puts
# python.exe in Scripts/ — `npm run dev` has to start on both
VENV_PY="$ROOT/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  VENV_PY="$ROOT/.venv/Scripts/python.exe"
fi

# pids LISTENING on $1. POSIX: ss -ltnp (reading the listener state, not lsof's
# process name, which would also match the Electron client). Windows/Git Bash
# has neither ss nor fuser but ships netstat.exe, whose LISTENING rows end with
# the owning pid.
listener_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -F'pid=' '/:'"$1"' /{split($2,a,","); print a[1]}' | sort -u
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | awk -v p=":$1" '$1 == "TCP" && $4 == "LISTENING" && $2 ~ p"$" {print $5}' | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1/tcp" 2>/dev/null | tr -s ' ' '\n' | sort -u
  fi
}

# a stale server on 8890 would serve old code and block our bind; kill only the
# LISTENER.
if curl -sf "http://127.0.0.1:8890/api/health" >/dev/null 2>&1; then
  echo "[clutch-ui] clearing existing clutch-server on 8890 (stale?)"
  PIDS=$(listener_pids 8890 || true)
  if [ -n "$PIDS" ]; then
    # MSYS `kill` accepts Windows pids as well; taskkill is the native fallback
    for pid in $PIDS; do
      kill "$pid" 2>/dev/null || taskkill //PID "$pid" //F >/dev/null 2>&1 || true
    done
    sleep 0.3
  else
    echo "[clutch-ui] warning: could not identify the pid on 8890; our server may fail to bind"
  fi
fi

# start the API server in the background (cwd = repo root so `agent` imports)
( cd "$ROOT" && exec "$VENV_PY" -m agent.server >"$LOG" 2>&1 ) &
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
