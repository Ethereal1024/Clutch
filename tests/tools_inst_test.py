"""Every tool's statement: one command line per call (offline), plus --live.

Run: .venv/bin/python -m tests.tools_inst_test           # offline (stub transport)
     .venv/bin/python -m tests.tools_inst_test --live    # + the real modules

The constitution this pins is one sentence: EVERY tool request is one terminal
command. So this runner walks the whole registry and checks, tool by tool, the
three facts a definition can get wrong — the statement it renders, the transport
that carries it, and the envelope its output becomes:

  * the rendered LINE. The real `inst.render` runs with the real host vars
    (`rendezvous.cli_vars` for a CLI module, a `Service`'s port/token/status for
    a daemon), and the result is compared word by word with the frozen contract:
    the curl shape for a daemon module, the module's own argv for a CLI. The
    `{*}` payload is parsed back and must carry the model's values byte for byte
    (CJK, quotes, newlines), with the host's defaults filled in underneath.
  * the TRANSPORT. A stub records the line instead of running it, so the whole
    contract is checked without a daemon, a server or the network. The timeout it
    is handed is the host's own, and a guard refusal must reach it as NO call at
    all: host policy rides in front of either face.
  * the ENVELOPE. The real `inst.unwrap` turns the stub's answer into the loop's
    {content, error, diff}: a module verdict rides a 200 body, an HTTP status is
    a transport fact, a non-zero exit is a failure whatever the body says, and a
    transport error (timeout / Stop / unreachable) is the prose the model reads.
  * R2, the star's acceptance: with a module gone, `func` — the host's own
    implementation — answers the very same call, and no tool is a dead end.

`--live` then drives the same definitions through the real modules instead of the
stub: the workspace daemon over loopback HTTP, clutch-skills' CLI (which lazily
spawns its own daemon), clutch-memory against a REAL agent server (its .clc
content service) and clutch-websearch over the network. The live section is
opt-in because it needs checkouts, a POSIX shell, curl and network.

Isolation: every daemon lives in a temp workspace and every discovery directory
is repointed at a temp dir, so the run never sees or leaks a user's daemon.
"""

from __future__ import annotations

import contextlib
import json
import os
import shlex
import signal
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

from agent.config import Config
from agent.memory import MemoryStore
from agent.tools import filesystem, modules, rendezvous
from agent.tools.registry import ToolRegistry, build_default_tools
from agent.tools.transport import CommandResult, Transport, TransportError
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check, http_post

# the daemon coordinates a stub statement is rendered with: a port nothing
# listens on (the stub never dials it) and a token the line must carry
FAKE_PORT = 51234
FAKE_TOKEN = "tok-0ff5e"
FAKE_SERVICE = rendezvous.Service(modules.WORKSPACE, FAKE_PORT, FAKE_TOKEN, os.getpid())

# one value that must survive every escaping layer: quoth the shell, quote the
# JSON body, CJK, a newline, a backslash
HOSTILE = "中文 'single' \"double\" \\ back\nsecond line\n"

# a shell-free view of a rendered line (the words the shell would hand the child)
def _words(command: str) -> list[str]:
    return shlex.split(command, posix=True)


# --------------------------------------------------------------- the harness


class Stub(Transport):
    """The transport the offline half drives: it records the line and answers
    whatever the test queued (or raises it, for a transport failure)."""

    def __init__(self, answer: CommandResult | Exception | None = None) -> None:
        self.answer = answer if answer is not None else CommandResult(0, "", "")
        self.calls: list[tuple[str, float]] = []

    def run(self, command: str, timeout: float, *, binary: bool = False, cancel=None) -> CommandResult:
        self.calls.append((command, timeout))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    @property
    def line(self) -> str:
        return self.calls[0][0] if self.calls else ""


