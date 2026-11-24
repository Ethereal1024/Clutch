"""Golden capture for the host tool face (M3: `ui/host/tools.js`).

The tool face is contract: the model reads the prose and the schema, the
sentence a refusal returns is what it learns from, and the recall output is what
a resumed session sees of its own log. `agent/tools/host.py`, `registry.py`,
`gates.py`, `filesystem.py`, `shell.py` and `recall.py` are that contract on
deployment A/C; `tests/host-tools.test.js` replays the same calls against
`ui/host/tools.js`.

    .venv/bin/python -m tests.tools_capture            # write the fixture
    .venv/bin/python -m tests.tools_capture --check    # regenerate+compare

The workspace here is a STUB, and deliberately so (the same choice
`tests/permission_capture.py` makes): the far-root host judges paths LEXICALLY,
so the only facts `run_command` reads from a workspace are the root, the far
user's home, the POSIX scratch trio, the protected set and the exec seam. The
stub keeps those in `PurePosixPath` flavor, exactly like `RemoteWorkspace`, and
the JS replay builds the same thing out of `ui/host/fs.js` (whose `resolve` is
the port of the Python method `run_command` calls).

What is captured, and why each part is contract:

  * `declarations` / `prompts` — the three host declarations as DATA, in work and
    chat mode: the schema the model sees, the prose file each one's description
    comes from, the policy word, the gate, the UI block.
  * `registry` — the wiring (`_wire`/`_bootstrap`): names, schema, access /
    access_arg / path_arg, `ui()` with its two derived keys (`mutates`, `undo`),
    and the fields a caller may read off a `Tool`.
  * `classify` / `tokenize` — chat mode's read-only verdict, compared with its
    detail string, and the `shlex` token list the verdict is computed from.
  * `blocked` — the commands that hang in a non-TTY pipe, as the rendered
    sentence `run_command` returns.
  * `execute` — whole calls through `ToolRegistry.execute`, which is the seam
    the run loop calls: coercion, the guards, the render templates, the
    transport mapping, truncation, and the four error envelopes.
  * `recall` — `grep_memory` / `read_memory` over ONE real log built here
    (durable events, a legacy memory note, a compaction, lines a reader skips),
    with the exact bytes so the JS replay scans the same file.

A note on two deliberate non-goals. `python3 x.py` is syntax-checked by
`shell.py` with `compile()`; there is no `compile()` on the far-root host, so the
call is not captured here (the JS file documents the divergence and offers
`ctx.syntaxCheck`). And an invalid regex's detail is the ENGINE's sentence
("missing ), unterminated subpattern" vs JavaScript's), so those cases capture
the prefix only and the replay compares that much.

`TZ` is pinned to UTC on both sides: `recall._record` stamps a line with
`time.localtime`, so the fixture's timestamps only reproduce under one zone.
"""

from __future__ import annotations

import base64
import json
import os
import posixpath
import time
from pathlib import Path, PurePosixPath

os.environ["TZ"] = "UTC"
time.tzset()

from agent.config import Config  # noqa: E402
from agent.core.lazy import _SECTION  # noqa: E402
from agent.events import (  # noqa: E402
    AssistantMessageEvent,
    CompactionEvent,
    FinalEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
    event_to_json,
)
from agent.tools import filesystem, host, recall, registry, shell  # noqa: E402
from agent.tools.localshell import LocalShell  # noqa: E402
from agent.tools.transport import CommandResult, TransportError  # noqa: E402
from agent.tools.workspace import POSIX_SCRATCH_DIRS, Workspace  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "tools" / "expected.json"

ROOT = "/home/u/proj"
HOME = "/home/u"
LOG_PATH = f"{ROOT}/demo.clc"

POSIX = LocalShell(argv=None, posix=True, name="posix-sh")


