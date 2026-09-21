"""Subprocess entry point for tool execution.

Parent: registry.execute -> spawn [sys.executable, "-m", "agent.tools.cli"].
Child:  read ONE JSON object from stdin, call the same tool function the
registry would call in-process, print its {content, error, diff} dict as a
JSON object on stdout. The exit code stays 0 whenever a result was produced —
the parent trusts the JSON, not the code; a non-zero exit only marks a crash
before any JSON, which the parent reports from stderr.

stdin payload:
    {"name": str, "args": dict, "workspace_root": str,
     "mode": str, "read_max_chars": int, "protected": [str, ...]}

Platform notes: no shell is involved anywhere; the parent keeps its pipes
BINARY (text mode would translate newlines on Windows) and this side reads
and writes the raw buffers, so no locale default is ever consulted (a Chinese
Windows box defaults to GBK, a C-locale POSIX box to ASCII).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from ..config import Config
from .registry import build_default_tools
from .workspace import LocalWorkspace


def _run(payload: dict) -> dict:
    name = payload["name"]
    config = Config(
        mode=payload.get("mode", "work"),
        read_max_chars=payload.get("read_max_chars", 20000),
    )
    workspace = LocalWorkspace(payload["workspace_root"])
    # protection lives in a parent-side in-memory set; a fresh Workspace does
    # not have it, so the parent ships its snapshot and we re-apply it BEFORE
    # the tool runs (read_file/write_file refuse protected paths)
    for p in payload.get("protected", []):
        workspace.protect(Path(p))
    tool = {t.name: t for t in build_default_tools(config)}.get(name)
    if tool is None:
        # memory tools are closures over the parent's MemoryStore and are
        # never migrated; any other unknown name is a parent-side bug
        return {"content": f"ERROR: unknown tool {name!r}", "error": True}
    return tool.func(workspace, config, **payload.get("args", {}))


def main() -> int:
    try:
        raw = sys.stdin.buffer.read()
        out = json.dumps(_run(json.loads(raw.decode("utf-8"))), ensure_ascii=False)
    except Exception as e:  # noqa: BLE001 -- report to the parent as data
        out = json.dumps({"content": f"ERROR: cli crashed: {e}", "error": True}, ensure_ascii=False)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
