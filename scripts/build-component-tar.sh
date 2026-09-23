#!/usr/bin/env bash
# A dev-mode component artifact: one component checkout, archived so a client can
# upload it as BYTES to the machine whose server will run it.
#
# Usage: build-component-tar.sh <component dir> <out.tar.gz>
#
# Members sit at the archive's TOP level on purpose: the install directory IS the
# component's own directory, so `memory.py` / `clutch_workspace/` must be at its
# root, not inside a `<component>/` subtree. Everything a checkout carries that is
# not source (VCS, venv, caches) is excluded — and nothing is excluded that the
# component needs to run.
set -euo pipefail

SRC="${1:?component directory}"
OUT="${2:?out archive}"
[ -d "$SRC" ] || { echo "no such component checkout: $SRC" >&2; exit 2; }

# node may pass a Windows-style path (C:\...): GNU tar would read the "C" as a
# tar remote hostname ("Cannot connect to C"). Same normalization as
# build-pylibs-tar.sh.
if command -v cygpath >/dev/null 2>&1; then
  SRC="$(cygpath -u "$SRC")"
  OUT="$(cygpath -u "$OUT")"
fi

rm -f "$OUT"
# patterns are matched against the member name ("./tests/__pycache__"), so each
# one is written with a leading "*/" to match at any depth
tar --exclude='*/.git' \
    --exclude='*/.venv' \
    --exclude='*/.pytest_cache' \
    --exclude='*/.ruff_cache' \
    --exclude='*/__pycache__' \
    --exclude='*.pyc' \
    -czf "$OUT" -C "$SRC" .
