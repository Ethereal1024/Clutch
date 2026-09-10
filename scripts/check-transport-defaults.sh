#!/usr/bin/env bash
# Single drift guard for the cross-language transport defaults.
#
# agent/transport_defaults.json is read by agent/tools/workspace.py (remote exec
# wire limits) and ui/transport_defaults.json by ui/ssh-tunnel.js; the two
# committed copies must stay byte-identical. Everything that builds or packages
# calls this script instead of re-implementing the cmp:
#   scripts/release.sh, scripts/release-mac.sh, ui/package.json (predist)
#   .github/workflows/windows-debug.yml
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANON="$ROOT/agent/transport_defaults.json"
COPY="$ROOT/ui/transport_defaults.json"

if ! cmp -s "$CANON" "$COPY"; then
  echo "FATAL: ui/transport_defaults.json drifted from agent/transport_defaults.json" >&2
  echo "       refresh the committed copy: cp agent/transport_defaults.json ui/transport_defaults.json" >&2
  exit 1
fi
echo "ok: transport_defaults.json copies are in sync"
