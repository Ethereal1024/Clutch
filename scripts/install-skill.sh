#!/usr/bin/env bash
# install-skill.sh — download a skill from the web and install it into the
# LIVE skill library this host serves (config.skills_dir, the root the host's
# `load_skill` tool and the $skills fact both read).
#
#   scripts/install-skill.sh <skill-dir-url> <skill-name> [dest-root]
#
# The skill is a directory holding SKILL.md plus whatever it references; the
# library scans the root for `*/SKILL.md`, so installing is exactly "put the
# directory there". Sources are plain https URLs (a GitHub raw tree by default),
# so an install needs no git and no credentials.
#
# Why a script: the host asks `clutch-skills --facts list` at prompt-assembly
# time and reads nothing cached, so an installed skill is loadable on the very
# next request — and the provenance file it writes is what makes an install
# auditable (which URL, which bytes).
set -euo pipefail

URL="${1:?usage: install-skill.sh <skill-dir-url> <skill-name> [dest-root]}"
NAME="${2:?usage: install-skill.sh <skill-dir-url> <skill-name> [dest-root]}"

case "$URL" in
  https://*) ;;
  *) echo "install-skill: refusing a non-https source: $URL" >&2; exit 2 ;;
esac
case "$NAME" in
  ""|*/*|.|..) echo "install-skill: bad skill name: $NAME" >&2; exit 2 ;;
esac

HOSTROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${3:-}"
if [ -z "$ROOT" ]; then
  ROOT="$("$HOSTROOT/.venv/bin/python" -c 'import sys; sys.path.insert(0,sys.argv[1]); from agent.config import Config; print(Config().skills_dir)' "$HOSTROOT")"
fi
DEST="$ROOT/$NAME"
mkdir -p "$DEST"

echo "install-skill: $NAME"
echo "  source $URL"
echo "  dest   $DEST"

FILES="${SKILL_FILES:-SKILL.md}"
for rel in $FILES; do
  case "$rel" in *..*|/*) echo "install-skill: refusing path: $rel" >&2; exit 2;; esac
  mkdir -p "$DEST/$(dirname "$rel")"
  before=""; [ -f "$DEST/$rel" ] && before="$(sha256sum "$DEST/$rel" | cut -d' ' -f1)"
  curl -fsS --retry 3 --retry-connrefused -m 60 -o "$DEST/$rel" "${URL%/}/$rel"
  after="$(sha256sum "$DEST/$rel" | cut -d' ' -f1)"
  if [ "$before" = "$after" ]; then state="unchanged"; else state="installed"; fi
  printf '  %-32s %8s B  %s\n' "$rel" "$(stat -c%s "$DEST/$rel")" "$state"
done

{
  echo "{"
  echo "  \"skill\": \"$NAME\","
  echo "  \"source\": \"$URL\","
  echo "  \"installed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"files\": {"
  first=1
  for rel in $FILES; do
    [ $first -eq 1 ] || echo ","
    first=0
    printf '    "%s": {"sha256": "%s", "bytes": %s}' "$rel" \
      "$(sha256sum "$DEST/$rel" | cut -d' ' -f1)" "$(stat -c%s "$DEST/$rel")"
  done
  echo
  echo "  }"
  echo "}"
} > "$DEST/PROVENANCE.json"

echo "install-skill: the library this host reads now offers"
for d in "$ROOT"/*/; do
  [ -f "$d/SKILL.md" ] || continue
  printf '  - %s\n' "$(basename "$d")"
done
echo "done: $NAME installed (takes effect on the host's next prompt assembly)"
