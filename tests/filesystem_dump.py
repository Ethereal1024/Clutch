"""The four host file tools, run as one batch: cases in, envelopes out.

The conformance runner (tests/conform.test.js) holds two implementations to one
frozen text, and after the SSH plugin was retired both are Python:

  * `clutch-workspace`'s CLI — the component that serves a LOCAL root, whose
    daemon performs read_file / grep / write_file / edit_file there;
  * `agent/tools/filesystem.py` — the implementation the HOST brings when the
    root is on another machine (tools/host.py `_REMOTE_DECLARATIONS`).

They are two readings of one promise (`agent/prompts/tools/<name>.md` is
byte-identical to the component's description: a call reads the same whichever
machine served it), so one runner drives both against the same fixture tree and
diffs what came back. This script is the Python-side oracle for the second one:
it loads the real functions, runs the cases IN ORDER against one root (they are
stateful — a write changes what the next read sees), and prints one envelope per
case, flattened to what the model reads.

    echo '{"root": "…", "cases": [{"tool": "read_file", "args": {"path": "."}}]}' \\
        | python3 tests/filesystem_dump.py

Run: python3 tests/filesystem_dump.py < cases.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.config import Config  # noqa: E402
from agent.tools import filesystem  # noqa: E402
from agent.tools.workspace import LocalWorkspace  # noqa: E402

# the four, by the name the model calls them; the argument names are the
# declaration's own, so the cases in conform.test.js are the same dicts on both
# sides of the comparison
TOOLS = {
    "read_file": filesystem.read_file,
    "grep": filesystem.grep,
    "write_file": filesystem.write_file,
    "edit_file": filesystem.edit_file,
}


def main(argv: list[str]) -> int:
    payload = json.load(sys.stdin)
    workspace = LocalWorkspace(payload["root"])
    config = Config()
    out = []
    for case in payload["cases"]:
        tool = TOOLS[case["tool"]]
        envelope = tool(workspace, config, **case.get("args", {}))
        out.append({"content": envelope.content, "diff": envelope.diff, "error": envelope.error})
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
