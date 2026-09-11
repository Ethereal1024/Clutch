#!/usr/bin/env bash
# Build the portable-site-packages tar for a TARGET platform.
#
# Usage: build-pylibs-tar.sh <key> <out> <os> <arch> <libc> <pyver>
set -euo pipefail

KEY="${1:?key}"
OUT="${2:?out}"
OS="${3:?os}"
ARCH="${4:?arch}"
LIBC="${5:?libc}"
PYVER="${6:?pyver}"
# node passes Windows-style paths (C:\...); under Git Bash/MSYS2 GNU tar would
# read the "C" as a tar remote hostname ("Cannot connect to C"). Normalize.
if command -v cygpath >/dev/null 2>&1; then
  OUT="$(cygpath -u "$OUT")"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# venv layout differs per host: Linux/mac use bin/, Windows venvs use Scripts/
# (the build may run on a Windows client targeting a Linux remote)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PY="$ROOT/.venv/Scripts/python.exe" ;;
  *) PY="$ROOT/.venv/bin/python" ;;
esac

# wheel platform tag for the target
case "$OS" in
  Linux)
    if [ "$LIBC" = "musl" ]; then
      TAG="musllinux_1_2_$ARCH"
    else
      TAG="manylinux2014_$ARCH"  # glibc>=2.17, i.e. all modern distros
    fi
    ;;
  Darwin)
    TAG="macosx_11_0_$ARCH"
    ;;
  *)
    echo "unsupported target: $OS/$LIBC/$ARCH" >&2
    exit 2
    ;;
esac
ABI="cp${PYVER//./}"

# pin the client venv's exact versions from uv.lock
OPENAI_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('openai'))")"
HTTPX2_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('httpx2'))")"

TMP="$(mktemp -d)"
# || true: a raced file lock (AV scanner) must not flip the script's exit code
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT
mkdir -p "$TMP/pkg"

# run pip through the venv interpreter: a bare pip3 may be missing or bound to
# a different Python than the one whose pinned versions we are mirroring
"$PY" -m pip download --only-binary=:all: \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  -d "$TMP/wheels" "openai==$OPENAI_VER" "httpx2==$HTTPX2_VER"

"$PY" -m pip install --target "$TMP/pkg/site-packages" \
  --no-index --find-links "$TMP/wheels" --only-binary=:all: \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  "openai==$OPENAI_VER" "httpx2==$HTTPX2_VER"

cp -r "$ROOT/agent" "$TMP/pkg/agent"
mkdir -p "$(dirname "$OUT")"
# Deterministic bytes for a given input set: fixed mtimes + gzip -n (drops the
# timestamp header). The tar's content hash is the remote install gate, so
# stable bytes let reconnects hit the ~/.clutch/bundles cache instead of
# re-uploading the whole stack every session.
find "$TMP/pkg" -exec touch -t 197001010000 {} +
tar -C "$TMP/pkg" -cf - agent site-packages | gzip -n > "$OUT"
echo "pylibs tar written: $OUT ($TAG, py$PYVER)"
