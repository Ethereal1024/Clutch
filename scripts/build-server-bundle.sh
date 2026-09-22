#!/usr/bin/env bash
# Build the standalone clutch-server binaries (PyInstaller onefile) for THIS
# host's platform:
#   - agent-server       the agent API backend (session child)
#   - agent-supervisor   the per-machine supervisor (spawns session children)
#
# Usage: build-server-bundle.sh <version> <out-path>
set -euo pipefail

VERSION="${1:?version required}"
OUT="${2:?output path required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Skills shipped inside the agent-server binary. The library belongs to the
# clutch-skills module, whose bundled root is what the host reads by default
# (agent/config.py points skills_dir there), so the bundle must carry it too.
# Local-only skills (gitignored: the writing humanizers) stay out of the release
# on purpose — the module's .gitignore records them, and hatchling's wheel
# already excludes them via VCS rules. A tracked skill missing from this list
# would silently miss the release, hence the guard below.
SKILLS_REL="clutch-skills/skills"
if [ ! -d "$SKILLS_REL" ]; then
  echo "FATAL: $SKILLS_REL is missing — initialize the clutch-skills submodule first" >&2
  echo "       (git submodule update --init clutch-skills)" >&2
  exit 1
fi
SHIPPED_SKILLS="readme-crafter readme-doctor refactor web-design"
SKILL_ARGS=()
for s in $SHIPPED_SKILLS; do
  SKILL_ARGS+=(--add-data "$SKILLS_REL/$s:$SKILLS_REL/$s")
done
MISSING=""
for d in "$SKILLS_REL"/*/; do
  name="$(basename "$d")"
  case " $SHIPPED_SKILLS " in *" $name "*) continue ;; esac
  # a tracked skill dir that is not whitelisted is a packaging gap; the library
  # is versioned by the module, so ask that repo what it tracks
  if git -C "$ROOT/clutch-skills" ls-files --error-unmatch "skills/$name/SKILL.md" >/dev/null 2>&1; then
    MISSING="$MISSING $name"
  fi
done
if [ -n "$MISSING" ]; then
  echo "FATAL: tracked skill(s) missing from SHIPPED_SKILLS:$MISSING" >&2
  echo "       add them to SHIPPED_SKILLS above, or gitignore them as local-only" >&2
  exit 1
fi

"$ROOT/.venv/bin/python" -m PyInstaller --noconfirm --onefile --name agent-server \
  --add-data "agent/prompts:agent/prompts" \
  "${SKILL_ARGS[@]}" \
  --add-data "agent/transport_defaults.json:agent/" \
  scripts/server_entry.py

"$ROOT/.venv/bin/python" -m PyInstaller --noconfirm --onefile --name agent-supervisor \
  scripts/supervisor_entry.py

mkdir -p "$(dirname "$OUT")"
# OUT = the agent-server path; when external, also deliver the supervisor under
# a sibling version-keyed name (agent-supervisor-<same-suffix>).
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  SUPERVISOR_OUT="$(dirname "$OUT")/$(basename "$OUT" | sed 's/^agent-server/agent-supervisor/')"
  cp dist/agent-server "$OUT"
  cp dist/agent-supervisor "$SUPERVISOR_OUT"
  chmod +x "$SUPERVISOR_OUT"
fi
chmod +x "$OUT"
# remove PyInstaller scratch dirs, but never $OUT (it may live inside dist/)
rm -rf build agent-server.spec agent-supervisor.spec
if [ "$(realpath "$OUT")" != "$(realpath "$ROOT/dist/agent-server")" ]; then
  rm -rf dist
fi
echo "bundle written: $OUT (+ supervisor sibling)"
