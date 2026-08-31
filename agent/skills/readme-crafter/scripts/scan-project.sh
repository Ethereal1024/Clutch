#!/bin/bash
# Thin compatibility wrapper. Keep the public entry point stable while moving
# the real logic into a maintainable Python scanner.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
    exec python3 "$SCRIPT_DIR/scan-project.py" "$@"
fi

PROJECT_ROOT="${1:-.}"

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "Error: '$PROJECT_ROOT' is not a directory" >&2
    exit 1
fi

cd "$PROJECT_ROOT"

echo "╔══════════════════════════════════════════╗"
echo "║   README Crafter — Project Scan Report   ║"
echo "╚══════════════════════════════════════════╝"
echo
echo "  Path: $(pwd)"
echo "  Inventory: limited shell fallback"
echo
echo "── FALLBACK MODE ──"
echo
echo "  python3 was not found, so the advanced scanner could not run."
echo "  This fallback only reports high-level signals."
echo
echo "── HIGH-LEVEL SIGNALS ──"
echo
[ -f "README.md" ] && echo "  [EXISTS] README.md"
[ -f "package.json" ] && echo "  [EXISTS] package.json"
[ -f ".env.example" ] && echo "  [EXISTS] .env.example"
[ -f "LICENSE" ] || [ -f "LICENSE.md" ] || [ -f "LICENSE.txt" ] && echo "  [EXISTS] License file"
[ -f "src/index.ts" ] || [ -f "src/index.js" ] && echo "  [SIGNAL] Library entry candidate"
[ -f "src/main.tsx" ] || [ -f "src/main.ts" ] || [ -f "index.html" ] && echo "  [SIGNAL] App/playground entry candidate"
[ -f "vite.config.ts" ] || [ -f "vite.config.js" ] && echo "  [SIGNAL] Vite app config"
[ -f "vite.config.lib.ts" ] || [ -f "vite.config.lib.js" ] && echo "  [SIGNAL] Library build config"

echo
echo "  Install python3 to enable:"
echo "  - public export surface scanning"
echo "  - README import validation"
echo "  - env var parity checks"
echo "  - local asset and link integrity checks"
echo "  - license and metadata consistency checks"
echo
echo "╔══════════════════════════════════════════╗"
echo "║            Scan complete                 ║"
echo "╚══════════════════════════════════════════╝"