@contextlib.contextmanager
def _offline(stub: Stub, *, available: bool = True):
    """Pin the rendezvous seam: `module_ready` answers with `available`, and
    `prepare` hands back the stub as the statement's transport.

    Only the two questions the executor asks are replaced — the host vars are
    still built by the real code (`cli_vars`, `Service.vars()`), so the line
    under test is the line a real call renders."""
    real_available, real_prepare = rendezvous.available, rendezvous.prepare

    def fake_prepare(module: str, workspace, config) -> rendezvous.Statement:
        mod = rendezvous._TABLE[module]
        if mod.kind == rendezvous.DAEMON:
            vars_ = rendezvous.Service(module, FAKE_PORT, FAKE_TOKEN, os.getpid()).vars()
        else:
            vars_ = rendezvous.cli_vars(module, config)
        return rendezvous.Statement(vars=vars_, runner=stub)

    rendezvous.available = lambda module: available
    rendezvous.prepare = fake_prepare
    try:
        yield
    finally:
        rendezvous.available, rendezvous.prepare = real_available, real_prepare


def _call(reg: ToolRegistry, ws, cfg, name, args, answer=None, *, available: bool = True):
    """One tool call through the real executor with a stubbed transport."""
    stub = Stub(answer)
    with _offline(stub, available=available):
        result = reg.execute(ws, cfg, name, args)
    return result, stub


def _payload(words: list[str]) -> dict:
    return json.loads(words[words.index("--data-binary") + 1])


def _envelope(content: str, code: int = 0, **extra) -> str:
    obj = {"content": content, "code": code}
    obj.update(extra)
    return json.dumps(obj, ensure_ascii=False)


# ------------------------------------------------------- 1. the tool table

# tool -> (module that serves it, or None for "the command IS the statement")
TABLE = {
    "read_file": modules.WORKSPACE,
    "grep": modules.WORKSPACE,
    "write_file": modules.WORKSPACE,
    "edit_file": modules.WORKSPACE,
    "run_command": None,
    "web_search": modules.WEBSEARCH,
    "web_fetch": modules.WEBSEARCH,
    "load_skill": modules.SKILLS,
    "save_memory": modules.MEMORY,
    "load_memory": modules.MEMORY,
    "search_memory": modules.MEMORY,
}


def check_table(reg: ToolRegistry, cfg: Config) -> None:
    check(sorted(reg.names()) == sorted(TABLE), "the registry carries exactly the tools this test pins")
    for name, module in TABLE.items():
        tool = reg.tool(name)
        assert tool is not None
        if module is None:
            check(tool.inst is None and tool.func is not None, f"{name}: the command IS the statement")
            continue
        check(tool.inst is not None and tool.module == module, f"{name}: one statement against {module}")
        # R2: whatever a module serves, the host can still answer alone
        check(tool.func is not None, f"{name}: the host keeps its own implementation (R2)")
    check(reg.tool("nope") is None, "an unknown tool has no definition")

    # R2 for the one thing that is DATA, not code: the library ships with the
    # clutch-skills module, so a host that cannot see it (module not checked out
    # / an empty root) loses the loader and keeps every other tool. The store is
    # handed in for the same reason the real registry gets one — memory.py's
    # tools exist only when a project is loaded; its file is never touched.
    bare_cfg = Config(skills_dir=cfg.skills_dir / "no-such-library")
    bare = ToolRegistry(build_default_tools(bare_cfg, memories=MemoryStore(str(cfg.skills_dir / "no-such.clc"))))
    check("load_skill" not in bare.names(), "a missing skill library drops the loader, not the host")
    check(sorted(bare.names()) == sorted(set(TABLE) - {"load_skill"}), "and every other tool is still there")


# ------------------------------------------- 2. the daemon line (curl, frozen)