class FarWorkspace(Workspace):
    """A far root, lexically: nothing here touches this machine's filesystem.

    Only the members `run_command` and the guards call are real; everything a
    file operation would need raises, so a call that reaches one is a bug in the
    capture rather than a silent read of this machine.
    """

    def __init__(self, results: dict | None = None) -> None:
        super().__init__(root=ROOT)
        self._results = results or {}
        self.ran: list[str] = []
        self.protect(PurePosixPath(LOG_PATH))

    def _root_path(self, root: str):
        return PurePosixPath(root)

    def _scratch_dirs(self):
        return tuple(PurePosixPath(s) for s in POSIX_SCRATCH_DIRS)

    def realpath(self, path):
        return PurePosixPath(posixpath.normpath(str(path).replace("\\", "/")))

    def norm_join(self, base: str, token: str):
        return PurePosixPath(posixpath.normpath(posixpath.join(str(base), str(token))))

    def home(self):
        return PurePosixPath(HOME)

    def exec_shell(self):
        return POSIX

    def run(self, command: str, timeout: float, cancel=None):
        self.ran.append(command)
        answer = self._results.get(command)
        if answer is None:
            raise AssertionError(f"the capture has no canned result for {command!r}")
        kind = answer.get("error")
        if kind:
            if kind["type"] == "transport":
                raise TransportError(
                    kind["message"],
                    timeout=bool(kind.get("timeout")),
                    aborted=bool(kind.get("aborted")),
                )
            raise RuntimeError(kind["message"])
        return CommandResult(answer["code"], answer["stdout"], answer["stderr"])

    # the abstract file operations: this stub answers policy questions only
    def read(self, path: str) -> str:  # pragma: no cover
        raise NotImplementedError

    def read_range(self, path: str, lo: int, hi: int) -> bytes:  # pragma: no cover
        raise NotImplementedError

    def size(self, path: str) -> int:  # pragma: no cover
        raise NotImplementedError

    def write(self, path: str, content: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def append_line(self, path: str, line: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def write_at(self, path: str, offset: int, data: bytes) -> None:  # pragma: no cover
        raise NotImplementedError

    def delete(self, path: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def list(self, path: str) -> list[str]:  # pragma: no cover
        raise NotImplementedError

    def grep(
        self, pattern: str, path: str = ".", include: str | None = None
    ) -> list[tuple[str, int, str]]:  # pragma: no cover
        raise NotImplementedError


class StubLog:
    """The log reader's four facts (`recall._scan` reads no more)."""

    def __init__(self, path: str, header: bytes, region: bytes) -> None:
        self.path = path
        self._base = len(header)
        self._region = region

    def event_start(self) -> int:
        return self._base

    def file_bytes(self) -> int:
        return self._base + len(self._region)

    def read_raw(self, lo: int, hi: int) -> bytes:
        lo = max(int(lo), self._base)
        hi = min(int(hi), self.file_bytes())
        if lo >= hi:
            return b""
        return self._region[lo - self._base : hi - self._base]


# --------------------------------------------------------------- the config


def config(mode: str = "work") -> Config:
    cfg = Config()
    cfg.mode = mode
    return cfg


def config_values(cfg: Config) -> dict:
    return {
        "mode": cfg.mode,
        "command_timeout": cfg.command_timeout,
        "output_limit": cfg.output_limit,
        "output_head": cfg.output_head,
        "output_tail": cfg.output_tail,
        "blocked_prefixes": list(cfg.blocked_prefixes),
    }


# ---------------------------------------------------------- the canned execs

LONG_STDOUT = "".join(f"{i:05d} line\n" for i in range(1000))  # 11000 chars > 6000
LONG_STDERR = "".join(f"warn {i}\n" for i in range(900))  # 7200 chars > 6000

RUN_RESULTS: dict[str, dict] = {
    "ls -la": {"code": 0, "stdout": "alpha.txt\nbeta.txt\n", "stderr": ""},
    "cat alpha.txt": {"code": 0, "stdout": "", "stderr": ""},
    "cat 'a b.txt'": {"code": 0, "stdout": "spaced\n", "stderr": ""},
    "cat /tmp/x.log": {"code": 0, "stdout": "scratch\n", "stderr": ""},
    "git status": {"code": 0, "stdout": "## main\n", "stderr": ""},
    "python3 -c 'print(1)'": {"code": 0, "stdout": "1\n", "stderr": ""},
    "python3 -m http.server": {"code": 0, "stdout": "", "stderr": "listening\n"},
    "seq 1 1000": {"code": 0, "stdout": LONG_STDOUT, "stderr": ""},
    "cat big.log": {"code": 0, "stdout": LONG_STDOUT, "stderr": LONG_STDERR},
    "false": {"code": 1, "stdout": "", "stderr": "boom\n"},
    "grep -rn nothing .": {"code": 2, "stdout": "", "stderr": ""},
    "cat mixed": {"code": 7, "stdout": "out\n", "stderr": "err\n"},
    # `vi` with no argument is NOT blocked (the list matches a prefix followed by
    # a space, so only `vi file` hangs) — and `makefile` is a different word, a
    # multi-line read is one command to the exec, and `A=1 ls` is read-only. All
    # four REACH the exec, which is what these cases are here to show.
    "vi": {"code": 0, "stdout": "", "stderr": ""},
    "makefile": {"code": 0, "stdout": "all:\n", "stderr": ""},
    "ls\ncat a.txt": {"code": 0, "stdout": "alpha.txt\n", "stderr": ""},
    "A=1 ls": {"code": 0, "stdout": "alpha.txt\n", "stderr": ""},
    "sleep 100": {"error": {"type": "transport", "message": "timed out", "timeout": True}},
    "long-job": {"error": {"type": "transport", "message": "stopped", "aborted": True}},
    "bridge": {"error": {"type": "transport", "message": "unreachable"}},
    "explode": {"error": {"type": "failure", "message": "disk gone"}},
}

RUN_CASES: list[dict] = [
    # ---- work mode: what reaches the exec, and what the model reads back
    {"name": "plain listing", "mode": "work", "args": {"command": "ls -la"}},
    {"name": "success with no output", "mode": "work", "args": {"command": "cat alpha.txt"}},
    {"name": "quoted path with a space", "mode": "work", "args": {"command": "cat 'a b.txt'"}},
    {"name": "scratch path is allowed", "mode": "work", "args": {"command": "cat /tmp/x.log"}},
    {"name": "truncated stdout", "mode": "work", "args": {"command": "seq 1 1000"}},
    {"name": "truncated stdout and stderr", "mode": "work", "args": {"command": "cat big.log"}},
    {"name": "non-zero exit", "mode": "work", "args": {"command": "false"}},
    {"name": "non-zero exit with no output", "mode": "work", "args": {"command": "grep -rn nothing ."}},
    {"name": "non-zero exit with both streams", "mode": "work", "args": {"command": "cat mixed"}},
    {"name": "timeout", "mode": "work", "args": {"command": "sleep 100"}},
    {"name": "aborted by Stop", "mode": "work", "args": {"command": "long-job"}},
    {"name": "transport unreachable", "mode": "work", "args": {"command": "bridge"}},
    {"name": "exec raised", "mode": "work", "args": {"command": "explode"}},
    # ---- blocked: commands that hang in a non-TTY pipe
    {"name": "blocked vim", "mode": "work", "args": {"command": "vim notes.txt"}},
    {"name": "blocked vi", "mode": "work", "args": {"command": "vi"}},
    {"name": "blocked less", "mode": "work", "args": {"command": "less big.log"}},
    {"name": "blocked tail -f", "mode": "work", "args": {"command": "tail -f x.log"}},
    {"name": "blocked make", "mode": "work", "args": {"command": "make build"}},
    {"name": "bare python", "mode": "work", "args": {"command": "python3"}},
    {"name": "python file is not blocked", "mode": "work", "args": {"command": "python3 -m http.server"}},
    {"name": "blocked prefixes are whole words", "mode": "work", "args": {"command": "makefile"}},
    # ---- the shell text the guard reads
    {"name": "empty command", "mode": "work", "args": {"command": ""}},
    {"name": "whitespace command", "mode": "work", "args": {"command": "   "}},
    {"name": "unbalanced quote", "mode": "work", "args": {"command": "ls 'unbalanced"}},
    {"name": "relative escape", "mode": "work", "args": {"command": "cat ../../etc/passwd"}},
    {"name": "absolute escape", "mode": "work", "args": {"command": "cat /etc/passwd"}},
    {"name": "protected project log", "mode": "work", "args": {"command": "cat demo.clc"}},
    {"name": "protected project log, absolute", "mode": "work", "args": {"command": f"cat {LOG_PATH}"}},
    # ---- chat mode: default deny, and the two sentences that say why
    {"name": "chat read", "mode": "chat", "args": {"command": "ls -la"}},
    {"name": "chat write", "mode": "chat", "args": {"command": "rm -rf build"}},
    {"name": "chat unknown", "mode": "chat", "args": {"command": "frobnicate"}},
    {"name": "chat redirect", "mode": "chat", "args": {"command": "echo hi > out.log"}},
    {"name": "chat segment after a separator", "mode": "chat", "args": {"command": "ls && rm x"}},
    {"name": "chat path-invoked binary", "mode": "chat", "args": {"command": "./script.sh"}},
    {"name": "chat substitution", "mode": "chat", "args": {"command": "echo $(rm x)"}},
    {"name": "chat git read", "mode": "chat", "args": {"command": "git status"}},
    {"name": "chat git write", "mode": "chat", "args": {"command": "git commit -m x"}},
    {"name": "chat curl output", "mode": "chat", "args": {"command": "curl -o out http://x"}},
    {"name": "chat find delete", "mode": "chat", "args": {"command": "find . -delete"}},
    {"name": "chat multi-line read", "mode": "chat", "args": {"command": "ls\ncat a.txt"}},
    {"name": "chat multi-line write", "mode": "chat", "args": {"command": "ls\nrm x"}},
    {"name": "chat var assignment", "mode": "chat", "args": {"command": "A=1 ls"}},
    {"name": "chat unbalanced quote", "mode": "chat", "args": {"command": "cat 'x"}},
    {"name": "chat empty", "mode": "chat", "args": {"command": ""}},
    # ---- the registry seam: names, coercion, unknown tools
    {"name": "unknown tool", "mode": "work", "tool": "not_a_tool", "args": {"command": "ls"}},
    {"name": "command passed as a string", "mode": "work", "args": {"command": "ls -la"}},
]

CLASSIFY_CASES = [
    "ls -la",
    "ls && cat a.txt",
    "ls || rm x",
    "ls; rm -rf build",
    "ls | wc -l",
    "A=1 ls",
    "A=1 B=2",
    "git status",
    "git -C sub log",
    "git commit -m x",
    "git branch --show-current",
    "git",
    "sed s/a/b/ x",
    "sed -i s/a/b/ x",
    "sed --in-place=.bak s/a/b/ x",
    "curl http://x",
    "curl -o out http://x",
    "curl -so out http://x",
    "curl --remote-name http://x",
    "find . -name '*.py'",
    "find . -name '*.py' -delete",
    "find . -fprint out",
    "./script.sh",
    "/bin/ls",
    "echo hi > out.log",
    "echo hi < in.log",
    "cat 'a>b.txt'",
    "rm -rf /",
    "make",
    "frobnicate",
    "",
    "   ",
    "echo $(date)",
    "echo `date`",
    "cat 'unclosed",
    "ls\ncat a.txt",
    "ls\nrm x",
    "ls\rrm x",
    "ls\vcat a",
    "git status; git commit -m x",
    "cd src && ls",
    "sudo apt install x",
]

TOKENIZE_CASES = [
    "ls -la",
    "ls && cat a",
    "ls||cat b",
    "ls |& wc",
    "ls;;cat",
    "a&&b",
    "A=1 ls",
    "cat 'a b.txt'",
    'cat "a b.txt"',
    "cat a\\ b.txt",
    'echo "a\\"b"',
    'echo "a\\nb"',
    'echo "C:\\x"',
    "echo $HOME/x",
    "grep -rn 'x;y' .",
    'echo "a;b"',
    "ls # comment",
    "printf '%s\\n' hi",
    "",
    "   ",
    "''",
    '""',
    "cat 'unclosed",
    'cat "unclosed',
    "ls \\",
    "ls \\\ncat",
    "ls\fcat",
    "ls\u00a0cat",
    "ls\tcat",
]


# ------------------------------------------------------------- the log bytes

HEADER = "# Clutch project log\nname: demo\nmodel: \ncpr_start: 0000000000\n---\n"


def _json_line(**data) -> bytes:
    return (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")


def log_lines() -> list[bytes]:
    """The event region, line by line — durable events a reader shows, beside
    every line a reader must SKIP (the section marker, a corrupt line, a JSON
    object that is not an event, a delta, an unknown type, an empty body)."""
    lines: list[bytes] = []
    lines.append(_json_line(type="user_message", content="fix the parser", timestamp=1_700_000_000, id="u1"))
    lines.append(
        _json_line(
            type="assistant_message",
            content="I will read a.py, then fix it.",
            tool_calls=[],
            reasoning="",
            timestamp=1_700_000_010,
            id="a1",
        )
    )
    lines.append(
        _json_line(
            type="tool_call",
            name="read_file",
            arguments='{"path": "a.py"}',
            tool_call_id="c1",
            ui={},
            path_arg="path",
            timestamp=1_700_000_020,
            id="t1",
        )
    )
    lines.append(
        _json_line(
            type="tool_result",
            tool_call_id="c1",
            content="line one\nline two\nline three — with a dash\n",
            is_error=False,
            diff="",
            timestamp=1_700_000_030,
            id="r1",
        )
    )
    # a legacy memory line: an older build wrote the body alone (recall._record note)
    lines.append(_json_line(title="Decision", content="use POSIX"))
    # a note with no title is not a line
    lines.append(_json_line(title="", content="lost"))
    # every kind of line a reader must skip
    lines.append(b"[memories]\n")
    lines.append(b"---\n")
    lines.append(b"\n")
    lines.append(b"{not json\n")
    lines.append(b"[1, 2, 3]\n")
    lines.append(_json_line(foo="bar"))
    lines.append(_json_line(type="text_delta", content="streamed", timestamp=1_700_000_040, id="d1"))
    lines.append(_json_line(type="wat", content="unknown", timestamp=1_700_000_050, id="w1"))
    lines.append(_json_line(type="assistant_message", content="", timestamp=1_700_000_060, id="a2"))
    # a compaction summary is a line (durable), and the timestamp is 0 on purpose:
    # recall stamps `localtime(timestamp or 0)`, i.e. the epoch
    lines.append(
        _json_line(type="compaction", summary="earlier work: the parser", timestamp=0, id="p1")
    )
    lines.append(_json_line(type="final", status="completed", summary="parser fixed", timestamp=1_700_000_070, id="f1"))
    # the long body a page clips, and a multi-line body whose matched LINE is a hit
    long_line = "x" * 1500
    lines.append(
        _json_line(type="tool_result", tool_call_id="c2", content=long_line, is_error=False, diff="", timestamp=1_700_000_080, id="r2")
    )
    lines.append(
        _json_line(
            type="tool_result",
            tool_call_id="c3",
            content="header\n" + "payload " * 60 + "\nfooter\n",
            is_error=False,
            diff="",
            timestamp=1_700_000_090,
            id="r3",
        )
    )
    # a unicode body, and the page-budget filler
    lines.append(
        _json_line(type="user_message", content="中文任务：修复解析器", timestamp=1_700_000_100, id="u2")
    )
    for i in range(18):
        lines.append(
            _json_line(
                type="tool_result",
                tool_call_id=f"f{i}",
                content=f"filler {i:02d} " + "y" * 980,
                is_error=False,
                diff="",
                timestamp=1_700_000_110 + i,
                id=f"g{i}",
            )
        )
    return lines


class LOG:
    header = HEADER.encode("utf-8")
    region = b"".join(log_lines())


def _stub_log() -> StubLog:
    return StubLog(LOG_PATH, LOG.header, LOG.region)


# ---------------------------------------------------------------- the capture


def _envelope(result) -> dict:
    return {"content": result.content, "error": bool(result.error), "diff": result.diff}


def _tool_facts(tool) -> dict:
    """What a tool is, in one shape for both kinds.

    The kind decides who carries the call out, and that is the TYPE, so the
    facts report the kind once and then only the fields that kind owns: a
    system tool's `needs_log`, an extension tool's `owner`/`template`/`defaults`.
    The other kind's slots are null rather than absent, so the fixture has one
    key set to compare instead of two.
    """
    if not isinstance(tool, registry.Tool):
        raise TypeError(f"{type(tool).__name__} is not a wired Tool")
    # One class, two kinds: `inst` is the component's statement (an extension
    # tool), `host` the host's own implementation (a system tool). The wiring
    # refuses a tool with neither (build_tools), so this split is total.
    extension = tool.inst is not None
    system = not extension
    return {
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
        "access": tool.access,
        "access_arg": tool.access_arg,
        "cancelable": tool.cancelable,
        "snapshot": tool.snapshot,
        "snapshot_arg": tool.snapshot_arg,
        "guard": tool.guard.__name__ if tool.guard is not None else None,
        "kind": "system" if system else "extension",
        "needs_log": tool.needs_log if system else None,
        "owner": (tool.module or "") if extension else None,
        "template": tool.inst if extension else None,
        "defaults": dict(tool.defaults or {}) if extension else None,
        "ui": dict(tool.ui),
    }


def _registry_facts(tools, log) -> dict:
    reg = registry.ToolRegistry(tools, log)
    names = reg.names()
    return {
        "names": names,
        "schemas": reg.schemas(),
        "access": {name: reg.access(name) for name in names},
        "access_arg": {name: reg.access_arg(name) for name in names},
        "path_arg": {name: reg.path_arg(name) for name in names},
        "ui": {name: reg.ui(name) for name in names},
        "tools": {name: _tool_facts(reg.tool(name)) for name in names},
        # a name no tool declares: the defaults, and no invented `mutates`
        "unknown": {
            "access": reg.access("not_a_tool"),
            "access_arg": reg.access_arg("not_a_tool"),
            "path_arg": reg.path_arg("not_a_tool"),
            "ui": reg.ui("not_a_tool"),
            "tool": reg.tool("not_a_tool"),
        },
    }


def capture() -> dict:
    work = config("work")
    chat = config("chat")

    declarations = {}
    for name, cfg in (("work", work), ("chat", chat)):
        declarations[name] = [
            {
                "name": declared.name,
                "declaration": dict(declared.declaration),
                "needs_log": declared.needs_log,
            }
            for declared in host.declarations(cfg)
        ]

    log = _stub_log()
    registries = {
        "work_no_log": _registry_facts(registry._bootstrap(work, None), None),
        "work": _registry_facts(registry._bootstrap(work, log), log),
        "chat": _registry_facts(registry._bootstrap(chat, log), log),
    }

    classify = [
        {"command": command, "verdict": shell.classify_command(command)[0], "detail": shell.classify_command(command)[1]}
        for command in CLASSIFY_CASES
    ]
    tokenize = [
        {"command": command, "tokens": shell._tokenize(command)} for command in TOKENIZE_CASES
    ]

    blocked_cases = [
        "vim notes.txt",
        "vim",
        "vi x",
        "emacs x",
        "nano x",
        "less x",
        "more x",
        "tail -f x",
        "top",
        "htop",
        "make build",
        "makefile",
        "  ls -la",
        "python3",
        "python",
        "python3 x.py",
        "python3 -m http.server",
        "python3 -c 'print(1)'",
        "python3 -O x.py",
        "python3 -",
        "python3 'unbalanced",
        "",
        "   ",
        "LS",
    ]
    blocked = [
        {"command": command, "reason": shell._blocked_reason(work, command)} for command in blocked_cases
    ]

    # whole calls through the seam the loop uses
    exec_cases = []
    for case in RUN_CASES:
        cfg = work if case["mode"] == "work" else chat
        workspace = FarWorkspace(RUN_RESULTS)
        reg = registry.ToolRegistry(registry._bootstrap(cfg, None), None)
        name = case.get("tool", "run_command")
        result = reg.execute(workspace, cfg, name, dict(case["args"]), None)
        exec_cases.append(
            {
                "name": case["name"],
                "mode": case["mode"],
                "tool": name,
                "args": case["args"],
                "ran": list(workspace.ran),
                "result": _envelope(result),
            }
        )

    # coercion: the declared types, the spellings each accepts, the refusals
    coerce_cases = []
    reg = registry.ToolRegistry(registry._bootstrap(work, None), None)
    run_tool = reg.tool("run_command")
    coerce_values = [
        {"command": "ls"},
        {"command": 5},
        {"command": None},
        {"command": ["ls"]},
    ]
    for args in coerce_values:
        try:
            out = registry.ToolRegistry._coerce_types(run_tool, dict(args))
            coerce_cases.append({"args": args, "out": out})
        except Exception as error:  # noqa: BLE001 - the refusal is the point
            coerce_cases.append({"args": args, "error": type(error).__name__})
    # read_memory's two integer arguments: every spelling int() takes and refuses
    memory_reg = registry.ToolRegistry(registry._bootstrap(work, log), log)
    read_tool = memory_reg.tool("read_memory")
    for value in [2, 2.9, True, False, "3", " 4 ", "3.0", "0x10", "", None, [], 1.0, -1]:
        args = {"limit": value, "offset": value}
        try:
            out = registry.ToolRegistry._coerce_types(read_tool, dict(args))
            coerce_cases.append({"tool": "read_memory", "args": args, "out": out})
        except Exception as error:  # noqa: BLE001
            coerce_cases.append({"tool": "read_memory", "args": args, "error": type(error).__name__})

    # the guards (`filesystem.py`): the host's own refusal, before any statement
    guard_cases = []
    guard_workspace = FarWorkspace(RUN_RESULTS)
    for access, arg in (("read", "path"), ("write", "path"), ("sweep", "path"), ("read", "file")):
        guard = {"read": filesystem.guard_read, "write": filesystem.guard_write, "sweep": filesystem.guard_grep}[access]
        for value in ("demo.clc", "./demo.clc", "a.py", "../x", "/etc/passwd", ""):
            key = arg
            args = {key: value}
            out = guard(guard_workspace, work, args, arg)
            guard_cases.append(
                {
                    "access": access,
                    "arg": arg,
                    "args": args,
                    "result": None if out is None else _envelope(out),
                }
            )

    # the gates (`gates.py`): "" / "always" / a named condition / an unknown word
    gates = []
    for word in ("", "always", "project", "skills", "nonsense"):
        gates.append(
            {
                "gate": word,
                "log": None,
                "ok": registry._gate_ok(word, work, None),
            }
        )
    for word in ("", "always", "project", "nonsense"):
        gates.append(
            {
                "gate": word,
                "log": "path",
                "ok": registry._gate_ok(word, work, log),
            }
        )

    # recall: both readers over the same bytes, through the registry (coercion,
    # the project gate and the log handed in) exactly as the loop calls them
    recall_reg = registry.ToolRegistry(registry._bootstrap(work, log), log)
    recall_workspace = FarWorkspace(RUN_RESULTS)
    grep_cases = [
        {"name": "a word", "args": {"pattern": "fix"}},
        {"name": "include filter", "args": {"pattern": "fix", "include": "tool_*"}},
        {"name": "include matches", "args": {"pattern": "line", "include": "tool_*"}},
        {"name": "hit cap", "args": {"pattern": "a", "max_hits": 1}},
        {"name": "case insensitive", "args": {"pattern": "(?i)FIX"}},
        {"name": "legacy note", "args": {"pattern": "decis"}},
        {"name": "no match", "args": {"pattern": "nothing-here"}},
        {"name": "invalid regex", "args": {"pattern": "("}},
        {"name": "empty pattern", "args": {"pattern": ""}},
        {"name": "multiline anchor", "args": {"pattern": "^\\[Tool", "include": "tool_*"}},
        {"name": "matched line inside a body", "args": {"pattern": "line three"}},
        {"name": "unicode", "args": {"pattern": "解析器"}},
        {"name": "string max_hits", "args": {"pattern": "y", "max_hits": "3"}},
        {"name": "zero max_hits means the default", "args": {"pattern": "y", "max_hits": 0}},
        {"name": "max_hits capped", "args": {"pattern": "y", "max_hits": 5000}},
        {"name": "an include that matches nothing", "args": {"pattern": ".", "include": "note"}},
    ]
    grep = []
    for case in grep_cases:
        result = recall_reg.execute(recall_workspace, work, "grep_memory", dict(case["args"]), None)
        grep.append({**case, "result": _envelope(result)})

    read_cases = [
        {"name": "tail by default", "args": {}},
        {"name": "tail with a limit", "args": {"limit": 3}},
        {"name": "from the first line", "args": {"offset": 1, "limit": 3}},
        {"name": "from a middle line", "args": {"offset": 2}},
        {"name": "past the end", "args": {"offset": 999}},
        {"name": "offset zero", "args": {"offset": 0}},
        {"name": "negative offset", "args": {"offset": -3}},
        {"name": "limit zero means the default", "args": {"limit": 0}},
        {"name": "limit capped", "args": {"limit": 5000}},
        {"name": "string arguments", "args": {"offset": "2", "limit": "2"}},
        {"name": "one line", "args": {"limit": 1}},
        {"name": "the page budget", "args": {"offset": 1, "limit": 200}},
    ]
    read = []
    for case in read_cases:
        result = recall_reg.execute(recall_workspace, work, "read_memory", dict(case["args"]), None)
        read.append({**case, "result": _envelope(result)})

    # no log open: the readers are not offered at all (the gate), and a call
    # that reaches one anyway reads the one sentence they have
    no_log_reg = registry.ToolRegistry(registry._bootstrap(work, None), None)
    no_log = {
        "names": no_log_reg.names(),
        "grep": _envelope(no_log_reg.execute(recall_workspace, work, "grep_memory", {"pattern": "x"}, None)),
        "read": _envelope(no_log_reg.execute(recall_workspace, work, "read_memory", {}, None)),
    }

    return {
        "workspace": {"root": ROOT, "home": HOME, "protected": [LOG_PATH], "scratch": list(POSIX_SCRATCH_DIRS)},
        "config": config_values(work),
        "chat_config": config_values(chat),
        "declarations": declarations,
        "registry": registries,
        "classify": classify,
        "tokenize": tokenize,
        "blocked": blocked,
        "execute": exec_cases,
        "run_results": RUN_RESULTS,
        "coerce": coerce_cases,
        "guards": guard_cases,
        "gates": gates,
        "recall": {
            "path": LOG_PATH,
            "header_b64": base64.b64encode(LOG.header).decode("ascii"),
            "region_b64": base64.b64encode(LOG.region).decode("ascii"),
            "lines": len([line for line in LOG.region.split(b"\n") if line]),
            "grep": grep,
            "read": read,
            "no_log": no_log,
        },
    }


def verify(fixture: dict) -> int:
    expected = json.loads(OUT.read_text("utf-8"))
    if expected != fixture:
        print("tool-face goldens DO NOT reproduce:")
        for key in fixture:
            if expected.get(key) != fixture[key]:
                print(f"  {key}: differs")
        return 1
    print(
        "tool-face goldens reproduce: "
        f"{len(fixture['execute'])} calls, {len(fixture['recall']['grep'])} greps, "
        f"{len(fixture['recall']['read'])} pages, {len(fixture['classify'])} verdicts"
    )
    return 0


def main(argv: list[str]) -> int:
    fixture = capture()
    if "--check" in argv:
        return verify(fixture)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
