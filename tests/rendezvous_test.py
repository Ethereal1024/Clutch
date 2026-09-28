"""Rendezvous: the host meeting a standalone module's daemon (live, local).

Run: .venv/bin/python -m tests.rendezvous_test

This is the one host-side test that starts REAL module daemons: it pins the
frozen discovery contract (record shape, token header, health), the statement
shape a curl-driven tool relies on, the spawn-time fence, the transport each
statement runs in (the workspace's for a daemon, the app host's for a CLI), and —
the discipline every leak in this repo came from — that release() really stops
what we started.
It then drives the same statements through the registry, so the executor's path
(guard -> the component's statement, and nothing else) is pinned too: with the
component gone the host has no tool, only the component's name in a refusal.

Isolation: CLUTCH_WORKSPACE_DISCOVERY_DIR points at a temp dir, so the run
never reads or writes the user's ~/.clutch-workspace, and
CLUTCH_RENDEZVOUS_IDLE keeps a failure from leaving a long-lived daemon.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

from agent.config import Config
from agent.tools import catalog, components, modules, rendezvous
from agent.tools.inst import render, unwrap
from agent.tools.registry import ToolRegistry, build_tools
from agent.tools.transport import LocalTransport
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check, wait_gone

# the statement shape the registry's four-file tools use (see registry.py). The
# header is spelled IN the statement, out of the host's facts: {token} is a host
# var, so render quotes it, and `-H 'X-Clutch-Token: {token}'` is how a
# statement says "this header" without the host knowing what a header is.
READ_FILE = (
    "curl -sS --noproxy 127.0.0.1 -H 'Content-Type: application/json' -H 'X-Clutch-Token: {token}' "
    "--data-binary {*} http://127.0.0.1:{port}/read_file"
)
WRITE_FILE = READ_FILE.replace("/read_file", "/write_file")
# the workspace component's declaration (catalog.py), which carries the
# discovery coordinates a daemon publishes and the host reads back
WS = catalog.table()[modules.WORKSPACE]


def _call(root: str, template: str, args: dict, defaults: dict | None = None) -> dict:
    """One statement through the workspace's transport, exactly as the
    executor runs it: render -> shell -> unwrap."""
    svc = rendezvous.service(root, modules.WORKSPACE)
    command = render(template, args, vars=svc.vars(), defaults=defaults or {})
    result = LocalTransport(root).run(command, 30)
    return unwrap(result, service="the workspace service")


def _install_probe() -> None:
    """2b. A component INSTALLED for this host wins over the dev checkout, and
    its own executable wins over the table's argv template.

    The install layer (tools/components.py) lays an artifact in this host's own
    root; resolution must then run THAT, whatever shape it has — an executable
    needs neither interpreter nor checkout. Driven with a fake `#!/bin/sh` daemon
    so the words the host hands the process are observable instead of assumed
    (the flags a daemon gets are part of the launch contract, not a convention).
    """
    with tempfile.TemporaryDirectory() as host_root:
        previous = os.environ.get(components.ROOT_ENV)
        os.environ[components.ROOT_ENV] = host_root
        os.environ["CLUTCH_PROBE_ARGV"] = str(Path(host_root) / "argv.txt")
        try:
            artifact = Path(host_root) / "artifact"
            artifact.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CLUTCH_PROBE_ARGV\"\nexit 7\n",
                encoding="utf-8",
            )
            version = components.install(
                artifact,
                {"name": modules.WORKSPACE, "version": "9.9.9", "interface": catalog.DAEMON},
            )
            check(components.installed(modules.WORKSPACE) == version, "the install layer finds what it just laid down")
            resolved = rendezvous.resolve(modules.WORKSPACE)
            check(
                resolved is not None and resolved.installed and not resolved.template,
                "an installed component supersedes the checkout",
            )
            check(
                resolved.argv == (str(version / modules.WORKSPACE),),
                "the artifact's own executable supersedes the argv template",
            )

            workspace = tempfile.mkdtemp(prefix="clutch-install-probe-")
            root = str(Path(workspace).resolve())
            try:
                try:
                    rendezvous.service(workspace, modules.WORKSPACE)
                    check(False, "a daemon artifact that dies during startup is reported")
                except rendezvous.RendezvousError as err:
                    check("status 7" in str(err), "the failure carries the artifact's own exit status")
            finally:
                shutil.rmtree(workspace, ignore_errors=True)
            argv = (Path(host_root) / "argv.txt").read_text(encoding="utf-8").splitlines()
            check(argv == ["--workspace", root, "--idle", os.environ.get("CLUTCH_RENDEZVOUS_IDLE") or "600"],
                  "an installed artifact is handed the component's own flags, as words")

            cli = Path(host_root) / "cli-artifact"
            cli.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            memdir = components.install(cli, {"name": modules.MEMORY, "version": "1.0.0", "interface": catalog.CLI})
            resolved_cli = rendezvous.resolve(modules.MEMORY)
            check(
                resolved_cli is not None and resolved_cli.installed and not resolved_cli.template,
                "an installed CLI onefile supersedes the checkout template",
            )
            check(
                resolved_cli is not None and resolved_cli.argv == (str(memdir / modules.MEMORY),),
                "a CLI onefile is driven by its own executable, not {py} {script}",
            )
            check(rendezvous.available(modules.MEMORY), "so an installed CLI component IS the implementation")
            check(
                components.verify(memdir, name=modules.MEMORY, interface=catalog.DAEMON) != "",
                "a manifest contradicting the host's table is refused before use",
            )
            stray = components.component_root(modules.MEMORY) / "0.0.0-garbage"
            stray.mkdir(parents=True)
            (stray / modules.MEMORY).write_text("", encoding="utf-8")
            check(
                components.installed(modules.MEMORY) == memdir,
                "a version directory without a manifest is not an install",
            )
        finally:
            if previous is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous
            os.environ.pop("CLUTCH_PROBE_ARGV", None)
    check(
        modules.component_dir(modules.WORKSPACE) == modules.module_dir(modules.WORKSPACE),
        "the install root is host-scoped: the checkout is back once it is unset",
    )


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

    # 2b. the axes a component is described by, and the one lookup that decides
    #     where it is. WHAT it is spoken to as (interface) is a separate fact
    #     from WHOSE resources it serves (subject), which is what makes a
    #     statement legal for a given workspace at all (registry.module_blocked_reason).
    check(rendezvous.serves_workspace_fs(modules.WORKSPACE), "the workspace component serves the workspace filesystem")
    for other in (modules.MEMORY, modules.WEBSEARCH, modules.SKILLS):
        check(not rendezvous.serves_workspace_fs(other), f"{other} is not tied to the workspace's machine")
    check(not rendezvous.serves_workspace_fs("clutch-nope"), "an unknown component serves nothing")
    check(all(mod.runs_on == catalog.SELF for mod in catalog.table().values()),
          "every component in the table runs on the host that asks (the OTHER axis is unused)")
    check(all(mod.requires for mod in catalog.table().values()), "every component declares what it stands on")
    check(
        rendezvous.unavailable_reason("clutch-nope") == "unknown component: clutch-nope",
        "an unknown component says so in one sentence",
    )
    check(rendezvous.unavailable_reason(modules.WORKSPACE) == "", "the workspace component is available here")

    checkout = rendezvous.resolve(modules.MEMORY)
    if checkout is not None:  # the memory checkout may be absent on a bare host
        check(not checkout.installed and checkout.template, "the dev checkout is a template launch, not an install")
        check(
            checkout.argv == (modules.python_exe(), str(checkout.directory / "memory.py")),
            "the CLI template is the interpreter plus the checkout's entry point",
        )
        check(rendezvous.unavailable_reason(modules.MEMORY) == "", "a checked-out CLI with an interpreter is available")
    _install_probe()

    state = tempfile.mkdtemp(prefix="clutch-rendezvous-")
    workspace = tempfile.mkdtemp(prefix="clutch-ws-")
    os.environ["CLUTCH_WORKSPACE_DISCOVERY_DIR"] = state
    os.environ["CLUTCH_RENDEZVOUS_IDLE"] = "10"
    try:
        # 3. discovery: nothing published yet
        check(rendezvous._read_record(workspace, WS) is None, "no record before the first call")

        (Path(workspace) / "hello.txt").write_text("hello\n", encoding="utf-8")
        r = _call(workspace, READ_FILE, {"path": "hello.txt"}, {"max_chars": 20000})
        check(not r.error and r.content.strip() == "hello", "a rendered statement reads through the daemon")

        # 4. the published record is the frozen contract (version/port/pid/token)
        record = rendezvous._read_record(workspace, WS)
        check(record is not None and record["version"] == 1, "the daemon published a v1 record")
        check(record["workspace"] == str(Path(workspace).resolve()), "the record names the resolved workspace")
        check(rendezvous._pid_alive(record["pid"]), "the record's pid is alive")
        # the record IS the protocol the host speaks: {port, token, pid}, nothing
        # else — no health verb, no status. A second Clutch window holding only
        # this file must be able to drive the daemon, which is exactly what the
        # host's own values are checked to do here.
        svc = rendezvous._service(modules.WORKSPACE, record)
        check(
            svc.vars() == {"port": str(record["port"]), "token": record["token"], "pid": str(record["pid"])},
            "the record's facts are what a statement is handed (port/token/pid)",
        )
        command = render(READ_FILE, {"path": "hello.txt"}, vars=svc.vars(), defaults={"max_chars": 20000})
        r = unwrap(LocalTransport(workspace).run(command, 30), service="the workspace service")
        check(not r.error and r.content.strip() == "hello",
              "the record alone, with no handle, is enough to answer a statement")

        # 5. reuse: the second call rides the same daemon (the undo stack lives there)
        pid = rendezvous.service(workspace, modules.WORKSPACE).pid
        check(pid == record["pid"], "a live daemon is reused, not respawned")

        # 5b. WHERE a statement runs. A daemon statement is carried by the
        #     workspace's own transport — the loopback call is issued by the
        #     machine that owns the files, in the workspace root — while a CLI
        #     statement is carried by the app host's, whose cwd is the host's own
        #     repository. The CLI half is the latent inconsistency P1-8 records
        #     (a relative path a component names is resolved against a directory
        #     that is none of its business); what is pinned here is the contract
        #     as it stands, so changing it is a deliberate edit, not a drift.
        app_cfg = Config()
        ws_obj = LocalWorkspace(workspace)
        daemon_statement = rendezvous.prepare(modules.WORKSPACE, ws_obj, app_cfg)
        check(daemon_statement.runner is ws_obj, "a daemon statement rides the workspace's own transport")
        check(
            daemon_statement.runner.run("pwd", 10).stdout.strip() == str(Path(workspace).resolve()),
            "which runs in the workspace root, the machine that owns the files",
        )
        cli = next(
            (m.name for m in catalog.table().values() if m.interface == catalog.CLI and rendezvous.available(m.name)),
            "",
        )
        if cli:
            cli_statement = rendezvous.prepare(cli, ws_obj, app_cfg)
            check(
                cli_statement.runner.run("pwd", 10).stdout.strip() == str(modules.repo_root()),
                f"a CLI statement ({cli}) runs in the app host's own directory",
            )
        else:
            print("SKIP: no available CLI component to pin the app host's transport")

        # 6. hostile payloads survive the two escaping layers byte for byte
        payload = "中文 'quoted' \"dq\" \\ backslash\nsecond line\n"
        r = _call(workspace, WRITE_FILE, {"path": "odd.txt", "content": payload}, {})
        r = _call(workspace, READ_FILE, {"path": "odd.txt"}, {"max_chars": 20000})
        check(r.content == payload, "{*} + shq round-trip CJK, quotes, newlines")

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
        check(r.error and "protected" in r.content, "writing a fenced path is refused (77 -> error envelope)")
        kept = (Path(workspace) / "school.clc").read_text(encoding="utf-8")
        check(kept == "secret\n", "the refused write did not happen")
        command = render(READ_FILE, {"path": "."}, vars=fenced.vars(), defaults={"max_chars": 20000})
        r = unwrap(LocalTransport(workspace).run(command, 30), service="the workspace service")
        check(
            "school.clc" not in r.content and "hello.txt" in r.content,
            "a fenced file is hidden from a listing",
        )
        again = rendezvous.service(workspace, modules.WORKSPACE, protect=fence)
        check(again.pid == fenced.pid, "the fence is remembered")

        # 7b. two fences alternating: ONE replacement, then nothing. A fence is
        #     spawn-time policy, so a daemon that does not carry one is replaced
        #     — with BOTH fences — and every call after that asks for a fence
        #     the daemon already has. Keyed per fence (the old shape) this
        #     restarted on every call: 570ms each, measured, because the key
        #     nobody was asking for any more still named a dead pid.
        other = [Path(workspace) / "net-fail-fix.clc"]
        widened = rendezvous.service(workspace, modules.WORKSPACE, protect=other)
        check(widened.pid != fenced.pid, "a fence the daemon does not carry replaces it once")
        check(rendezvous.service(workspace, modules.WORKSPACE, protect=fence).pid == widened.pid,
              "the replacement covers the fence that was already there")
        check(rendezvous.service(workspace, modules.WORKSPACE, protect=other).pid == widened.pid,
              "so alternating fences stop restarting the daemon")

        # 7c. a second Clutch window knows none of this: its own tables are
        #     empty, and all it has is the record plus the note the spawning
        #     host left beside it. It rides that daemon instead of killing a
        #     healthy one — and does not call the child its own, so exiting
        #     does not take a daemon it did not start down with it.
        key = (modules.WORKSPACE, str(Path(workspace).resolve()))
        mine = rendezvous._HANDLES.pop(key)
        theirs = rendezvous.service(workspace, modules.WORKSPACE, protect=fence)
        check(theirs.pid == widened.pid, "another host process rides a daemon already fenced for it")
        check(rendezvous._HANDLES[key].proc is None, "and does not call the child its own")
        rendezvous.release_all()
        check(not wait_gone(widened.pid, 0.5), "a host exiting leaves a daemon it did not start running")
        rendezvous._HANDLES[key] = mine  # this process still owns the child it started

        # 8. a missing path is a verdict, not a transport failure
        r = _call(workspace, READ_FILE, {"path": "nope.txt"}, {"max_chars": 20000})
        check(r.error and "nope.txt" in r.content, "the module's error text reaches the model")
        # the wrong token is refused BY the daemon, and the 403 body is an
        # envelope like every other answer: no host-side health verb, no HTTP
        # status read — the model sees the daemon's own words.
        live = rendezvous.service(workspace, modules.WORKSPACE, protect=fence)
        bad = rendezvous.Service(modules.WORKSPACE, live.port, "wrong-token", live.pid)
        command = render(READ_FILE, {"path": "hello.txt"}, vars=bad.vars(), defaults={"max_chars": 20000})
        r = unwrap(LocalTransport(workspace).run(command, 30), service="the workspace service")
        check(r.error and "token" in r.content, "a wrong token is refused by the daemon's own envelope")

        # 9. release: what this process started, this process stops
        rendezvous.release(workspace, modules.WORKSPACE)
        check(wait_gone(widened.pid) and wait_gone(fenced.pid), "release() stops the daemon (no leaked process)")
        check(rendezvous._read_record(workspace, WS) is None, "the daemon unpublished its record")

        # 9b. a REPLACED daemon does not unpublish its replacement. The record is
        #     rewritten to name somebody else (this test process — alive, so the
        #     record stays valid), then the daemon we started is stopped: its
        #     last act is remove(pid=…), which sees a different pid and leaves
        #     the file alone. Without that guard the daemon winding down would
        #     delete the record of whatever took over, and the next call would
        #     spawn a second daemon for a workspace that already had one.
        successor = rendezvous.service(workspace, modules.WORKSPACE)
        record_path = rendezvous._record_path(workspace, WS)
        replaced = json.loads(record_path.read_text(encoding="utf-8"))
        replaced["pid"] = os.getpid()
        record_path.write_text(json.dumps(replaced), encoding="utf-8")
        rendezvous.release(workspace, modules.WORKSPACE)
        check(wait_gone(successor.pid), "the daemon we started is stopped")
        check(record_path.exists(), "a replaced daemon left its replacement's record standing")
        record_path.unlink()  # the rest of the run starts from nothing, as before
        rendezvous._note_path(workspace, WS).unlink(missing_ok=True)

        # 10. the registry: the SAME Tool definition the model sees, executed by
        #     the executor, reaches the machine's workspace module and comes back
        #     as its envelope. Nothing below re-implements the wiring: this is
        #     the path a real tool call takes.
        cfg = Config()
        reg = ToolRegistry(build_tools(cfg))
        ws = LocalWorkspace(workspace)
        live = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
        check(not live.error and live.content.strip() == "hello", "the registry reads through the daemon")
        check(rendezvous._read_record(workspace, WS) is not None, "the registry started the daemon it needed")

        # 11. the calls really land where the assertion says they do: written
        #     and rewritten through the daemon, read back from the disk.
        fresh = "one\ntwo\n"
        mod = reg.execute(ws, cfg, "write_file", {"path": "m1.txt", "content": fresh})
        check(not mod.error and (Path(workspace) / "m1.txt").read_text() == fresh,
              "write_file lands through the daemon")
        mod = reg.execute(ws, cfg, "edit_file", {"path": "m1.txt", "old_string": "two", "new_string": "TWO"})
        check(not mod.error and "TWO" in (Path(workspace) / "m1.txt").read_text(),
              "edit_file rewrites through the daemon")

        # 12. no component, no tool. The workspace component gone means the host
        #     has no read_file AT ALL — not a degraded one: build_tools drops the
        #     schema, and a call that still arrives is answered with the
        #     component's own name, never with a host-side stand-in.
        real_dir = modules.module_dir
        modules.module_dir = lambda name: Path(workspace) / "no-such-module" / name
        try:
            check(not rendezvous.available(modules.WORKSPACE), "a deleted component is not available")
            check("read_file" not in [t.name for t in build_tools(cfg)],
                  "the host offers no read_file with the component gone")
            gone = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
            check(gone.error and modules.WORKSPACE in gone.content,
                  "the call is answered with the component's name, never a stand-in")
        finally:
            modules.module_dir = real_dir

        # 13. the guard is host policy and rides in FRONT of either face: the
        #     module serves a path named explicitly, the host still refuses it
        protected = Path(workspace) / "school.clc"
        ws.protect(protected)
        r = reg.execute(ws, cfg, "read_file", {"path": "school.clc"})
        check(r.error and "protected" in r.content, "the guard refuses a protected read")
        r = reg.execute(ws, cfg, "write_file", {"path": "school.clc", "content": "clobbered"})
        check(r.error and "protected" in r.content, "the guard refuses a protected write")
        r = reg.execute(ws, cfg, "grep", {"pattern": "secret", "path": "school.clc"})
        check(not r.error and r.content == "(no matches)", "the guard never greps a protected file")
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