def check_daemon_lines(reg: ToolRegistry, ws, cfg: Config) -> None:
    """The four filesystem tools: one curl line, in the frozen shape, carrying
    the model's values and the host's defaults byte for byte."""
    cases = [
        ("read_file", "/read_file", {"path": "odd name.txt"}, {"max_chars": 20000}),
        ("grep", "/grep", {"pattern": "def f", "include": "*.py"}, {"path": ".", "include": ""}),
        ("write_file", "/write_file", {"path": "a.txt", "content": HOSTILE}, {}),
        ("edit_file", "/edit_file", {"path": "a.txt", "old_string": "it's", "new_string": HOSTILE}, {}),
    ]
    for name, endpoint, args, defaults in cases:
        tool = reg.tool(name)
        assert tool is not None
        check(dict(tool.defaults or {}) == defaults, f"{name}: the host's statement defaults are pinned")
        result, stub = _call(reg, ws, cfg, name, args, CommandResult(0, '{"content":"fine"}\n200', ""))
        check(len(stub.calls) == 1, f"{name}: exactly one command per call")
        check(stub.calls[0][1] == cfg.command_timeout, f"{name}: the host's command timeout rides along")
        payload = {**defaults, **args}
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        check(
            _words(stub.line)
            == [
                "curl",
                "-sS",
                "--noproxy",
                "127.0.0.1",
                "-H",
                "Content-Type: application/json",
                "-H",
                f"{rendezvous.TOKEN_HEADER}:{FAKE_TOKEN}",
                "--data-binary",
                body,
                "-w",
                "\\n%{http_code}",
                f"http://127.0.0.1:{FAKE_PORT}{endpoint}",
            ],
            f"{name}: the curl statement is byte-for-byte the frozen contract",
        )
        check(_payload(_words(stub.line)) == payload, f"{name}: {{*}} carries the model's values + the host's defaults")
        check(not result["error"] and result["content"] == "fine", f"{name}: a 200 verdict is the result")
    # the payload is JSON, not a second escaping pass: the hostile value arrives
    # with its quotes, backslash and newline intact
    _, stub = _call(reg, ws, cfg, "write_file", {"path": "a.txt", "content": HOSTILE}, CommandResult(0, "", ""))
    check(_payload(_words(stub.line))["content"] == HOSTILE, "{*} round-trips a hostile value byte for byte")
    check("\\u" not in stub.line, "the payload keeps CJK unescaped")


# ------------------------------------------------- 3. the CLI module lines


def check_cli_lines(reg: ToolRegistry, ws, cfg: Config) -> None:
    py = modules.python_exe()
    skill_root = str(cfg.skills_dir)
    memory = [py, str(modules.module_dir(modules.MEMORY) / "memory.py")]
    search = [py, str(modules.module_dir(modules.WEBSEARCH) / "websearch.py")]
    skills = [f"PYTHONPATH={modules.module_dir(modules.SKILLS)}", py, "-m", "clutch_skills"]

    # clutch-memory: the .clc content service is THIS process, so the line names
    # the endpoint the server publishes on loopback
    base = f"http://127.0.0.1:{cfg.port}"
    cases = [
        (
            "save_memory",
            {"title": "a fact", "content": HOSTILE},
            [*memory, "--endpoint", base, "--envelope", "save", "--title", "a fact", "--content", HOSTILE],
        ),
        ("load_memory", {"name": "a fact"}, [*memory, "--endpoint", base, "--envelope", "load", "--title", "a fact"]),
        ("search_memory", {"query": "fact"}, [*memory, "--endpoint", base, "--envelope", "search", "--query", "fact"]),
        # an optional group is dropped WHOLE: an empty query is a flag-less search
        ("search_memory", {}, [*memory, "--endpoint", base, "--envelope", "search"]),
        # clutch-websearch: the host's default fills the group, so it stays
        (
            "web_search",
            {"query": "clutch agent"},
            [*search, "search", "--envelope", "--max-results", str(cfg.web_search_max_results), "clutch agent"],
        ),
        (
            "web_search",
            {"query": "q", "max_results": 3, "backend": "ddg"},
            [*search, "search", "--envelope", "--max-results", "3", "--backend", "ddg", "q"],
        ),
        (
            "web_fetch",
            {"url": "https://example.com/x?a=1&b=2"},
            [*search, "fetch", "--envelope", "--max-chars", str(cfg.read_max_chars), "https://example.com/x?a=1&b=2"],
        ),
        (
            "web_fetch",
            {"url": "https://example.com/x", "max_chars": 500, "start": 100},
            [*search, "fetch", "--envelope", "--max-chars", "500", "--start", "100", "https://example.com/x"],
        ),
        # clutch-skills: --root names the library this session was pointed at
        (
            "load_skill",
            {"name": "some-skill"},
            [*skills, "--envelope", "--root", skill_root, "show", "some-skill"],
        ),
        (
            "load_skill",
            {"name": "some-skill", "file": "resources/t.html"},
            [*skills, "--envelope", "--root", skill_root, "show", "some-skill", "--file", "resources/t.html"],
        ),
    ]
    for name, args, expected in cases:
        result, stub = _call(reg, ws, cfg, name, args, CommandResult(0, _envelope("answered"), ""))
        check(len(stub.calls) == 1, f"{name}: exactly one command per call ({args})")
        check(_words(stub.line) == expected, f"{name}: the module's argv is byte-for-byte the contract ({args})")
        check(not result["error"] and result["content"] == "answered", f"{name}: the module's envelope is the result")


