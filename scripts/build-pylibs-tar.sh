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
      # musllinux_1_1, not _1_2: the pinned Rust wheels (jiter, pydantic-core)
      # ship _1_1 only, and pip's --platform matches the tag exactly — a _1_2
      # request finds nothing. A _1_1 wheel also runs under musl 1.2, so this
      # is the strictly wider-compatible choice.
      TAG="musllinux_1_1_$ARCH"
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

# uv sync creates the venv WITHOUT pip (uv's default), so a fresh CI checkout
# dies here with "No module named pip". ensurepip is stdlib and boots pip into
# the venv; a no-op wherever pip already exists. pip is only the wheel
# downloader below — the == pins fix the tar's content, not the pip version.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  "$PY" -m ensurepip --upgrade >/dev/null
fi

# pin the client venv's exact versions from uv.lock
OPENAI_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('openai'))")"
HTTPX2_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('httpx2'))")"
# ...and the pair that has no business drifting with the build date: pydantic
# refuses to import beside a pydantic_core it was not built against
# ("SystemError: The installed pydantic-core version ... is incompatible"),
# and pinning only openai/httpx2 leaves that pair to whatever the index
# resolves on the day of the build — one pair per release, i.e. a remote that
# reinstalls the whole stack for nothing on a version bump (the tree damage of
# the older, merge-style install is in docs/android/README §"no backend").
# Pinned from the same venv as the two above, so the tar's pair is the pair
# this client itself runs. Availability is not a guess: pydantic_core publishes
# wheels for every leg of the release matrix (manylinux2014 / musllinux_1_1 ×
# x86_64 / aarch64 × cp310–cp313).
PYDANTIC_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('pydantic'))")"
PYDANTIC_CORE_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('pydantic_core'))")"
PINS=("openai==$OPENAI_VER" "httpx2==$HTTPX2_VER" "pydantic==$PYDANTIC_VER" "pydantic_core==$PYDANTIC_CORE_VER")

TMP="$(mktemp -d)"
# || true: a raced file lock (AV scanner) must not flip the script's exit code
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT
mkdir -p "$TMP/pkg"

# run pip through the venv interpreter: a bare pip3 may be missing or bound to
# a different Python than the one whose pinned versions we are mirroring
"$PY" -m pip download --only-binary=:all: \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  -d "$TMP/wheels" "${PINS[@]}"

"$PY" -m pip install --target "$TMP/pkg/site-packages" \
  --no-index --find-links "$TMP/wheels" --only-binary=:all: --no-compile \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  "${PINS[@]}"

cp -r "$ROOT/agent" "$TMP/pkg/agent"
# Ship sources only: a .pyc embeds the compiling interpreter's view of source
# mtimes (nondeterministic across builds) and is dead weight anyway — a pyc
# built by THIS venv's python (e.g. cp310) never loads under the remote's
# python3.x (e.g. 3.12), which recompiles into its own __pycache__ on first
# import. Purge also covers __pycache__ copied from the repo's agent/ tree.
find "$TMP/pkg" -name "*.pyc" -delete
find "$TMP/pkg" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$(dirname "$OUT")"
# Deterministic bytes for a given input set: fixed mtimes + gzip -n (drops the
# timestamp header). The tar's content hash is the remote install gate, so
# stable bytes let reconnects hit the ~/.clutch/bundles cache instead of
# re-uploading the whole stack every session.
find "$TMP/pkg" -exec touch -t 197001010000 {} +
tar -C "$TMP/pkg" -cf - agent site-packages | gzip -n > "$OUT"
echo "pylibs tar written: $OUT ($TAG, py$PYVER)"
