"""The four file tools on the SSH path, driven the way the model drives them.

Run: python3 -m tests.remote_filesystem_test

Why a suite of its own. In the local backend `clutch-workspace` declares AND
performs read_file / grep / write_file / edit_file, so the host wires nothing
behind them (agent/tools/filesystem.py's own docstring). In the SSH backend the
far side is an execution layer with no daemon over there to declare anything, so
the HOST declares the four (tools/host.py `_REMOTE_DECLARATIONS`) and implements
them here over plain POSIX sh — cat / ls / find|xargs grep / printf
(workspace.RemoteWorkspace).

`tests/transport_test.py` proves that sh layer byte for byte. This one proves the
MODEL-FACING half, through a real registry and a real `/exec` bridge:

  1. the surface: each of the four is offered ONCE, host-owned, with no
     component copy beside it — and only when the session's root is remote and
     only in the modes its declaration names;
  2. the envelopes: a file's bytes, a directory read as its listing, the
     numbered line range and its continuation hint, the char truncation hint,
     the missing-file / protected-file refusals;
  3. the writers: byte-exact content (no newline invented), the unified diff,
     the unique / ambiguous / absent `old_string` cases;
  4. grep: hits, "(no matches)", `include` and `path` scoping, and a malformed
     pattern reported as a FAILED SEARCH rather than as an empty file;
  5. the quoting: a path with spaces, quotes, `$` and backticks survives the
     trip out to a shell and back, for both reads and searches;
  6. a bridge that is down is an ERROR the model can read, not an exception.

Everything goes through `ToolRegistry.execute` — the same door `/api/exec`
opens — so a guard, a default or a coercion changed anywhere in the call path
shows up here.
"""

from __future__ import annotations

import sys
import tempfile
import threading
from pathlib import Path

from agent.config import Config
from agent.tools import host
from agent.tools.registry import ToolRegistry, build_tools
from agent.tools.workspace import LocalWorkspace, RemoteWorkspace
from tests.testsupport import check, remote_root, start_bridge

FOUR = ("read_file", "grep", "write_file", "edit_file")


def _reg(tools) -> ToolRegistry:
    return ToolRegistry(tools)


def surface_check(cfg: Config, ws: RemoteWorkspace) -> ToolRegistry:
    """What the model is handed for a remote root, and what it is not."""
    tools = build_tools(cfg, workspace=ws)
    names = [t.name for t in tools]
    for name in FOUR:
        check(names.count(name) == 1, f"the host's own {name} is offered exactly once")
    by_name = {t.name: t for t in tools}
    for name in FOUR:
        tool = by_name[name]
        check(tool.host is not None and tool.inst is None, f"{name} is performed by the host, not a statement")
        check(tool.module is None, f"{name} names no component to ask, because no component performs it")
        check(tool.cancelable, f"{name} says Stop reaches it")
    check("run_command" in by_name, "the bootstrap tool is still there beside them")

    # the component's own copies are gone from this session, each with a reason
    # (the drop is a diagnostic, not a fatal refusal: the other components' tools
    # are still offered)
    owned = [n for n in by_name if n not in FOUR and by_name[n].inst is not None]
    check(bool(owned), f"other components still contribute to the same session ({owned[:3]})")

    # A local root keeps the component's four and adds no host copy: one name,
    # one reading — the component's daemon performs them there.
    with tempfile.TemporaryDirectory() as ltmp:
        local = build_tools(cfg, workspace=LocalWorkspace(ltmp))
        check(
            not any(t.name in FOUR and t.host is not None for t in local),
            "a local root wires no host file tools (the component's own daemon serves them)",
        )

    # The writers are `modes: ["work"]`, and that filter is the host's own for a
    # remote root (there is no component declaration left to carry it).
    chat = build_tools(Config(mode="chat"), workspace=ws)
    chat_names = [t.name for t in chat]
    check(
        "read_file" in chat_names and "grep" in chat_names,
        "chat still reads and searches: the two readers are mode-free",
    )
    check(
        "write_file" not in chat_names and "edit_file" not in chat_names,
        "chat is offered no writer, on the remote root too",
    )
    return _reg(tools)