# ------------------------------------------------- 4. the envelope mapping


def check_envelopes(reg: ToolRegistry, ws, cfg: Config) -> None:
    """A verdict rides the transport's 200; a transport fact is not a verdict."""
    # the module's verdict, reached over a 200 transport
    body = json.dumps({"content": "file not found: nope.txt", "error": True, "diff": ""}) + "\n200"
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "nope.txt"}, CommandResult(0, body, ""))
    check(r["error"] and r["content"] == "file not found: nope.txt", "a 200 whose envelope says 'failed' is a verdict")

    # the module's diff rides through untouched
    body = json.dumps({"content": "changed", "error": False, "diff": "@@ -1 +1 @@"}) + "\n200"
    r, _ = _call(reg, ws, cfg, "write_file", {"path": "a.txt", "content": "x"}, CommandResult(0, body, ""))
    check(r["diff"] == "@@ -1 +1 @@", "the module's diff reaches the loop")

    # an HTTP status is the TRANSPORT's verdict (no service spoke our protocol)
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, CommandResult(0, "bad or missing token\n403", ""))
    check(r["error"] and "HTTP 403" in r["content"], "a non-200 status is reported as the service's answer")
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, CommandResult(7, "\n000", "curl: (7) connect failed"))
    check(
        r["error"] and "could not reach" in r["content"] and "the clutch-workspace service" in r["content"],
        "status 000 (nothing listening) reads as unreachable, naming the service",
    )

    # a CLI module's {content, code} envelope (choice a): code != 0 is a refusal
    r, _ = _call(reg, ws, cfg, "search_memory", {"query": "x"}, CommandResult(1, _envelope("ERROR: boom", 1), ""))
    check(r["error"] and r["content"] == "ERROR: boom", "a CLI refusal ({content, code:1}) is error-as-data")
    r, _ = _call(reg, ws, cfg, "load_skill", {"name": "x"}, CommandResult(1, _envelope("ERROR: unknown skill: 'x'", 1), ""))
    check(r["error"] and "unknown skill" in r["content"], "the skills CLI's refusal reaches the model verbatim")
    r, _ = _call(reg, ws, cfg, "save_memory", {"title": "t", "content": "c"}, CommandResult(0, _envelope("OK: saved"), ""))
    check(not r["error"] and r["content"] == "OK: saved", "a CLI success ({content, code:0}) is a plain result")

    # a service bug cannot hide behind an optimistic envelope
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, CommandResult(3, json.dumps({"content": "ok?"}), ""))
    check(r["error"], "a non-zero exit beats an optimistic envelope")
    # a plain-text CLI answers without any envelope at all
    r, _ = _call(reg, ws, cfg, "web_search", {"query": "q"}, CommandResult(0, "1. result\n2. result\n", ""))
    check(not r["error"] and "1. result" in r["content"], "non-JSON stdout is the content")
    r, _ = _call(reg, ws, cfg, "web_search", {"query": "q"}, CommandResult(2, "", "usage: clutch-websearch ..."))
    check(r["error"] and "exit 2" in r["content"] and "usage" in r["content"], "a failed command reports exit + stderr")

    # transport failures are prose the model can act on
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, TransportError("timed out", timeout=True))
    check(r["error"] and "timed out" in r["content"].lower(), "a timeout is reported as the budget, not a crash")
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, TransportError("stop", aborted=True))
    check(r["error"] and r["content"], "a Stop is reported as the user stopping the call")
    r, _ = _call(reg, ws, cfg, "read_file", {"path": "a.txt"}, TransportError("spawn failed"))
    check(r["error"] and "spawn failed" in r["content"], "an executor failure names itself")


# ------------------------------------------- 5. guards + R2 (no module)


