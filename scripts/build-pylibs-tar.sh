#!/usr/bin/env bash
# Bundle the agent source + the client venv's site-packages so the remote can run
# the server with its own python3 (same minor + arch) and no internet:
#   cd ~/.clutch-server && PYTHONPATH=site-packages python3 -m agent.server
#
# Usage: build-pylibs-tar.sh <version> <out-path>
set -euo pipefail

VERSION="${1:?version required}"
OUT="${2:?output path required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PYV="$("$ROOT/.venv/bin/python" -c "import sys;print('%d.%d'%sys.version_info[:2])")"
SP="$ROOT/.venv/lib/python$PYV/site-packages"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pylibs/site-packages"

cp -r "$ROOT/agent" "$TMP/pylibs/agent"

# copy the venv site-packages, skipping the agent package itself
for f in "$SP"/*; do
  b="$(basename "$f")"
  case "$b" in
    agent|agent-*) continue ;;
  esac
  cp -r "$f" "$TMP/pylibs/site-packages/"
done

mkdir -p "$(dirname "$OUT")"
tar -C "$TMP/pylibs" -czf "$OUT" agent site-packages
echo "pylibs tar written: $OUT"
