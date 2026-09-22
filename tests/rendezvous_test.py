"""Rendezvous: the host meeting a standalone module's daemon (live, local).

Run: .venv/bin/python -m tests.rendezvous_test

This is the one host-side test that starts REAL module daemons: it pins the
frozen discovery contract (record shape, token header, health), the statement
shape a curl-driven tool relies on, the spawn-time fence, and — the discipline
every leak in this repo came from — that release() really stops what we started.
It then drives the same statements through the registry, so the executor's
precedence (guard -> module statement -> host implementation), the byte-parity
of the two faces and R2's degradation are pinned too, not just asserted in prose.

Isolation: CLUTCH_WORKSPACE_DISCOVERY_DIR points at a temp dir, so the run
never reads or writes the user's ~/.clutch-workspace, and
CLUTCH_RENDEZVOUS_IDLE keeps a failure from leaving a long-lived daemon.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

from agent.config import Config
from agent.tools import filesystem, modules, rendezvous
from agent.tools.inst import render, unwrap
from agent.tools.registry import ToolRegistry, build_default_tools
from agent.tools.transport import LocalTransport
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check

# the statement shape the registry's four-file tools use (see registry.py)
READ_FILE = (
    "curl -sS --noproxy 127.0.0.1 -H 'Content-Type: application/json' -H {auth} "
    "--data-binary {*} -w {status} http://127.0.0.1:{port}/read_file"
)
WRITE_FILE = READ_FILE.replace("/read_file", "/write_file")
# the workspace module's frozen rendezvous table entry (the host's side of R4)
WS = rendezvous._TABLE[modules.WORKSPACE]


def _call(root: str, template: str, args: dict, defaults: dict | None = None) -> dict:
    """One statement through the workspace's transport, exactly as the
    executor runs it: render -> shell -> unwrap."""
    svc = rendezvous.service(root, modules.WORKSPACE)
    command = render(template, args, vars=svc.vars(), defaults=defaults or {})
    result = LocalTransport(root).run(command, 30)
    return unwrap(result, service="the workspace service")


def _dead(pid: int, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not rendezvous._pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def main() -> int:
    if not rendezvous.available(modules.WORKSPACE):
        print("SKIP: no clutch-workspace checkout / POSIX shell / curl on this host")
        return 0

    # 1. the fence translation: the module matches several spellings of a path,
    #    so a protected path has to be fenced in all of them
    with tempfile.TemporaryDirectory() as tmp:
        globs = rendezvous.fence_globs([Path(tmp) / "school.clc"], tmp)
        check("school.clc" in globs, "the fence carries the basename spelling")
        check(str(Path(tmp) / "school.clc") in globs, "the fence carries the absolute spelling")
        outside = rendezvous.fence_globs(["/etc/passwd"], tmp)
        check(outside == ("/etc/passwd", "passwd"), "an outside path fences by name + path")
        check(rendezvous.fence_globs([], tmp) == (), "nothing protected, nothing fenced")

    # 2. a module that is not in the table / not on disk is never "available"
    check(not rendezvous.available("clutch-nope"), "an unknown module is not available")
    try:
        rendezvous.service(tempfile.gettempdir(), "clutch-nope")
        check(False, "an unknown module raises")
    except rendezvous.RendezvousError:
        check(True, "an unknown module raises")

    state = tempfile.mkdtemp(prefix="clutch-rendezvous-")
    workspace = tempfile.mkdtemp(prefix="clutch-ws-")
    os.environ["CLUTCH_WORKSPACE_DISCOVERY_DIR"] = state
    os.environ["CLUTCH_RENDEZVOUS_IDLE"] = "10"
    try:
        # 3. discovery: nothing published yet
        check(rendezvous._read_record(workspace, WS) is None, "no record before the first call")

        (Path(workspace) / "hello.txt").write_text("hello\n", encoding="utf-8")
        r = _call(workspace, READ_FILE, {"path": "hello.txt"}, {"max_chars": 20000})
        check(not r["error"] and r["content"].strip() == "hello", "a rendered statement reads through the daemon")

        # 4. the published record is the frozen contract (version/port/pid/token)
        record = rendezvous._read_record(workspace, WS)
        check(record is not None and record["version"] == 1, "the daemon published a v1 record")
        check(record["workspace"] == str(Path(workspace).resolve()), "the record names the resolved workspace")
        check(rendezvous._pid_alive(record["pid"]), "the record's pid is alive")
        check(rendezvous._healthy(rendezvous._service(modules.WORKSPACE, record)), "/health answers our protocol")

        # 5. reuse: the second call rides the same daemon (the undo stack lives there)
        pid = rendezvous.service(workspace, modules.WORKSPACE).pid
        check(pid == record["pid"], "a live daemon is reused, not respawned")

        # 6. hostile payloads survive the two escaping layers byte for byte
        payload = "中文 'quoted' \"dq\" \\ backslash\nsecond line\n"
        r = _call(workspace, WRITE_FILE, {"path": "odd.txt", "content": payload}, {})
        r = _call(workspace, READ_FILE, {"path": "odd.txt"}, {"max_chars": 20000})
        check(r["content"] == payload, "{*} + shq round-trip CJK, quotes, newlines")

        # 7. the fence: spawn-time policy, one matcher behind both faces. The
        #    module's own contract is "mutations + broad sweeps are fenced,
        #    naming a path explicitly still serves it" — the host adds its own
        #    read refusal on top (agent/tools/filesystem.guard, selfcheck).
        (Path(workspace) / "school.clc").write_text("secret\n", encoding="utf-8")
        fence = [Path(workspace) / "school.clc"]
        fenced = rendezvous.service(workspace, modules.WORKSPACE, protect=fence)
        check(fenced.pid != pid, "a changed fence replaces the daemon instead of trusting it")
        command = render(WRITE_FILE, {"path": "school.clc", "content": "clobbered"}, vars=fenced.vars())
        r = unwrap(LocalTransport(workspace).run(command, 30), service="the workspace service")
        check(r["error"] and "protected" in r["content"], "writing a fenced path is refused (77 -> error envelope)")
        kept = (Path(workspace) / "school.clc").read_text(encoding="utf-8")
        check(kept == "secret\n", "the refused write did not happen")
        command = render(READ_FILE, {"path": "."}, vars=fenced.vars(), defaults={"max_chars": 20000})
        r = unwrap(LocalTransport(workspace).run(command, 30), service="the workspace service")
        check("school.clc" not in r["content"] and "hello.txt" in r["content"], "a fenced file is hidden from a listing")
        again = rendezvous.service(workspace, modules.WORKSPACE, protect=fence)
        check(again.pid == fenced.pid, "the fence is remembered")

        # 8. a missing path is a verdict, not a transport failure
        r = _call(workspace, READ_FILE, {"path": "nope.txt"}, {"max_chars": 20000})
        check(r["error"] and "nope.txt" in r["content"], "the module's error text reaches the model")
        bad = rendezvous.Service(modules.WORKSPACE, fenced.port, "wrong-token", fenced.pid)
        check(not rendezvous._healthy(bad), "a bad token is not healthy")

        # 9. release: what this process started, this process stops
        rendezvous.release(workspace, modules.WORKSPACE)
        check(_dead(fenced.pid), "release() stops the daemon (no leaked process)")
        check(rendezvous._read_record(workspace, WS) is None, "the daemon unpublished its record")

        # 10. the registry: the SAME Tool definition the model sees, executed by
        #     the executor, reaches the machine's workspace module and comes back
        #     as its envelope. Nothing below re-implements the wiring: this is
        #     the path a real tool call takes.
        cfg = Config()
        reg = ToolRegistry(build_default_tools(cfg))
        ws = LocalWorkspace(workspace)
        live = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
        check(not live["error"] and live["content"].strip() == "hello", "the registry reads through the daemon")
        check(rendezvous._read_record(workspace, WS) is not None, "the registry started the daemon it needed")

        # 11. parity: the module face and the host face must say the same thing
        #     about the same call — the module's summary/diff is the byte-level
        #     contract (R4), and the host implementation mirrors it on purpose
        fresh = "one\ntwo\n"
        mod = reg.execute(ws, cfg, "write_file", {"path": "m1.txt", "content": fresh})
        host = filesystem.write_file(ws, cfg, "h1.txt", fresh)
        check(
            not mod["error"] and mod["content"].replace("m1.txt", "f") == host["content"].replace("h1.txt", "f"),
            "write_file (new file): the module's summary is the host's",
        )
        mod = reg.execute(ws, cfg, "write_file", {"path": "m1.txt", "content": fresh + "three\n"})
        host = filesystem.write_file(ws, cfg, "h1.txt", fresh + "three\n")
        check(
            mod["content"].replace("m1.txt", "f") == host["content"].replace("h1.txt", "f"),
            "write_file (overwrite): the module's summary is the host's",
        )
        check(
            mod["diff"].replace("m1.txt", "f") == host["diff"].replace("h1.txt", "f"),
            "write_file: the module's diff is the host's",
        )
        mod = reg.execute(ws, cfg, "edit_file", {"path": "m1.txt", "old_string": "two", "new_string": "TWO"})
        host = filesystem.edit_file(ws, cfg, "h1.txt", old_string="two", new_string="TWO")
        check(
            mod["content"].replace("m1.txt", "f") == host["content"].replace("h1.txt", "f")
            and mod["diff"].replace("m1.txt", "f") == host["diff"].replace("h1.txt", "f"),
            "edit_file: the module's summary + diff are the host's",
        )

        # 12. R2, the star's acceptance: make the module checkout vanish and the
        #     very same call still answers — from the host, indistinguishably
        real_dir = modules.module_dir
        modules.module_dir = lambda name: Path(workspace) / "no-such-module" / name
        try:
            check(not rendezvous.available(modules.WORKSPACE), "a deleted module is not available")
            gone = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
            check(not gone["error"], "read_file still answers with the module gone")
            check(gone["content"] == live["content"], "the degraded answer is byte-identical")
        finally:
            modules.module_dir = real_dir

        # 13. the guard is host policy and rides in FRONT of either face: the
        #     module serves a path named explicitly, the host still refuses it
        protected = Path(workspace) / "school.clc"
        ws.protect(protected)
        r = reg.execute(ws, cfg, "read_file", {"path": "school.clc"})
        check(r["error"] and "protected" in r["content"], "the guard refuses a protected read")
        r = reg.execute(ws, cfg, "write_file", {"path": "school.clc", "content": "clobbered"})
        check(r["error"] and "protected" in r["content"], "the guard refuses a protected write")
        r = reg.execute(ws, cfg, "grep", {"pattern": "secret", "path": "school.clc"})
        check(not r["error"] and r["content"] == "(no matches)", "the guard never greps a protected file")
        check(protected.read_text(encoding="utf-8") == "secret\n", "the refused write really did not happen")
    finally:
        rendezvous.release_all()
        os.environ.pop("CLUTCH_WORKSPACE_DISCOVERY_DIR", None)
        os.environ.pop("CLUTCH_RENDEZVOUS_IDLE", None)
        shutil.rmtree(state, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)

    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