def check_guards_and_fallback(reg: ToolRegistry, cfg: Config) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        ws = LocalWorkspace(tmp)
        (Path(tmp) / "hello.txt").write_text("hello\n", encoding="utf-8")
        protected = Path(tmp) / "school.clc"
        protected.write_text("secret\n", encoding="utf-8")
        ws.protect(protected)

        # host policy rides in FRONT of the statement: no command is run at all
        r, stub = _call(reg, ws, cfg, "read_file", {"path": "school.clc"}, CommandResult(0, "leak\n200", ""))
        check(r["error"] and "protected" in r["content"], "read_file refuses a protected path")
        check(stub.calls == [], "the refusal happens before the module is ever asked")
        r, stub = _call(reg, ws, cfg, "write_file", {"path": "school.clc", "content": "x"})
        check(r["error"] and "protected" in r["content"] and stub.calls == [], "write_file refuses a protected path first")
        r, stub = _call(reg, ws, cfg, "edit_file", {"path": "school.clc", "old_string": "a", "new_string": "b"})
        check(r["error"] and stub.calls == [], "edit_file refuses a protected path first")
        r, stub = _call(reg, ws, cfg, "grep", {"pattern": "secret", "path": "school.clc"})
        check(not r["error"] and r["content"] == "(no matches)", "grep answers a protected path with the empty sweep")
        check(stub.calls == [], "grep never asks the module about a protected file")
        check(protected.read_text(encoding="utf-8") == "secret\n", "nothing was written")

        # R2: the module is gone -> the host's own implementation answers, and
        # the statement is not even rendered
        r, stub = _call(reg, ws, cfg, "read_file", {"path": "hello.txt"}, available=False)
        host = filesystem.read_file(ws, cfg, path="hello.txt")
        check(stub.calls == [], "with the module gone no command is rendered")
        check(not r["error"] and r["content"] == host["content"], "read_file degrades to the host byte for byte")
        r, stub = _call(reg, ws, cfg, "search_memory", {"query": "x"}, available=False)
        check(stub.calls == [], "a CLI module that is gone is not invoked either")
        check(not r["error"] and r["content"] == "(no memories found)", "search_memory degrades to the host's store")
        r, _ = _call(reg, ws, cfg, "write_file", {"path": "b.txt", "content": "hi\n"}, available=False)
        host = filesystem.write_file(ws, cfg, path="h.txt", content="hi\n")
        check(
            r["content"].replace("b.txt", "f") == host["content"].replace("h.txt", "f")
            and r["diff"].replace("b.txt", "f") == host["diff"].replace("h.txt", "f"),
            "write_file degrades with its summary and diff",
        )
        # the library itself belongs to clutch-skills, but the host still serves
        # the file it read at session start when that module is gone
        from agent.skills import load_skill_library

        names = load_skill_library(cfg.skills_dir).names()
        if names:
            r, stub = _call(reg, ws, cfg, "load_skill", {"name": names[0]}, available=False)
            check(stub.calls == [] and not r["error"] and bool(r["content"]), "load_skill degrades to the host's library")
        else:
            print(f"SKIP: no skills under {cfg.skills_dir}")


# --------------------------------------- 6. the model's arguments themselves


def check_arguments(reg: ToolRegistry, ws, cfg: Config) -> None:
    # a missing required argument is error-as-data, and no command is rendered
    r, stub = _call(reg, ws, cfg, "load_memory", {}, CommandResult(0, "x", ""))
    check(r["error"] and "name" in r["content"] and stub.calls == [], "a missing argument fails closed, before any line")
    r, stub = _call(reg, ws, cfg, "web_search", {}, CommandResult(0, "x", ""))
    check(r["error"] and stub.calls == [], "a missing query fails closed too")

    # a hostile value in a CLI's positional slot stays one literal word
    result, stub = _call(
        reg, ws, cfg, "web_search", {"query": "'; rm -rf / #"}, CommandResult(0, _envelope("ok"), "")
    )
    check(_words(stub.line)[-1] == "'; rm -rf / #", "a shell-metacharacter query stays one word")
    check("rm -rf" in _words(stub.line)[-1], "and it is still the model's own text")
    check(not result["error"], "the call itself is unaffected")

    # string-typed numbers are coerced to the schema's integer before rendering
    _, stub = _call(reg, ws, cfg, "web_search", {"query": "q", "max_results": "3"}, CommandResult(0, _envelope("ok"), ""))
    check(_words(stub.line)[_words(stub.line).index("--max-results") + 1] == "3", "a numeric argument is rendered as the schema's integer")

    # unknown tool: the registry says so instead of crashing
    r = reg.execute(ws, cfg, "nope", {})
    check(r["error"] and "nope" in r["content"], "an unknown tool is reported as error-as-data")


