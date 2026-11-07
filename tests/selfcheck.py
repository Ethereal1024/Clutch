"""Self-check: validates core logic without needing the LLM.

Run: uv run python -m tests.selfcheck
Covers: parsing, the project's log window, workspace path safety, tool execution.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from agent.config import Config
from agent.core.lazy import LazyEventLog
from agent.core.parse import ParseError, parse_arguments
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    UserMessageEvent,
    event_to_json,
)
from agent.tools import modules, rendezvous, statement
from agent.tools.registry import ToolRegistry, build_tools, prompt_section
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check

# The interpreter a real command may invoke: Windows ships python.exe only
# (the WindowsApps `python3` alias is a Store stub, not an interpreter), while
# POSIX hosts expose python3. The guard itself accepts both spellings.
PY = "python" if os.name == "nt" else "python3"


def check_skills(config: Config) -> None:
    # 7. skills: the catalog belongs to the COMPONENT that serves the library.
    #    clutch-skills publishes it (`facts` in its own component.json, answered
    #    by its --facts mode), the host asks for it wherever it spends the fact
    #    (tools/facts.py) — and the enum, the sentence beside it and the prompt
    #    fragment all read that one answer. The host keeps no scanner of a library
    #    that is not its subject: no root to point at, no directory to walk.
    reg = ToolRegistry(build_tools(config))
    tool = reg.tool("load_skill")
    if tool is None:
        print("SKIP: no clutch-skills checkout beside the repo")
        return
    assert tool.inst is not None  # the registry always carries one
    field = tool.parameters["properties"]["name"]
    enum = field["enum"]
    check(
        isinstance(enum, list) and len(enum) >= 1 and all(isinstance(n, str) and n for n in enum),
        f"the model picks from the component's own catalog ({len(enum)} skills)",
    )
    first = enum[0]
    check(
        first in field["description"] and "$skills" not in field["description"],
        "and the sentence beside the enum is the same fact, resolved",
    )

    section = prompt_section(config)
    header = "Available skills (call load_skill"
    check(
        header in section and f"- {first}:" in section,
        "the component's own fragment reaches the prompt, catalog and all",
    )

    # The empty-catalog answer (no skill in the component's library) is the
    # component's own question and is pinned by its suite; the host is never
    # asked it here.

    # The call the model makes is one terminal command: the module's CLI on the
    # APP host. Its bytes are pinned here; that the module ANSWERS (a skill, or
    # the 404 verdict for an unknown name) is pinned by clutch-skills' own suite
    # and driven live by tests/tools_inst_test --live. The prefix is the
    # artifact's own shape (a checkout, a package, an installed onefile), so the
    # declaration only carries the flags that follow it.
    with tempfile.TemporaryDirectory() as stmp:
        if rendezvous.available(modules.SKILLS):
            ready = statement.prepare(modules.SKILLS, LocalWorkspace(stmp), config)
            line = ready.line(tool.inst, {"name": first}, tool.defaults)
            check("clutch_skills" in ready.prefix and "show" in line, "load_skill renders the skills CLI")
            check(first in line and "--envelope" in line, "the statement carries the skill and the envelope flag")


def check_permission() -> None:
    # 9. permission: rules match the actual command, not the JSON envelope
    from agent.core.permission import PermissionEvaluator

    with tempfile.TemporaryDirectory() as wtmp:
        ws = LocalWorkspace(wtmp)
        pe = PermissionEvaluator()
        check(
            pe.evaluate('{"command": "rm old.txt"}', ws, access="command") == "ask",
            "permission asks on rm",
        )
        check(
            pe.evaluate('{"command": "rm -rf /tmp/x"}', ws, access="command") == "ask",
            "permission asks on rm -rf",
        )
        check(
            pe.evaluate('{"command": "echo hi"}', ws, access="command") == "allow",
            "permission allows harmless command",
        )
        check(
            pe.evaluate('{"path": "a.txt"}', ws, access="write") == "allow",
            "permission allows in-workspace write",
        )
        check(
            pe.evaluate('{"path": "../x.txt"}', ws, access="write") == "ask",
            "permission asks on escaping write",
        )
        # write_file rules match the PATH, not the content ("~" in a report must not ask)
        check(
            pe.evaluate('{"content": "16:07 UTC ~ 16:09 UTC", "path": "report.md"}', ws, access="write") == "allow",
            "write_file content with ~ does not prompt (path-only matching)",
        )
        check(
            pe.evaluate('{"content": "x", "path": "~/x"}', ws, access="write") == "ask",
            "write_file path with ~ still asks",
        )

        # absolute paths INSIDE the workspace are not escapes; must not prompt
        sub = Path(wtmp) / "sub"
        sub.mkdir()
        check(
            pe.evaluate(f'{{"path": "{sub}/new.py"}}', ws, access="write") == "allow",
            "write_file on an absolute path inside the workspace does not prompt",
        )
        check(
            pe.evaluate(f'{{"command": "cat {sub}/a.txt"}}', ws, access="command") == "allow",
            "run_command on an inside absolute path does not prompt",
        )
        check(
            pe.evaluate(f'{{"command": "cd {wtmp} && ls"}}', ws, access="command") == "allow",
            "run_command with the workdir as cwd does not prompt",
        )
        check(
            bool(pe.escaped_paths('{"command": "cat /etc/passwd"}', ws, access="command")),
            "external absolute path still surfaces an escape",
        )
        check(
            pe.evaluate('{"path": "/etc/x"}', ws, access="write") == "ask",
            "write_file on an absolute path outside still asks",
        )

        # 9b. gate: an ask blocks until resolved; resolve(False) denies
        import threading as _threading

        from agent.core.permission import PermissionGate, PermissionRequired

        gate = PermissionGate(evaluator=pe)
        outcome: dict = {}

        def _require() -> None:
            try:
                gate.require("run_command", '{"command": "rm -rf /tmp/x"}', ws, "command")
                outcome["raised"] = None
            except PermissionRequired as e:
                outcome["raised"] = e.reason

        t = _threading.Thread(target=_require, daemon=True)
        t.start()
        import time as _time

        _time.sleep(0.2)
        pending = gate.pending_ids()
        check(len(pending) == 1, "ask stays pending while waiting for the user")
        check(pending[0].startswith("perm-"), f"the ask carries an id the UI can answer ({pending})")
        check(gate.resolve(pending[0], False), "pending ask resolved by the UI")
        t.join(timeout=2)
        check(outcome.get("raised") == "denied by user", "denied ask unblocks the agent with 'denied by user'")

        # 9c. no UI attached (on_ask returns False): the gate denies instead of hanging
        gate2 = PermissionGate(evaluator=pe, on_ask=lambda *a: False)
        try:
            gate2.require("run_command", '{"command": "rm -rf /tmp/x"}', ws, "command")
            check(False, "no-UI ask is denied, not executed")
        except PermissionRequired as e:
            check(
                "no user interface" in e.reason,
                f"no-UI ask denies with a clear reason ({e.reason!r})",
            )
        check(len(gate2.pending_ids()) == 0, "no-UI ask leaves no pending entry")

        # 9d. sandbox escapes: real resolution flags external paths for an ask
        check(
            pe.escaped_paths('{"path": "/etc/passwd"}', ws, access="read")
            == frozenset({Path("/etc/passwd").resolve()}),
            "escaped_paths flags an external read",
        )
        check(
            pe.escaped_paths('{"command": "cat /etc/passwd"}', ws, access="command")
            == frozenset({Path("/etc/passwd").resolve()}),
            "escaped_paths flags external tokens in run_command",
        )
        check(pe.escaped_paths('{"path": "a.txt"}', ws, access="read") == frozenset(), "in-sandbox path has no escapes")
        # scratch exemption: the workspace must not itself be inside /tmp
        with tempfile.TemporaryDirectory(dir=Path.home()) as home_tmp:
            home_ws = LocalWorkspace(home_tmp)
            check(
                pe.escaped_paths(
                    "run_command",
                    '{"command": "uv run python -m x >/tmp/out.log 2>&1 && tail -25 /tmp/out.log"}',
                    home_ws,
                )
                == frozenset(),
                "scratch redirect targets (/tmp, /dev/null) are not escapes",
            )
            # a `..` that climbs back out of the scratch dir is still an escape,
            # reported at the path the token really denotes: on a Git-Bash host
            # /tmp is %TEMP%, so the target is %TEMP%/../etc/hack, not /etc/hack
            out_esc = pe.escaped_paths('{"command": "echo hi > /tmp/../etc/hack"}', home_ws, access="command")
            expect = home_ws.norm_join(str(home_ws.root), home_ws.shell_path("/tmp/../etc/hack"))
            check(
                out_esc == frozenset({expect}),
                "a '..' that walks out of a scratch dir is still an escape",
            )
            # W1: the whole POSIX scratch surface, not just /tmp + /dev/null.
            # Under Git Bash (MSYS) /dev/* and /var/tmp are exactly as harmless
            # as they are on Linux, so an ordinary command that redirects there
            # must not be rejected; under cmd.exe those very tokens ARE
            # drive-relative paths and stay escapes. The verdict follows the
            # shell that will parse the text (workspace.shell_path).
            posix_shell = home_ws.exec_shell().posix
            for cmd in (
                "head -c 16 /dev/urandom | xxd",  # /dev/zero, /dev/fd/N, /dev/tty too
                "some-cmd 2>/dev/stderr",
                "echo hi > /var/tmp/x.log",
            ):
                esc = pe.escaped_paths(json.dumps({"command": cmd}), home_ws, access="command")
                if posix_shell:  # POSIX sh (any OS): scratch, so not an escape
                    check(esc == frozenset(), f"POSIX scratch is not an escape: {cmd}")
                else:  # cmd dialect: the same token is literally C:\dev\..., an escape
                    check(esc != frozenset(), f"cmd dialect judges the same token literally: {cmd}")
            # the shell guard asks the same question through resolve(): a scratch
            # token the verdict accepts must not be rejected at execution either
            try:
                home_ws.resolve(home_ws.shell_path("/dev/urandom"))
                guard_ok = True
            except ValueError:
                guard_ok = False
            check(guard_ok == posix_shell, "run_command's guard agrees with the escape verdict on /dev/*")
            # and the boundary still holds: `..` climbs OUT of /dev into a real dir
            check(
                pe.escaped_paths('{"command": "cat /dev/../etc/passwd"}', home_ws, access="command") != frozenset(),
                "a '..' that walks out of /dev is still an escape",
            )
        check(
            pe.escaped_paths('{"content": "/etc/passwd ~ ../x", "path": "a.txt"}', ws, access="write") == frozenset(),
            "content is not scanned for escapes",
        )
        ext = ws.root.parent / "approved.txt"
        # json.dumps, not an f-string: a Windows path is full of backslashes,
        # which in raw JSON are escape sequences ("\U", "\t", ...) and make the
        # argument string unparseable
        check(
            pe.escaped_paths(json.dumps({"path": str(ext)}), ws, access="write") == frozenset({ext}),
            "escaped_paths flags an external write target",
        )

        # 9e. a user-approved escape is resolvable during the call, then cleared
        ws3 = LocalWorkspace(wtmp)
        approving = PermissionGate(evaluator=pe, on_ask=lambda *a: True)
        got: dict = {}

        def _require_escape() -> None:
            try:
                approving.require("write_file", json.dumps({"path": str(ext)}), ws3, "write")
                got["ok"] = True
            except PermissionRequired as e:
                got["err"] = e.reason

        t2 = _threading.Thread(target=_require_escape, daemon=True)
        t2.start()
        _time.sleep(0.15)
        for rid in approving.pending_ids():
            approving.resolve(rid, True)
        t2.join(timeout=2)
        check(got.get("ok"), "escape ask approved by the user")
        check(ws3.resolve(str(ext)) == ext, "approved escape resolvable during the call")
        ws3.clear_allowed()
        try:
            ws3.resolve(str(ext))
            check(False, "cleared escape is refused again")
        except ValueError:
            check(True, "cleared escape is refused again")

        # 9f. auto-allow fails closed on escapes; rule asks stay auto-allowed
        unattended = PermissionGate(evaluator=pe, auto_allow=True)
        try:
            unattended.require("read_file", '{"path": "/etc/passwd"}', ws, "read")
            check(False, "auto-allow refuses a sandbox escape")
        except PermissionRequired as e:
            check("user approval" in e.reason, f"auto-allow fails closed on escapes ({e.reason!r})")
        try:
            unattended.require("run_command", '{"command": "rm old.txt"}', ws, "command")
            check(True, "auto-allow still permits non-escape rule asks")
        except PermissionRequired:
            check(False, "auto-allow still permits non-escape rule asks")


def check_project_file(config: Config) -> None:
    # 10. project file: .clc round-trip + protected visibility
    from agent.project import create_project, open_project_lazy

    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "demo", "demo")
        check(isinstance(proj.log, LazyEventLog), "create_project opens the lazy log (one code path)")
        proj.log.append(UserMessageEvent(content="hi"))
        proj.log.append(UserMessageEvent(content="there"))
        check(proj.path.exists(), "project .clc created")
        check(proj.workdir == Path(ptmp), "project workdir is parent dir")
        reloaded = open_project_lazy(proj.path)
        check(
            [e.content for e in reloaded.events()] == ["hi", "there"],
            "project round-trips events",
        )
        ws = LocalWorkspace(str(ptmp))
        ws.protect(proj.path)
        check(ws.is_protected(proj.path), "workspace protects .clc")
        # a symlink loop must not raise out of the path bookkeeping: Path.resolve()
        # raises RuntimeError for one (RuntimeError is not an OSError, so the old
        # `except OSError` guard here never saw it), while realpath is total and
        # answers "not the protected file" — which is true of a loop by definition
        try:
            (Path(ptmp) / "loopa").symlink_to("loopb")
            (Path(ptmp) / "loopb").symlink_to("loopa")
        except OSError:
            print("skip: symlink loop checks (this host cannot create symlinks)")
        else:
            check(
                ws.realpath(ws.root / "loopa") == ws.realpath(ws.root) / "loopa",
                "realpath is total: a symlink loop comes back unresolved, not as an error",
            )
            check(not ws.is_protected(ws.root / "loopa"), "a symlink loop is not the protected file")
        reg = ToolRegistry(build_tools(config))
        r = reg.execute(ws, config, "read_file", {"path": proj.path.name})
        check(r.error, "read_file refuses protected .clc")
        r = reg.execute(ws, config, "read_file", {"path": "."})
        check(proj.path.name not in r.content, "read_file on a directory hides .clc")

    # 10b. the project log's own readers: grep_memory / read_memory. They are
    #      HOST tools, not a component (tools/host.py says why): the bytes they
    #      read are the ones this process appends to and the workspace protects,
    #      so the file is never an argument the model passes — the registry hands
    #      every call the session's own log.
    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "mem", "mem")
        check(not hasattr(proj, "memories"), "a project carries no memory store: its log IS the memory")
        proj.log.append(UserMessageEvent(content="the backend uses Flask + SQLite"))
        proj.log.append(AssistantMessageEvent(content="noted: the user prefers a dark theme"))
        ws = LocalWorkspace(ptmp)
        reg = ToolRegistry(build_tools(config, log=proj.log), log=proj.log)
        check(
            {"grep_memory", "read_memory"} <= set(reg.names()),
            "a project session is offered both log readers",
        )
        check(
            reg.tool("grep_memory").needs_log and reg.access("grep_memory") == "",
            "the readers take the log from the registry, and are not path-guarded (they have no path)",
        )

        r = reg.execute(ws, config, "grep_memory", {"pattern": "Flask"})
        check(
            "line 1: [user_message " in r.content and "Flask + SQLite" in r.content,
            "grep_memory names the line its hit sits on",
        )
        r = reg.execute(ws, config, "grep_memory", {"pattern": ".", "include": "note"})
        check("no line matches" in r.content, "include narrows the scan by event type")
        r = reg.execute(ws, config, "grep_memory", {"pattern": "("})
        check(r.error and "not a valid regular expression" in r.content, "a bad pattern is refused, not raised")

        r = reg.execute(ws, config, "read_memory", {})
        check("lines 1-2 of 2" in r.content, "read_memory with no offset pages the TAIL")
        check("Flask" in r.content and "dark theme" in r.content, "the page carries each line's text")
        r = reg.execute(ws, config, "read_memory", {"offset": 99})
        check(
            r.error and "past the end" in r.content and "2 lines" in r.content,
            "an offset past the end is refused, with the line count",
        )

        # The log is the SESSION's, never the model's: an argument named "log" is
        # overwritten by the registry (Tool.needs_log), so a reader cannot be
        # pointed at a file of the model's choosing.
        decoy = create_project(Path(ptmp) / "decoy", "decoy")
        decoy.log.append(UserMessageEvent(content="decoy content"))
        r = reg.execute(ws, config, "read_memory", {"log": decoy.log})
        check(
            "mem.clc" in r.content and "decoy" not in r.content,
            "a call reads the session's log even when the model names another",
        )

        # no project, no readers (the `project` gate)
        bare = ToolRegistry(build_tools(config), log=None)
        check(
            "grep_memory" not in bare.names() and "read_memory" not in bare.names(),
            "no project log, no log readers",
        )

    # 10c. a .clc an older build wrote still opens exactly like a new one: the
    #      header lines that build added (a memory_index ring, a [memories]
    #      section) are read over, and the notes inside it are as durable as any
    #      turn — the readers show them. No open rewrites a file it did not write.
    with tempfile.TemporaryDirectory() as ptmp:
        legacy = Path(ptmp) / "legacy.clc"
        evs = [UserMessageEvent(content="task")]
        for i in range(1, 60):
            evs.append(AssistantMessageEvent(content=f"w{i}") if i % 2 else UserMessageEvent(content=f"a{i}"))
        evs.append(CompactionEvent(summary="sum"))
        for i in range(61, 70):
            evs.append(AssistantMessageEvent(content=f"r{i}"))
        legacy.write_text(
            "\n".join(
                ["# clutch project v1", "name: legacy", "model: fake-model", "memory_index=0000000000,ZZ", "---"]
                + [event_to_json(e) for e in evs]
                + ["[memories]", '{"title": "m1", "content": "one", "updated": 0}']
                + [event_to_json(AssistantMessageEvent(content=f"after{i}")) for i in range(70, 75)]
            )
            + "\n",
            encoding="utf-8",
            newline="\n",  # .clc is BYTE-addressed: text mode CRLF would shift offsets
        )
        legacy_before = legacy.read_bytes()
        mig = open_project_lazy(legacy)
        check(legacy.read_bytes() == legacy_before, "a writable open never rewrites a legacy file")
        check(mig.log.cpr_start() > 0, "legacy file with a compaction derives its window boundary")
        check(
            all(e.type != "user_message" or i == 0 for i, e in enumerate(mig.events())),
            "legacy window materializes only from the last compaction onward",
        )
        lreg = ToolRegistry(build_tools(config, log=mig.log), log=mig.log)
        lws = LocalWorkspace(ptmp)
        r = lreg.execute(lws, config, "grep_memory", {"pattern": "m1"})
        check(
            "[note] [Note] m1: one" in r.content and r.content.startswith("legacy.clc:"),
            "a legacy memory line reads as a note of the log",
        )
        r = lreg.execute(lws, config, "grep_memory", {"pattern": "task"})
        check("line 1:" in r.content, "line numbering starts at the first EVENT (the header is not the log)")
        r = lreg.execute(lws, config, "read_memory", {})
        check("after74" in r.content, "read_memory pages the newest lines of a legacy file")

        # read-only open: same reader, and the file is still untouched
        ro = Path(ptmp) / "ro.clc"
        ro.write_text(
            "# clutch project v1\nname: ro\nmodel: m\n---\n"
            + event_to_json(UserMessageEvent(content="task")) + "\n"
            + "[memories]\n" + '{"title": "ro1", "content": "readonly", "updated": 0}\n',
            encoding="utf-8",
            newline="\n",  # .clc is BYTE-addressed (offsets), never CRLF
        )
        before = ro.read_bytes()
        roproj = open_project_lazy(ro, read_only=True)
        r = ToolRegistry(build_tools(config, log=roproj.log), log=roproj.log).execute(
            lws, config, "grep_memory", {"pattern": "readonly"}
        )
        check("[note] [Note] ro1: readonly" in r.content, "read_only: the log readers still see the legacy note")
        check(ro.read_bytes() == before, "read_only: file untouched")


def check_windowed_clc(config: Config) -> None:
    # 11. windowed .clc loading: only the model window materializes; older
    # history stays on disk and is paged via pure-disk read_page
    with tempfile.TemporaryDirectory() as ptmp:
        from agent.core.lazy import _make_reader, parse_durable
        from agent.events import _line_bytes
        from agent.project import open_project_lazy

        p = Path(ptmp) / "big.clc"
        events = [UserMessageEvent(content="task")]
        for i in range(1, 100):
            events.append(
                AssistantMessageEvent(content=f"old work {i}")
                if i % 2 == 0
                else UserMessageEvent(content=f"old ask {i}")
            )
        comp_off = sum(_line_bytes(ev) for ev in events[:90])
        lines = [
            "# clutch project v1", "name: lazy", "model: fake-model",
            f"cpr_start={comp_off:010d}", "---",
        ]
        for ev in events:
            lines.append(event_to_json(ev))
        lines.append(event_to_json(CompactionEvent(summary="old work summarized")))
        for i in range(101, 121):
            lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        p.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

        proj = open_project_lazy(p, workspace=None)
        log = proj.log
        check(isinstance(log, LazyEventLog), "compaction file opens lazily")
        offs = [off for off, _ in log.items()]
        check(all(o >= comp_off for o in offs),
              "lazy open materializes only the model window (the task is not resident)")
        check(log.cpr_start() == comp_off, "cpr_start read from the header line")
        check(log.window_bytes() == (log._file_bytes - log._base) - comp_off,
              "window_bytes = the file bytes past the cpr_start boundary")
        check(max(0, log.cpr_start()) == comp_off,
              "older counts the on-disk bytes before the window (cpr_start)")
        read, total = _make_reader(p, None)
        check(total == log._file_bytes, "reader sees the full file bytes")

        # paging: pure-disk read of pre-window history; the resident log is the
        # tail of a full parse, so nothing was dropped by materializing only the
        # window (the message projection that used to prove this is ui/context.js)
        page = log.read_page(0, comp_off)
        check(len(page) == 90, "read_page pages the task + the on-disk middle on demand (90 events)")
        check(
            all(off >= comp_off for off, _ in log.items()),
            "read_page left the resident log untouched (history stays on disk)",
        )
        full = LazyEventLog.in_memory()
        for ev in parse_durable(p.read_text(encoding="utf-8")):
            full.append(ev)
        everything = [event_to_json(ev) for ev in full.events()]
        resident = [event_to_json(ev) for _, ev in log.items()]
        check(resident == everything[-len(resident):],
              "the resident window is the tail of a full parse (middle paged separately)")

        # no cpr_start line: full window; open never migrates it
        legacy = Path(ptmp) / "legacy.clc"
        legacy.write_text(
            "\n".join(
                ["# clutch project v1", "name: old", "model: fake-model", "---"]
                + [event_to_json(ev) for ev in events]
                + [event_to_json(CompactionEvent(summary="old work summarized"))]
                + [event_to_json(AssistantMessageEvent(content=f"recent {i}")) for i in range(101, 121)]
            )
            + "\n",
            encoding="utf-8",
            newline="\n",  # .clc is BYTE-addressed (offsets), never CRLF
        )
        legacy_before = legacy.read_bytes()
        up = open_project_lazy(legacy, workspace=None)
        check(isinstance(up.log, LazyEventLog) and up.log.cpr_start() > 0,
              "legacy .clc derives its window boundary from the newest compaction")
        check(len(up.log.items()) == 1 + 20,
              "legacy window materializes only the compaction + the recent tail")
        check(
            [event_to_json(ev) for _, ev in up.log.items()]
            == [event_to_json(ev) for ev in parse_durable(legacy.read_text(encoding="utf-8"))][-len(up.log.items()):],
            "the legacy window is the tail of a full parse",
        )
        check(
            legacy.read_bytes() == legacy_before,
            "open never rewrites a legacy file (no cpr_start inserted)",
        )


def check_lazy_open_legacy_notes(config: Config) -> None:
    # 12. a [memories] section an older build wrote is not an obstacle: the open
    #     skips it (it is not an event), never rewrites it, and the log readers
    #     still show the note — the fact it carries outlives the section.
    with tempfile.TemporaryDirectory() as ptmp:
        from agent.project import open_project_lazy

        p = Path(ptmp) / "mem.clc"
        lines = [
            "# clutch project v1", "name: mem", "model: fake-model", "---",
            event_to_json(UserMessageEvent(content="task")),
        ]
        for i in range(1, 40):
            lines.append(
                event_to_json(
                    AssistantMessageEvent(content=f"work {i}")
                    if i % 2 == 0
                    else UserMessageEvent(content=f"ask {i}")
                )
            )
        lines.append(event_to_json(CompactionEvent(summary="mid summarized")))
        for i in range(40, 50):
            lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        lines.append("[memories]")
        lines.append('{"title": "a durable fact", "content": "the detail", "updated": 0}')
        lines.append(event_to_json(AssistantMessageEvent(content="after memory")))
        p.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

        proj = open_project_lazy(p, workspace=None)
        check(
            len(proj.events()) == 1 + 1 + 10,  # the compaction, the recent tail, the event after the section
            "the [memories] section is not an event (nothing parses a note as a turn)",
        )
        check(
            any(
                ev.type == "assistant_message" and getattr(ev, "content", "") == "after memory"
                for ev in proj.events()
            ),
            "events after the memory section still load",
        )
        reg = ToolRegistry(build_tools(config, log=proj.log), log=proj.log)
        ws = LocalWorkspace(ptmp)
        r = reg.execute(ws, config, "grep_memory", {"pattern": "durable fact"})
        hit = next((ln for ln in r.content.splitlines() if ln.startswith("line ")), "")
        check("[note] [Note] a durable fact: the detail" in hit, "the legacy note is a line of the log")
        # the grep -> read contract: a line number grep named is an offset read takes
        lineno = hit.split(":")[0].split()[1]
        r = reg.execute(ws, config, "read_memory", {"offset": int(lineno), "limit": 1})
        check("lines %s-%s of" % (lineno, lineno) in r.content and "the detail" in r.content,
              "read_memory opens the exact line grep_memory named")


def main() -> None:
    config = Config()
    # 1. argument parsing
    d = parse_arguments('{"path": "a.py", "content": "x"}')
    check(d == {"path": "a.py", "content": "x"}, "parse_arguments valid json")
    try:
        parse_arguments("{bad json")
        check(False, "parse_arguments rejects invalid json")
    except ParseError:
        check(True, "parse_arguments rejects invalid json")

    # 3. workspace path escape protection
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        try:
            sb.resolve("../outside.txt")
            check(False, "workspace blocks path escape")
        except ValueError:
            check(True, "workspace blocks path escape")
        p = sb.resolve("sub/x.py")
        check(str(p).startswith(tmp), "workspace resolves inside")
        try:
            sb.resolve("../../etc/passwd")
            check(False, "workspace.resolve rejects outside path")
        except ValueError:
            check(True, "workspace.resolve rejects outside path")

        # 4. tool execution + write/read roundtrip
        reg = ToolRegistry(build_tools(config))
        r = reg.execute(sb, config, "write_file", {"path": "a.txt", "content": "hello"})
        check(not r.error, "write_file ok")
        r = reg.execute(sb, config, "read_file", {"path": "a.txt"})
        check(r.content.strip() == "hello", "read_file roundtrip")
        reg.execute(sb, config, "write_file", {"path": "multi.txt", "content": "line1\nline2\nline3\nline4\nline5\n"})
        r = reg.execute(sb, config, "read_file", {"path": "multi.txt", "offset": 2, "limit": 2})
        check(
            r.content.startswith("2: line2\n3: line3") and "use offset=4 to continue" in r.content,
            "read_file line-range returns numbered slice with continue hint",
        )
        r = reg.execute(sb, config, "read_file", {"path": "multi.txt", "offset": 4, "limit": 2})
        check(r.content == "4: line4\n5: line5", "read_file range covering the tail has no footer")
        # truncation tells the model how to continue
        big_body = "".join(f"line {i}\n" for i in range(3000))
        reg.execute(sb, config, "write_file", {"path": "big.txt", "content": big_body})
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "max_chars": 2000})
        check(
            "[truncated" in r.content and "use offset=" in r.content,
            "whole-file truncation hints the next offset",
        )
        # an explicit range that cannot fit the budget is an error, not a silent cut
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "offset": 1, "limit": 3000, "max_chars": 2000})
        check(r.error and "smaller limit" in r.content, "oversized explicit range errors instead of truncating")
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "offset": 1, "limit": 100, "max_chars": 2000})
        check(not r.error, "range within budget still succeeds")
        r = reg.execute(sb, config, "grep", {"pattern": "line[23]"})
        check("multi.txt:" in r.content and "2: line2" in r.content, "grep tool finds hits with line numbers")
        r = reg.execute(sb, config, "grep", {"pattern": "no_such_token_zzz"})
        check("no matches" in r.content, "grep tool reports no matches")
        r = reg.execute(sb, config, "grep", {"pattern": "(", "path": "."})
        check(r.error, "grep tool rejects invalid regex")
        # edit_file: targeted replacement (one occurrence), diff, and error cases
        reg.execute(sb, config, "write_file", {"path": "edit.txt", "content": "alpha\nbeta\ngamma\n"})
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "beta", "new_string": "BETA"})
        check(not r.error and "+1 -1" in r.content, "edit_file replaces one occurrence with a diff")
        check((sb.root / "edit.txt").read_text() == "alpha\nBETA\ngamma\n", "edit_file applied the replacement")
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "nope", "new_string": "x"})
        check(r.error and "not found" in r.content, "edit_file reports a missing old_string")
        reg.execute(sb, config, "write_file", {"path": "dup.txt", "content": "x\ny\nx\n"})
        r = reg.execute(sb, config, "edit_file", {"path": "dup.txt", "old_string": "x", "new_string": "z"})
        check(r.error and "appears 2 times" in r.content, "edit_file rejects an ambiguous old_string")
        r = reg.execute(sb, config, "edit_file", {"path": "missing.txt", "old_string": "a", "new_string": "b"})
        check(r.error and "use write_file" in r.content, "edit_file points to write_file for new files")
        # undo stack: write/edit snapshot the previous content; restore pops it back
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "BETA", "new_string": "corrupted"})
        check(not r.error and (sb.root / "edit.txt").read_text() == "alpha\ncorrupted\ngamma\n", "edit applied")
        check(sb.restore(sb.resolve("edit.txt")) == "alpha\nBETA\ngamma\n", "workspace.restore pops the snapshot")
        check((sb.root / "edit.txt").read_text() == "alpha\nBETA\ngamma\n", "restore wrote the previous content back")
        check(sb.restore(sb.resolve("edit.txt")) == "alpha\nbeta\ngamma\n", "second restore pops the next snapshot")
        check(sb.restore(sb.resolve("edit.txt")) is None, "restore with no snapshot returns None")

        # 4b. the turn journal: roll back every file change made from one task on
        # (the UI's long-press / right-click on a sent message). The undo stack
        # above is per-file and one step deep; the journal is per TASK, keyed by
        # the log offset of the user message that started it, and it is the only
        # record that can undo a CREATION (by deleting the file).
        bare = LocalWorkspace(tmp)
        bare.record_mutation(bare.resolve("nowhere.txt"), True, "x")
        check(
            bare.rollback_anchors() == [],
            "a mutation outside a run is not journaled (no task to roll it back with)",
        )

        sb.begin_turn(100)
        reg.execute(sb, config, "write_file", {"path": "made.txt", "content": "created by task A\n"})
        reg.execute(sb, config, "write_file", {"path": "keep.txt", "content": "one\n"})
        sb.begin_turn(200)
        reg.execute(sb, config, "write_file", {"path": "keep.txt", "content": "two\n"})
        check(sb.rollback_anchors() == [100, 200], "each task that changed a file gets one journal anchor")
        report = sb.rollback_from(200)
        check(
            report == {"restored": [str(sb.resolve("keep.txt"))], "deleted": []},
            f"a rollback to the later task restores only its own write (got {report})",
        )
        check(
            (sb.root / "keep.txt").read_text() == "one\n",
            "the later write is undone to what the earlier task left",
        )
        check(sb.rollback_anchors() == [100], "the undone anchor leaves the journal")
        report = sb.rollback_from(100)
        check(
            report is not None
            and report["restored"] == []
            and sorted(Path(p).name for p in report["deleted"]) == ["keep.txt", "made.txt"],
            "a rollback to the first task deletes every file it created, newest first",
        )
        check(
            not (sb.root / "made.txt").exists() and not (sb.root / "keep.txt").exists(),
            "the files the tasks created are gone: the workspace is what it was before them",
        )
        check(
            sb.rollback_from(100) is None and sb.rollback_from(300) is None,
            "a rolled-back or never-recorded anchor reports nothing to undo",
        )
        check(sb.rollback_anchors() == [], "the journal is empty once every task is undone")
        sb.begin_turn(400)
        r = reg.execute(sb, config, "edit_file", {"path": "absent.txt", "old_string": "a", "new_string": "b"})
        check(r.error and sb.rollback_anchors() == [], "a failed write records nothing to undo")
        # read_file on a directory lists its entries
        r = reg.execute(sb, config, "read_file", {"path": "."})
        check("edit.txt" in r.content and not r.error, "read_file on a directory lists entries")
        r = reg.execute(sb, config, "read_file", {"path": ".", "offset": 1, "limit": 5})
        check(r.error and "directory" in r.content, "directory read with a range errors")
        r = reg.execute(sb, config, "run_command", {"command": "echo hi"})
        check("hi" in r.content, "run_command executes")
        r = reg.execute(sb, config, "run_command", {"command": "echo a && echo b"})
        check("a" in r.content and "b" in r.content, "run_command supports && (shell semantics)")
        r = reg.execute(sb, config, "run_command", {"command": "echo hi | tr a-z A-Z"})
        check("HI" in r.content, "run_command supports pipes")
        r = reg.execute(sb, config, "run_command", {"command": "echo data > out.txt && cat out.txt"})
        check("data" in r.content, "run_command supports redirects")
        r = reg.execute(sb, config, "run_command", {"command": "python3 -m json.tool --help 2>&1 || true"})
        check(not r.error, "run_command allows python3 -m module mode")
        r = reg.execute(sb, config, "run_command", {"command": "python3"})
        check(r.error, "run_command still blocks bare python")
        r = reg.execute(sb, config, "run_command", {"command": "nonexistent_cmd_xyz"})
        check(r.error, "run_command reports missing cmd")
        r = reg.execute(sb, config, "no_such_tool", {})
        check(r.error, "registry rejects unknown tool")
        r = reg.execute(sb, config, "write_file", {"path": "../../escape.txt", "content": "x"})
        check(r.error, "tool blocks path escape")
        r = reg.execute(sb, config, "run_command", {"command": "cat /home/user/secret.txt"})
        check(r.error, "run_command blocks absolute path escape")
        r = reg.execute(sb, config, "run_command", {"command": "cat ../../etc/passwd"})
        check(r.error, "run_command blocks .. path escape")
        r = reg.execute(sb, config, "run_command", {"command": "ls -la"})
        check(not r.error, "run_command allows normal relative commands")
        reg.execute(sb, config, "write_file", {"path": "good.py", "content": "print(1)\n"})
        r = reg.execute(sb, config, "run_command", {"command": f"{PY} good.py"})
        check(not r.error and "1" in r.content, "syntax check passes good python")
        reg.execute(sb, config, "write_file", {"path": "bad.py", "content": "if True print(1)\n"})
        r = reg.execute(sb, config, "run_command", {"command": f"{PY} bad.py"})
        check(r.error and "syntax check failed" in r.content, "syntax check rejects bad python")

    # The doom-loop guard and the turn budget are the loop's, and the loop is the
    # client's now (P4-3): agent/core/terminate.py is gone and these checks moved
    # to tests/run-limits-test.js, where the guard runs through its real ports.

    check_skills(config)

    check_permission()

    check_project_file(config)

    check_windowed_clc(config)

    check_lazy_open_legacy_notes(config)

    # 13. LLM settings surface: one flat map, legacy profiles migrate
    from agent.config import flatten_settings

    flat = {
        "base_url": "https://x.example/v1",
        "model": "m1",
        "api_key": "k1",
        "reasoning_effort": "low",
        "api_protocol": "responses",
    }
    check(flatten_settings(dict(flat)) == flat, "flat settings read through verbatim")
    check(
        flatten_settings(
            {
                "profiles": {"a": {"base_url": "u1"}, "zhipu-53": {"base_url": "u2", "model": "m2", "api_key": "k2"}},
                "active": "zhipu-53",
            }
        )
        == {"base_url": "u2", "model": "m2", "api_key": "k2"},
        "legacy profile map migrates to the active profile",
    )
    check(flatten_settings({}) == {}, "empty settings flatten to empty")
    # the client that SPENDS these knobs is the window's (ui/llm-client.js): the
    # host only persists and serves them, so the factory checks that used to live
    # here (protocol selection, missing key) moved with the loop (P4).

    old_env = {
        k: os.environ.get(k) for k in ("CLUTCH_MODEL", "CLUTCH_BASE_URL", "CLUTCH_API_KEY")
    }
    try:
        os.environ["CLUTCH_MODEL"] = "glm-5.3"
        os.environ["CLUTCH_BASE_URL"] = "https://open.bigmodel.cn/api/coding/paas/v4"
        os.environ["CLUTCH_API_KEY"] = "sk-env"
        ecfg = Config()
        check(ecfg.model == "glm-5.3" and ecfg.base_url == "https://open.bigmodel.cn/api/coding/paas/v4",
              "Config reads CLUTCH_MODEL/CLUTCH_BASE_URL")
        check(ecfg.api_key == "sk-env", "Config reads CLUTCH_API_KEY")
    finally:
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
