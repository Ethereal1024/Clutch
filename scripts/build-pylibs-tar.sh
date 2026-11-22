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
# jiter belongs to that set for the same reason pydantic_core does: openai's
# other compiled wheel, the one that decides how the chat payload is parsed.
# Left to the index it drifts away from the client silently whenever openai's
# floor moves (0.2.0 downloaded 0.19.0 for py3.11+ while this venv ran 0.16.0
# from uv.lock, and 0.18.0 for py3.10 — three parsers in one release), and an
# unpinned wheel is also free to demand a newer python than the leg being
# built. cp310–cp313 × manylinux2014 / musllinux_1_1 × x86_64 / aarch64 are
# all published, so pinning it cannot starve a leg.
JITER_VER="$("$PY" -c "import importlib.metadata;print(importlib.metadata.version('jiter'))")"
PINS=("openai==$OPENAI_VER" "httpx2==$HTTPX2_VER" "pydantic==$PYDANTIC_VER" "pydantic_core==$PYDANTIC_CORE_VER" "jiter==$JITER_VER")

TMP="$(mktemp -d)"
# || true: a raced file lock (AV scanner) must not flip the script's exit code
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT
mkdir -p "$TMP/pkg"

# run pip through the venv interpreter: a bare pip3 may be missing or bound to
# a different Python than the one whose pinned versions we are mirroring
"$PY" -m pip download --only-binary=:all: \
  --platform "$TAG" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  -d "$TMP/wheels" "${PINS[@]}"

# A wheel IS the install: unpack the ones pip just chose for the target. The
# second `pip install --target` this used to run was not neutral — it resolves
# a second time, and it judges each candidate's Requires-Python against the
# interpreter RUNNING pip (this venv's, e.g. 3.10) instead of --python-version
# (the leg being built). That is how the 0.2.0 matrix split: the four py3.10
# legs shipped, and the twelve legs above them failed in six seconds each with
#   ERROR: Package 'jiter' requires a different Python: 3.10.12 not in '>=3.11'
# — a wheel that was correct for the target, refused because the builder's
# python was older than the target's. Unpacking what was already fetched makes
# the target the only thing that decides the contents, and leaves no second
# resolution to disagree with the download.
"$PY" - "$TMP/wheels" "$TMP/pkg/site-packages" <<'PY'
import pathlib
import sys
import zipfile

wheels, dest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for whl in sorted(wheels.glob("*.whl")):
    with zipfile.ZipFile(whl) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            parts = info.filename.split("/")
            # "<dist>-<ver>.data/{purelib,platlib}/..." is site-packages content;
            # a wheel's scripts/headers/data sections have no business in a tar
            # that is imported, never executed from a shell.
            if len(parts) > 2 and parts[0].endswith(".data"):
                if parts[1] not in ("purelib", "platlib"):
                    continue
                parts = parts[2:]
            out = dest.joinpath(*parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(zf.read(info))
PY

cp -r "$ROOT/agent" "$TMP/pkg/agent"
# Ship sources only: a .pyc embeds the compiling interpreter's view of source
# mtimes (nondeterministic across builds) and is dead weight anyway — a pyc
# built by THIS venv's python (e.g. cp310) never loads under the remote's
# python3.x (e.g. 3.12), which recompiles into its own __pycache__ on first
# import. Purge also covers __pycache__ copied from the repo's agent/ tree.
find "$TMP/pkg" -name "*.pyc" -delete
find "$TMP/pkg" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$(dirname "$OUT")"
# Deterministic bytes for a given input set. The tar's content hash is the
# remote install gate AND the asset name the release publishes, so the archive
# must be a function of the CONTENT alone — pack-pylibs-tar.py owns that (fixed
# member order, mtimes, ids, modes); `tar | gzip -n` did not, because
# `tar -C dir -cf - agent site-packages` walks readdir order and a fresh
# checkout reshuffles it (v0.2.0 shipped two hashes for identical files).
"$PY" "$ROOT/scripts/pack-pylibs-tar.py" "$TMP/pkg" "$OUT"
echo "pylibs tar written: $OUT ($TAG, py$PYVER)"