def read_check(reg: ToolRegistry, cfg: Config, ws: RemoteWorkspace, rtmp: str) -> None:
    r = reg.execute(ws, cfg, "read_file", {"path": "notes.txt"})
    check(not r.error and r.content == "alpha\nbeta\ngamma\n", f"a remote file's bytes are read back as text ({r.content!r})")

    r = reg.execute(ws, cfg, "read_file", {"path": "."})
    check(
        not r.error and "notes.txt" in r.content.splitlines() and "dir/" in r.content.splitlines(),
        f"a directory reads as its listing, dirs marked with '/' ({r.content!r})",
    )

    r = reg.execute(ws, cfg, "read_file", {"path": "notes.txt", "offset": 2, "limit": 1})
    check(
        not r.error and r.content.startswith("2: beta\n"),
        f"offset/limit is 1-based and numbered ({r.content!r})",
    )
    check(
        "showing lines 2-2 of 3; use offset=3" in r.content,
        "and it says where to continue instead of silently re-serving the head",
    )

    r = reg.execute(ws, cfg, "read_file", {"path": "notes.txt", "max_chars": 8})
    check(
        not r.error and r.content.startswith("alpha\nbe") and "use offset=2" in r.content,
        f"a char-truncated read points at the first unread line ({r.content!r})",
    )

    r = reg.execute(ws, cfg, "read_file", {"path": "nope.txt"})
    check(r.error and r.content == "file not found: nope.txt", f"a missing path is an ERROR ({r.content!r})")

    r = reg.execute(ws, cfg, "read_file", {"path": "nope.txt", "offset": 1, "limit": 5})
    check(r.error, "a line range of a missing file is an ERROR too")

    # the .clc fence: the component is gone here, so this refusal is the host's
    # own (filesystem._refuse_protected) and must still hold on the remote root
    r = reg.execute(ws, cfg, "read_file", {"path": "secret.txt"})
    check(r.error and "protected" in r.content, f"a protected path is refused by the host ({r.content!r})")
    r = reg.execute(ws, cfg, "write_file", {"path": "secret.txt", "content": "x"})
    check(r.error and "protected" in r.content, f"and it cannot be written either ({r.content!r})")
    check(
        ws.read("secret.txt") == "the project log",
        "the refused write never reached the far side (the file is untouched)",
    )


def write_check(reg: ToolRegistry, cfg: Config, ws: RemoteWorkspace) -> None:
    r = reg.execute(ws, cfg, "write_file", {"path": "made/new.txt", "content": "one"})
    check(
        not r.error and r.content == "OK: wrote made/new.txt (3 chars)",
        f"a new file is written, and the summary names the path AS GIVEN ({r.content!r})",
    )
    check("+one" in r.diff, f"and the diff shows the added line ({r.diff!r})")
    check(ws.read("made/new.txt") == "one", "byte-exact: no trailing newline was invented")

    r = reg.execute(ws, cfg, "write_file", {"path": "notes.txt", "content": "alpha\nBETA\ngamma\n"})
    check(
        not r.error and r.content == "OK: wrote notes.txt (+1 -1 lines)",
        f"an overwrite reports its line delta ({r.content!r})",
    )
    check(
        "-beta" in r.diff and "+BETA" in r.diff,
        f"the diff is the change, not the whole file ({r.diff!r})",
    )
    check(ws.read("notes.txt") == "alpha\nBETA\ngamma\n", "and the far side holds the new bytes")

    # what the undo pane offers is the content this write replaced, recorded on
    # THIS side before the write (the far side has no daemon to remember it)
    check(
        ws.restore(ws.resolve("notes.txt")) == "alpha\nbeta\ngamma\n"
        and ws.read("notes.txt") == "alpha\nbeta\ngamma\n",
        "the host kept the replaced content, so the write can be undone locally",
    )


def edit_check(reg: ToolRegistry, cfg: Config, ws: RemoteWorkspace) -> None:
    r = reg.execute(ws, cfg, "edit_file", {"path": "notes.txt", "old_string": "beta", "new_string": "BETA"})
    check(
        not r.error and r.content == "OK: edited notes.txt (+1 -1 lines)",
        f"a unique block is replaced, path as given ({r.content!r})",
    )
    check(ws.read("notes.txt") == "alpha\nBETA\ngamma\n", "the far side holds the edit")

    r = reg.execute(ws, cfg, "edit_file", {"path": "dup.txt", "old_string": "same", "new_string": "other"})
    check(
        r.error and r.content == "old_string appears 2 times in dup.txt",
        f"an ambiguous old_string is refused, with its count ({r.content!r})",
    )
    check(ws.read("dup.txt") == "same\nsame\n", "and nothing was written")

    r = reg.execute(ws, cfg, "edit_file", {"path": "notes.txt", "old_string": "absent", "new_string": "x"})
    check(
        r.error and r.content == "old_string not found in notes.txt",
        f"an absent old_string reads as a correction, not a crash ({r.content!r})",
    )
    r = reg.execute(ws, cfg, "edit_file", {"path": "nope.txt", "old_string": "a", "new_string": "b"})
    check(
        r.error and r.content == "file not found: nope.txt — use write_file to create it",
        f"editing a missing file is an ERROR ({r.content!r})",
    )