# ------------------------------------------------------------- the live half


def _wait_dead(pid: int, seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not rendezvous._pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def live_workspace(cfg: Config) -> None:
    """The daemon module, over real loopback HTTP, driven by the registry."""
    state = tempfile.mkdtemp(prefix="clutch-inst-discovery-")
    os.environ["CLUTCH_WORKSPACE_DISCOVERY_DIR"] = state
    os.environ["CLUTCH_RENDEZVOUS_IDLE"] = "10"
    try:
        with tempfile.TemporaryDirectory(prefix="clutch-inst-ws-") as tmp:
            (Path(tmp) / "hello.txt").write_text("hello\n", encoding="utf-8")
            ws = LocalWorkspace(tmp)
            reg = ToolRegistry(build_default_tools(cfg))
            r = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
            check(not r["error"] and r["content"].strip() == "hello", "live: read_file answers through the daemon")
            service = rendezvous.service(tmp, modules.WORKSPACE)
            check(rendezvous._healthy(service), "live: the daemon this call started is healthy")
            r = reg.execute(ws, cfg, "write_file", {"path": "made.txt", "content": HOSTILE})
            check(not r["error"] and (Path(tmp) / "made.txt").read_text(encoding="utf-8") == HOSTILE, "live: a hostile payload lands byte for byte")
            r = reg.execute(ws, cfg, "grep", {"pattern": "back"})
            check(not r["error"] and "made.txt" in r["content"], "live: grep sweeps through the daemon")
            rendezvous.release_all()
            check(_wait_dead(service.pid), "live: release_all() stopped the daemon (no leak)")
    finally:
        rendezvous.release_all()
        os.environ.pop("CLUTCH_WORKSPACE_DISCOVERY_DIR", None)
        os.environ.pop("CLUTCH_RENDEZVOUS_IDLE", None)


def live_skills(cfg: Config) -> None:
    """clutch-skills: the CLI spawns its own daemon for the root it serves."""
    from agent.skills import load_skill_library

    lib = load_skill_library(cfg.skills_dir)
    if not lib.skills:
        print(f"SKIP: no skills under {cfg.skills_dir}")
        return
    first = lib.names()[0]
    state = tempfile.mkdtemp(prefix="clutch-inst-skills-")
    os.environ["CLUTCH_SKILLS_DISCOVERY_DIR"] = state
    daemon_pid = 0
    try:
        with tempfile.TemporaryDirectory(prefix="clutch-inst-ws-") as tmp:
            ws = LocalWorkspace(tmp)
            reg = ToolRegistry(build_default_tools(cfg))
            r = reg.execute(ws, cfg, "load_skill", {"name": first})
            served = (lib.get(first).dir / "SKILL.md").read_text(encoding="utf-8")
            check(not r["error"] and r["content"] == served, "live: load_skill serves the skill file byte for byte")

            # the CLI lazily started a daemon for the root and published it
            record = None
            for f in Path(state).glob("s-*.json"):
                record = json.loads(f.read_text(encoding="utf-8"))
            check(record is not None and rendezvous._pid_alive(record["pid"]), "live: the skills CLI started its daemon")
            check(record is not None and record["root"] == str(Path(cfg.skills_dir).resolve()), "live: it serves this session's root")
            daemon_pid = int(record["pid"]) if record else 0

            r = reg.execute(ws, cfg, "load_skill", {"name": "no-such-skill-xyz"})
            check(r["error"] and "no-such-skill-xyz" in r["content"], "live: an unknown skill comes back as a refusal")
            r = reg.execute(ws, cfg, "load_skill", {"name": first, "file": "SKILL.md"})
            check(not r["error"] and r["content"] == served, "live: an explicit --file reads the same file")
    finally:
        # SIGTERM is the daemon's graceful exit (it unpublishes on the way out)
        if daemon_pid:
            with contextlib.suppress(OSError):
                os.kill(daemon_pid, signal.SIGTERM)
            check(_wait_dead(daemon_pid), "live: the skills daemon exits on SIGTERM (no leak)")
        os.environ.pop("CLUTCH_SKILLS_DISCOVERY_DIR", None)


def live_memory() -> None:
    """clutch-memory against a REAL agent server: the module writes the .clc
    through the server's generic content endpoints, and the host's own reader
    sees what it wrote."""
    from agent.project import open_project_lazy
    from agent.server import Broadcaster, RunState, build

    port = _free_port()
    cfg = Config(port=port)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)
    try:
        with tempfile.TemporaryDirectory(prefix="clutch-inst-mem-") as tmp:
            st, body = http_post(f"http://127.0.0.1:{port}/api/project/new", {"dir": tmp, "name": "live"})
            check(st == 200, "live: the test server created a project")
            clc = Path(json.loads(body)["project"])
            ws = LocalWorkspace(tmp)
            reg = ToolRegistry(build_default_tools(cfg, memories=state.project.memories))

            r = reg.execute(ws, cfg, "save_memory", {"title": "live fact", "content": "a durable 中文 fact"})
            check(not r["error"] and "live fact" in r["content"], "live: save_memory writes through the real server")
            r = reg.execute(ws, cfg, "load_memory", {"name": "live fact"})
            check(not r["error"] and "a durable 中文 fact" in r["content"], "live: load_memory reads it back")
            r = reg.execute(ws, cfg, "search_memory", {"query": "durable"})
            check(not r["error"] and "live fact" in r["content"], "live: search_memory finds it by content")
            r = reg.execute(ws, cfg, "load_memory", {"name": "nope"})
            check(r["error"] and "nope" in r["content"], "live: an unknown title is a refusal, not a crash")

            # the host's own reader sees the module's write: the file format IS
            # the shared contract (the in-process store is the stale one)
            reopened = open_project_lazy(clc)
            check(reopened.memories.get("live fact") is not None, "live: the host reads the memory the module wrote")
    finally:
        srv.shutdown()
        srv.server_close()


