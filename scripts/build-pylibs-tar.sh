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
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"

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
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pkg"

pip3 download --only-binary=:all: \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  -d "$TMP/wheels" "openai==$OPENAI_VER" "httpx2==$HTTPX2_VER"

pip3 install --target "$TMP/pkg/site-packages" --no-index --find-links "$TMP/wheels" \
  "openai==$OPENAI_VER" "httpx2==$HTTPX2_VER"

cp -r "$ROOT/agent" "$TMP/pkg/agent"
mkdir -p "$(dirname "$OUT")"
tar -C "$TMP/pkg" -czf "$OUT" agent site-packages
echo "pylibs tar written: $OUT ($TAG, py$PYVER)"
