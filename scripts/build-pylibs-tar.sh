#!/usr/bin/env bash
# Build the tar the far side unpacks: `agent/` (its own code) plus an empty
# `site-packages/`.
#
# Usage: build-pylibs-tar.sh <out> <os> <arch> <libc>
#
# The target is the supply line's whole contract, and it is os/arch/libc only:
# the tar's CONTENT does not depend on the interpreter that will run it. The
# agent's Python side is stdlib-only (pyproject.toml, and the same posture as
# clutch-workspace / clutch-skills) — the model call lives in the host
# (ui/src/host/llm.js) — so there is no third-party wheel to cross-download and
# nothing compiled against a specific ABI. This script used to carry openai +
# httpx2 and, pinned through them, pydantic / pydantic_core / jiter: those
# require Python >= 3.9/3.10 and publish no cp38 build, which is what made
# "support an older remote" a five-package downgrade instead of a source change,
# and what put the interpreter version in the artifact's NAME. With nothing to
# install, the name says what actually matters: which platform the release
# promises to serve. The interpreter floor is the sources' own (3.8), declared
# in pyproject.toml and enforced by the 3.8 CI leg — not by this file's name.
#
# `site-packages/` is still a real (empty) directory in the archive: the install
# is a swap of BOTH trees (see pylibsInstallCmd), the tree probe scans that path
# for two generations of one project's metadata, and `__ART__` reads it as the
# mark of this strategy. Keeping the shape means the far side's contract did not
# move with the wheels.
set -euo pipefail

OUT="${1:?out}"
OS="${2:?os}"
ARCH="${3:?arch}"
LIBC="${4:?libc}"
# node passes Windows-style paths (C:\...); under Git Bash/MSYS2 GNU tar would
# read the "C" as a tar remote hostname ("Cannot connect to C"). Normalize.
if command -v cygpath >/dev/null 2>&1; then
  OUT="$(cygpath -u "$OUT")"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The packer is the only thing here that needs python. Prefer this checkout's
# venv (the build may also run on a Windows client targeting a Linux remote,
# where `python3` is not a name), and fall back to whatever interpreter the
# host offers — there are no wheels left to resolve, so any python3 will do.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PY="$ROOT/.venv/Scripts/python.exe" ;;
  *) PY="$ROOT/.venv/bin/python" ;;
esac
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PY" ]; then
  echo "no python3 to pack with" >&2
  exit 2
fi

TMP="$(mktemp -d)"
# || true: a raced file lock (AV scanner) must not flip the script's exit code
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT
mkdir -p "$TMP/pkg/site-packages"

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
echo "pylibs tar written: $OUT (${OS}/${ARCH}/${LIBC})"
