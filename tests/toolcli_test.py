"""Tool-execution subprocess: agent/tools/cli.py + registry's subprocess branch.

Covers the pilot (read_file runs in a child process) and the dispatcher around
it: utf-8 round-trip through the pipes, protected-path enforcement in the
child, unknown-tool handling, branch equivalence vs the in-process call, and
prompt tree-kill on Stop.

Run: .venv/Scripts/python.exe -m tests.toolcli_test
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from tests.testsupport import check, posix_shell_argv

from agent.config import Config
from agent.tools import filesystem
from agent.tools.registry import ToolRegistry, build_default_tools
from agent.tools.workspace import LocalWorkspace

REPO_ROOT = Path(__file__).resolve().parents[1]


def _call_cli(payload: dict) -> dict:
    """Spawn the CLI exactly like the parent does: binary pipes, utf-8 bytes."""
    proc = subprocess.run(
        [sys.executable, "-m", "agent.tools.cli"],
        cwd=str(REPO_ROOT),
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    return json.loads(proc.stdout.decode("utf-8"))


def _payload(root: Path, name: str, args: dict, protected: list[str] | None = None) -> dict:
    return {
        "name": name,
        "args": args,
        "workspace_root": str(root),
        "mode": "work",
        "read_max_chars": 20000,
        "protected": protected or [],
    }


def test_cli_roundtrip_and_errors() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "数据.txt").write_text("line1\n中文内容\nline3\n", encoding="utf-8")
        (root / ".clc").write_text("project file\n", encoding="utf-8")

        r = _call_cli(_payload(root, "read_file", {"path": "数据.txt"}))
        check(r.get("error") is False, "cli roundtrip: no error")
        check("中文内容" in r.get("content", ""), "cli roundtrip: utf-8 content survives the pipes")
        check("line3" in r.get("content", ""), "cli roundtrip: full content arrives")

        r = _call_cli(_payload(root, "read_file", {"path": "missing.txt"}))
        check(r.get("error") is True, "cli: missing file is error-as-data")

        r = _call_cli(_payload(root, "read_file", {"path": ".clc"}, protected=[str(root / ".clc")]))
        check(
            r.get("error") is True and "protected" in r.get("content", "").lower(),
            "cli: child refuses a protected path (parent's snapshot re-applied)",
        )

        r = _call_cli(_payload(root, "definitely_not_a_tool", {}))
        check(
            r.get("error") is True and "unknown tool" in r.get("content", ""),
            "cli: unknown tool still returns parseable JSON",
        )


def test_registry_branch_matches_inprocess() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a.py").write_text("x = 1\ny = 2\n", encoding="utf-8")
        registry = ToolRegistry(build_default_tools(Config()))
        registry._tools["read_file"].subprocess = True  # flip the pilot flag
        args = {"path": "a.py"}
        via_child = registry.execute(LocalWorkspace(str(root)), Config(), "read_file", dict(args))
        direct = filesystem.read_file(LocalWorkspace(str(root)), Config(), **args)
        check(via_child == direct, "registry subprocess branch returns the identical dict")
        check(via_child["error"] is False and "diff" in via_child, "result is normalized (error/diff keys)")


def test_cancel_kills_tree() -> None:
    if posix_shell_argv() is None:
        print("ok:   cancel: SKIPPED (no POSIX shell on this host)")
        return
    registry = ToolRegistry(build_default_tools(Config()))
    registry._tools["run_command"].subprocess = True
    workspace = LocalWorkspace(tempfile.mkdtemp())
    cmd = f"{shlex.quote(sys.executable)} -c {shlex.quote('import time; time.sleep(30)')}"
    cancel = threading.Event()
    box: dict = {}

    def run() -> None:
        box["t0"] = time.monotonic()
        box["result"] = registry.execute(
            workspace, Config(), "run_command", {"command": cmd}, cancel=cancel
        )

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    time.sleep(0.5)
    cancel.set()
    worker.join(timeout=30)
    elapsed = time.monotonic() - box["t0"]
    check(not worker.is_alive(), "cancel: execute returned after Stop")
    check(elapsed < 15, f"cancel: subprocess killed promptly ({elapsed:.1f}s, not the 30s sleep)")
    check(box["result"].get("error") is True, "cancel: reported as error-as-data")


if __name__ == "__main__":
    test_cli_roundtrip_and_errors()
    test_registry_branch_matches_inprocess()
    test_cancel_kills_tree()
    print("all toolcli tests passed")