def grep_check(reg: ToolRegistry, cfg: Config, ws: RemoteWorkspace) -> None:
    r = reg.execute(ws, cfg, "grep", {"pattern": "alpha", "path": "."})
    check(not r.error, f"a search succeeds ({r.content!r})")
    check(
        "notes.txt:" in r.content and "Line 1: alpha" in r.content,
        "hits are grouped by file with 1-based line numbers",
    )

    r = reg.execute(ws, cfg, "grep", {"pattern": "zzz-nothing", "path": "."})
    check(not r.error and r.content == "(no matches)", f"an empty result says so ({r.content!r})")

    r = reg.execute(ws, cfg, "grep", {"pattern": "alpha", "path": "dir"})
    check(
        "dir/inner.txt:" in r.content and "notes.txt:" not in r.content,
        "`path` scopes the search to one directory",
    )

    r = reg.execute(ws, cfg, "grep", {"pattern": "alpha", "path": ".", "include": "inner.txt"})
    check(
        "dir/inner.txt:" in r.content and "notes.txt:" not in r.content,
        "`include` filters by file name",
    )

    # A malformed pattern is a search that did not run. The pipeline's exit
    # status is `head`'s, so only stderr can tell this apart from a real
    # no-match — answering "(no matches)" would say the text is absent when
    # nothing was read.
    r = reg.execute(ws, cfg, "grep", {"pattern": "[", "path": "."})
    check(r.error, f"an invalid regex is an ERROR, not an empty result ({r.content!r})")
    check(
        r.content.startswith("invalid regex: "),
        "and it opens with the component's own words, the engine's sentence after",
    )

    # a `path` that is not there is an ERROR on both backends, with the same
    # frozen sentence (the component raises ENOENT on the same call); answering
    # "(no matches)" would hide a typo in the path
    r = reg.execute(ws, cfg, "grep", {"pattern": "nothing", "path": "does-not-exist"})
    check(
        r.error and r.content == "file not found: does-not-exist",
        f"a missing `path` is an ERROR, like the local backend's ({r.content!r})",
    )


def quoting_check(reg: ToolRegistry, cfg: Config, ws: RemoteWorkspace) -> None:
    """The far side parses a command with a shell, so the arguments have to be
    quoted there — a path is not a word the shell may split, expand or run."""
    hostile = "odd/$(touch PWNED) 'q' \"dq\" `bt` & ; |.txt"
    r = reg.execute(ws, cfg, "write_file", {"path": hostile, "content": "payload\n"})
    check(not r.error, f"a hostile path is written, not executed ({r.content!r})")
    r = reg.execute(ws, cfg, "read_file", {"path": hostile})
    check(not r.error and r.content == "payload\n", f"and read back through the same quoting ({r.content!r})")
    r = reg.execute(ws, cfg, "grep", {"pattern": "payload", "path": "odd"})
    check("Line 1: payload" in r.content, f"grep finds it too ({r.content!r})")

    r = reg.execute(ws, cfg, "grep", {"pattern": "it's $(id) `x`", "path": "."})
    check(
        not r.error,
        f"a pattern full of shell metacharacters is passed through as a pattern ({r.content!r})",
    )
    check(
        not (Path(ws.root) / "PWNED").exists() and not Path("PWNED").exists(),
        "nothing in the arguments ran as a command",
    )


def down_check(cfg: Config) -> None:
    """A bridge that is not there is an ERROR envelope, not a traceback: the
    model has to be able to read what happened."""
    with tempfile.TemporaryDirectory() as rtmp:
        dead = RemoteWorkspace(remote_root(rtmp), "http://127.0.0.1:1/exec")
        reg = _reg(build_tools(cfg, workspace=dead))
        for name, args in (
            ("read_file", {"path": "x.txt"}),
            ("grep", {"pattern": "x", "path": "."}),
            ("write_file", {"path": "x.txt", "content": "y"}),
            ("edit_file", {"path": "x.txt", "old_string": "a", "new_string": "b"}),
        ):
            r = reg.execute(dead, cfg, name, args)
            check(r.error, f"{name} with the bridge down is an ERROR envelope")


def main() -> int:
    cfg = Config()
    with tempfile.TemporaryDirectory() as rtmp:
        server, bridge = start_bridge()
        try:
            ws = RemoteWorkspace(remote_root(rtmp), bridge)
            ws.write("notes.txt", "alpha\nbeta\ngamma\n")
            ws.write("dup.txt", "same\nsame\n")
            ws.write("dir/inner.txt", "alpha in dir\n")
            ws.write("secret.txt", "the project log")
            ws.protect(Path(str(ws.root)) / "secret.txt")

            reg = surface_check(cfg, ws)
            read_check(reg, cfg, ws, rtmp)
            write_check(reg, cfg, ws)
            edit_check(reg, cfg, ws)
            grep_check(reg, cfg, ws)
            quoting_check(reg, cfg, ws)
        finally:
            server.shutdown()

    down_check(cfg)

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