def live_web() -> None:
    """clutch-websearch over the network."""
    cfg = Config()
    with tempfile.TemporaryDirectory(prefix="clutch-inst-ws-") as tmp:
        ws = LocalWorkspace(tmp)
        reg = ToolRegistry(build_default_tools(cfg))
        r = reg.execute(ws, cfg, "web_search", {"query": "python shlex split", "max_results": 3})
        check("could not reach" not in r["content"], "live: the websearch CLI answered (not a transport failure)")
        if r["error"]:
            print(f"WARN: no search backend answered this run: {r['content'][:120]}")
        else:
            check(len(r["content"]) > 20, "live: web_search returned entries")
        r = reg.execute(ws, cfg, "web_fetch", {"url": "https://example.com/", "max_chars": 2000})
        check(not r["error"] and "example" in r["content"].lower(), "live: web_fetch returns the page text")


def live(cfg: Config) -> None:
    if not rendezvous.available(modules.WORKSPACE):
        print("SKIP: live workspace module unavailable")
    else:
        live_workspace(cfg)
    if rendezvous.available(modules.SKILLS):
        live_skills(cfg)
    else:
        print("SKIP: live skills module unavailable")
    if rendezvous.available(modules.MEMORY):
        live_memory()
    else:
        print("SKIP: live memory module unavailable")
    if rendezvous.available(modules.WEBSEARCH):
        live_web()
    else:
        print("SKIP: live websearch module unavailable")


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    cfg = Config()
    with tempfile.TemporaryDirectory() as tmp:
        # a real (empty) store, so the memory tools exist and their host face is
        # the actual closure; the store's file is never touched offline
        reg = ToolRegistry(build_default_tools(cfg, memories=MemoryStore(str(Path(tmp) / "offline.clc"))))
        ws = LocalWorkspace(tmp)
        check_table(reg, cfg)
        check_daemon_lines(reg, ws, cfg)
        check_cli_lines(reg, ws, cfg)
        check_envelopes(reg, ws, cfg)
        check_guards_and_fallback(reg, cfg)
        check_arguments(reg, ws, cfg)
        if "--live" in argv:
            live(cfg)
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
