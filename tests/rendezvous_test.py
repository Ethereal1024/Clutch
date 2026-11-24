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
The switch is pinned the same way, and in the one place it can bite: a component
this host has STOPPED offers no tools, and nothing else on the machine can stand
in for it (which is the whole reason the check is asked before resolution, not
inside it).

Isolation: CLUTCH_WORKSPACE_DISCOVERY_DIR points at a temp dir, so the run
never reads or writes the user's ~/.clutch-workspace, and
CLUTCH_RENDEZVOUS_IDLE keeps a failure from leaving a long-lived daemon.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from agent.config import Config
from agent.tools import catalog, components, modules, rendezvous, statement
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
    """2b. A component is run from THIS host's install root, and its own
    executable wins over the table's argv template.

    The install layer (tools/components.py) lays an artifact in this host's own
    root, and the record it lands is the whole declaration: an executable needs
    neither interpreter nor checkout, and there is no other directory a launch
    could come from. Driven with a fake `#!/bin/sh` daemon so the words the host
    hands the process are observable instead of assumed (the flags a daemon gets
    are part of the launch contract, not a convention).
    """
    # the declaration the probe installs is the one this host already runs: a
    # component's shape is read out of the install it holds, and nowhere else
    held = components.resolve(modules.WORKSPACE)
    assert held is not None, "the caller checked the workspace component is available here"
    declared = {key: value for key, value in held[1].items() if key not in ("version", components.DIGEST_FIELD)}
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
                {
                    **declared,
                    "name": modules.WORKSPACE,
                    "version": "9.9.9",
                    "launch": {**declared.get("launch", {}), "binary": modules.WORKSPACE},
                },
            )
            check(components.installed(modules.WORKSPACE) == version, "the install layer finds what it just laid down")
            resolved = rendezvous.resolve(modules.WORKSPACE)
            check(
                resolved is not None and not resolved.template,
                "an installed component is what this host runs, and its artifact needs no template",
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
            clidir = components.install(
                cli, {"name": modules.WEBSEARCH, "version": "1.0.0", "launch": {"binary": modules.WEBSEARCH}}
            )
            resolved_cli = rendezvous.resolve(modules.WEBSEARCH)
            check(
                resolved_cli is not None and not resolved_cli.template,
                "an installed CLI onefile is run as itself, not through a template",
            )
            check(
                resolved_cli is not None and resolved_cli.argv == (str(clidir / modules.WEBSEARCH),),
                "a CLI onefile is driven by its own executable, not {py} {script}",
            )
            check(rendezvous.available(modules.WEBSEARCH), "so an installed CLI component IS the implementation")
            check(
                components.verify(clidir, name=modules.WORKSPACE) != "",
                "a manifest that is not the component this host asked for is refused before use",
            )
            stray = components.component_root(modules.WEBSEARCH) / "0.0.0-garbage"
            stray.mkdir(parents=True)
            (stray / modules.WEBSEARCH).write_text("", encoding="utf-8")
            check(
                components.installed(modules.WEBSEARCH) == clidir,
                "a version directory without a manifest is not an install",
            )
        finally:
            if previous is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous
            os.environ.pop("CLUTCH_PROBE_ARGV", None)
    # the override is an env var, so it scoped resolution to the temp root: once
    # it is unset the probe's version is invisible. What is left is THIS host's
    # own install root and nothing else — a component this host has not installed
    # is not here, whatever sits beside the repo.
    own = components.installed(modules.WORKSPACE)
    check(own != version, "the install root is host-scoped: the probe install is gone once the env is unset")
    check(
        modules.component_dir(modules.WORKSPACE) == own,
        "and where a module is run from is the install this host holds, or nowhere at all",
    )


def _disabled_probe() -> None:
    """2c. STOPPING a component takes its tools away without taking its bytes.

    The bit lives in the host's own table (components.set_disabled) and is asked
    BEFORE resolution picks a copy to run (rendezvous.unavailable_reason), which
    is the whole point of the placement: a stopped component has no tools while
    its bytes are still on the host, and a call that arrives anyway is answered
    with the reason rather than driven. Asked after resolution instead, a host
    would go on handing the model a tool the page says is stopped — the one
    reading the flag exists to prevent.

    Nothing here is destroyed and nothing is confirmed: the payload is checked
    byte for byte across a stop and a start, because the switch is reversible,
    which is also why the page confirms an install and a removal but not this.
    """
    with tempfile.TemporaryDirectory() as host_root:
        previous = os.environ.get(components.ROOT_ENV)
        os.environ[components.ROOT_ENV] = host_root
        try:
            stopped = f"{modules.WEBSEARCH} is disabled on this host (its tools are off; the bytes stay)"
            artifact = Path(host_root) / "cli-artifact"
            artifact.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            payload = components.install(
                artifact, {"name": modules.WEBSEARCH, "version": "1.0.0", "launch": {"binary": modules.WEBSEARCH}}
            )
            digest = components.installed_digest(modules.WEBSEARCH)
            check(
                "disabled" not in rendezvous.unavailable_reason(modules.WEBSEARCH),
                "nothing is stopped to begin with",
            )

            verdict = components.set_disabled(modules.WEBSEARCH)
            check(
                verdict == {"status": "disabled", "name": modules.WEBSEARCH, "disabled": True},
                "stopping a component is a verdict, not an assumption that it worked",
            )
            check(
                rendezvous.unavailable_reason(modules.WEBSEARCH) == stopped
                and not rendezvous.available(modules.WEBSEARCH),
                "a stopped component's tools are gone, and the sentence says why",
            )
            check(
                (payload / modules.WEBSEARCH).is_file() and components.installed_digest(modules.WEBSEARCH) == digest,
                "and not one byte of it moved: stopping is not a removal",
            )
            check(
                [record for record in components.inventory() if record["name"] == modules.WEBSEARCH]
                == [
                    {
                        "name": modules.WEBSEARCH,
                        "version": "1.0.0",
                        "digest": digest,
                        "disabled": True,
                    }
                ],
                "it is still HELD — listed, marked stopped, its payload and digest intact",
            )

            back = components.set_disabled(modules.WEBSEARCH, False)
            check(
                back == {"status": "enabled", "name": modules.WEBSEARCH, "disabled": False},
                "and driving it again is the same verb the other way: a stopped component is not a lost one",
            )
            check(
                "disabled" not in rendezvous.unavailable_reason(modules.WEBSEARCH)
                and components.installed_digest(modules.WEBSEARCH) == digest,
                "with its tools back and its bytes still the same ones",
            )

            # the copy a host would run is decided AFTER the switch, so taking
            # the payload away (a hand-deleted install root, the state nothing in
            # Clutch creates but nothing guards against either) must leave
            # NOTHING to resolve: the install root is the only place a launch
            # comes from, so there is no checkout to fall back to — least of all
            # one of a component the user stopped.
            ws_artifact = Path(host_root) / "daemon-artifact"
            ws_artifact.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            ws_payload = components.install(
                ws_artifact, {"name": modules.WORKSPACE, "version": "9.9.9", "launch": {"binary": modules.WORKSPACE}}
            )
            check(rendezvous.resolve(modules.WORKSPACE) is not None, "a component this host holds is what it would run")
            components.set_disabled(modules.WORKSPACE)
            shutil.rmtree(ws_payload)
            check(
                rendezvous.resolve(modules.WORKSPACE) is None,
                "with the payload gone there is nothing left to run, checkout or not",
            )
            check(
                rendezvous.unavailable_reason(modules.WORKSPACE) == f"unknown component: {modules.WORKSPACE}",
                "and a component whose bytes are gone is not here at all — not merely stopped",
            )
        finally:
            if previous is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous


def _interpreter_probe() -> None:
    """2a. WHICH python drives a `-m` component, and whether this host can say it
    has one at all.

    A frozen build's sys.executable is the app (it would relaunch the UI), so the
    interpreter is CLUTCH_PYTHON, then PATH, then a LOGIN SHELL. The last one is
    the reported bug: a packaged app inherits the PATH of whatever launched it,
    which is not the PATH the machine's own shell has — on the host this came
    from, `python3` was /root/miniconda3/bin/python3, reachable only from a login
    shell, so a component that was installed and healthy (clutch-workspace, with
    four tools) was dropped as "no interpreter that can run it" and its tools
    vanished with it while the page still said "installed".

    Driven with the answers a shell can give — a path, no path, and text that is
    not one — and nothing is started: the shell call is a fake, and the path it
    "finds" is this process's own interpreter, so the executable test is real.
    """
    real_which, real_run = modules.shutil.which, modules.subprocess.run
    real_frozen = getattr(sys, "frozen", False)
    real_override = os.environ.pop("CLUTCH_PYTHON", None)
    asked: list[list[str]] = []
    bash = shutil.which("bash") or "/bin/bash"

    class _Answer:
        def __init__(self, text: str) -> None:
            self.stdout = text.encode("utf-8")

    def fake_run(argv, **kwargs):
        asked.append([*argv, f"timeout={kwargs.get('timeout')}"])
        return _Answer(FOUND[0])

    def fake_which(name):
        if name == "bash":
            return BASH[0]
        return PATH_CANDIDATE[0] if name == PATH_CANDIDATE[1] else None

    FOUND: list[str] = [""]  # what the fake login shell answers
    PATH_CANDIDATE: list[str | None] = [None, ""]  # what `which` answers, and for which name
    BASH: list[str | None] = [bash]  # whether this host has a shell to ask at all
    try:
        modules.shutil.which, modules.subprocess.run = fake_which, fake_run

        # 2a-i. a source checkout: its own interpreter, and no shell is asked
        if real_frozen:
            del sys.frozen
        asked.clear()
        check(
            modules.python_exe() == sys.executable and modules.python_missing() is False,
            "a source checkout is driven by its own interpreter",
        )
        check(not asked, "…and nothing is asked of a shell to find it")

        # 2a-ii. packaged, and PATH answers: that is the interpreter, and the shell
        #        is not spent on a question already answered
        sys.frozen = True
        modules._INTERPRETER[:] = []
        PATH_CANDIDATE[:] = ["/usr/bin/python3", "python3"]
        check(modules.python_exe() == "/usr/bin/python3", "a packaged host takes the python on PATH")
        check(modules.python_missing() is False, "…and says it has one")
        check(not asked, "…without asking a shell for a second opinion")

        # 2a-iii. packaged, PATH is the bare one a packaged app inherits, and a LOGIN
        #         shell names the machine's own interpreter — the reported case
        modules._INTERPRETER[:] = []
        PATH_CANDIDATE[:] = [None, ""]
        FOUND[0] = str(Path(sys.executable))
        check(
            modules.python_exe() == str(Path(sys.executable)),
            "a login shell's python is the interpreter when the inherited PATH has none",
        )
        check(modules.python_missing() is False, "…so the component is drivable, which is what its tools hang on")
        check(
            asked
            and asked[0][:3] == ["bash", "-lc", modules.LOGIN_PROBE]
            and asked[0][3] == f"timeout={modules.LOGIN_PROBE_TIMEOUT}",
            "the question is the login shell's own `command -v`, under a wall",
        )
        # ...one resolution per process: the two answers are the same answer, and
        # the shell is not asked again (it costs a process, and it cannot change)
        spent = len(asked)
        PATH_CANDIDATE[:] = ["/elsewhere/python3", "python3"]
        check(
            modules.python_exe() == str(Path(sys.executable)) and modules.python_missing() is False,
            "the resolution is memoized: the command line and the verdict cannot disagree",
        )
        check(len(asked) == spent, "…and the shell is asked once, not once per question")

        # 2a-iv. a shell that answers with something which is not an interpreter:
        #         an alias/function, a relative path, or a file that is not a python
        for junk, why in (
            ("python3 not found", "the shell's own error text"),
            ("alias python3='python3.12'", "an alias, which no command line can run"),
            ("bin/python3", "a path that is not absolute"),
            (str(Path(shutil.which("sh") or "/bin/sh")), "an executable that is not a python"),
        ):
            modules._INTERPRETER[:] = []
            PATH_CANDIDATE[:] = [None, ""]
            FOUND[0] = junk
            check(modules.python_missing() is True, f"a login shell answering {why} is not an interpreter")
            check(
                modules.python_exe() == sys.executable,
                "…and the bundle's own executable is named only as the last resort it is",
            )

        # 2a-v. no shell to ask (a phone, a minimal host): nothing is invented and
        #       nothing is started
        modules._INTERPRETER[:] = []
        PATH_CANDIDATE[:] = [None, ""]
        BASH[0] = None
        asked.clear()
        check(modules.python_missing() is True, "a host with no shell to ask has no interpreter to name")
        check(not asked, "…and no process is spent trying to ask one")

        # 2a-vi. CLUTCH_PYTHON is the explicit knob and outranks both searches
        modules._INTERPRETER[:] = []
        PATH_CANDIDATE[:] = ["/usr/bin/python3", "python3"]
        BASH[0] = bash
        os.environ["CLUTCH_PYTHON"] = "/opt/py/bin/python3"
        try:
            check(modules.python_exe() == "/opt/py/bin/python3", "CLUTCH_PYTHON is the interpreter, said out loud")
            check(modules.python_missing() is False, "…and a host holding it is never 'missing one'")
        finally:
            os.environ.pop("CLUTCH_PYTHON", None)
    finally:
        modules.shutil.which, modules.subprocess.run = real_which, real_run
        modules._INTERPRETER[:] = []
        if not real_frozen and getattr(sys, "frozen", None):
            del sys.frozen
        if real_override is not None:
            os.environ["CLUTCH_PYTHON"] = real_override


def main() -> int:
    # 2a. which interpreter a packaged host drives a `-m` component with — asked
    #     first, because everything below is a component this host can only drive
    #     when it has one
    _interpreter_probe()

    if not rendezvous.available(modules.WORKSPACE):
        print("SKIP: clutch-workspace is not installed for this host / no POSIX shell or curl")
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
    #     where it is. Whether it has a process HERE at all is derived from what it
    #     contributes (`service`/`launch` or the client's `entry`), and that is a
    #     separate fact from WHOSE resources it serves (subject), which is what
    #     makes a statement legal for a given workspace at all
    #     (registry.module_blocked_reason). What the two predicates below read is
    #     both axes together: the workspace's own subject, served from HERE or from
    #     the far end of a channel.
    check(rendezvous.serves_workspace_fs(modules.WORKSPACE), "the workspace component serves the workspace filesystem")
    for other in (modules.WEBSEARCH, modules.SKILLS):
        check(not rendezvous.serves_workspace_fs(other), f"{other} is not tied to the workspace's machine")
    check(not rendezvous.serves_workspace_fs("clutch-nope"), "an unknown component serves nothing")
    # the OTHER half of the same axis: the same filesystem, reached from ANOTHER
    # machine (clutch-ssh-workspace, a client plugin over the ssh tunnel). It is
    # the first declaration in this repo with no process here at all, which is why
    # the check below no longer claims that axis is unused — and since 0.2.0 it
    # says so by DECLARING the workspace's own subject and no process here (an
    # `entry` and nothing else), which is what makes it the frontend half rather
    # than the backend one; `foreign-fs` is the word 0.1.x used for the same thing.
    ssh_workspace = "clutch-ssh-workspace"
    ssh_mod = catalog.table().get(ssh_workspace)
    check(ssh_mod is not None and ssh_mod.client_side, "the ssh plugin declares no process on this host")
    check(rendezvous.serves_foreign_fs(ssh_workspace), "the ssh plugin serves the root's filesystem from another machine")
    for other in (modules.WORKSPACE, modules.WEBSEARCH, modules.WEBSEARCH, modules.SKILLS):
        check(not rendezvous.serves_foreign_fs(other), f"{other} is not a filesystem on another machine")
    check(not rendezvous.serves_foreign_fs("clutch-nope"), "an unknown component serves nothing there either")
    elsewhere = [mod.name for mod in catalog.table().values() if mod.client_side]
    check(elsewhere == [ssh_workspace],
          f"exactly one component in the table runs somewhere else, and it is the ssh plugin ({elsewhere})")
    check(all(mod.requires for mod in catalog.table().values() if mod.runs_here),
          "every component the host drives declares what it stands on")
    check(
        rendezvous.unavailable_reason("clutch-nope") == "unknown component: clutch-nope",
        "an unknown component says so in one sentence",
    )
    check(rendezvous.unavailable_reason(modules.WORKSPACE) == "", "the workspace component is available here")

    # 2c. the two launch shapes one declaration can produce, and which one THIS
    #     host gets. Every resolution comes out of the install root now, so the
    #     TEMPLATE shape is asked of a checkout directory directly (a checkout is
    #     a place to build an artifact from, and its shape is what the artifact
    #     will have) — a dev box with the component installed would otherwise be
    #     asserting the install's shape here.
    skills_mod = catalog.table()[modules.SKILLS]
    checkout_dir = modules.module_dir(modules.SKILLS)
    if checkout_dir.is_dir():  # the skills checkout may be absent on a bare host
        rendered = rendezvous.render_launch(skills_mod, checkout_dir, components.read_manifest(checkout_dir))
        check(rendered is not None and rendered[1], "the dev checkout is a template launch, not an install")
        check(
            # the module the checkout's own component.json names: a component that
            # ships Python is started as `python -m`, never as a script path
            rendered[0] == (modules.python_exe(), "-m", "clutch_skills"),
            "the template is the interpreter plus the component's own module",
        )
    resolved_checkout = rendezvous.resolve(modules.SKILLS)
    if resolved_checkout is not None:  # absent on a host with nothing installed
        check(
            resolved_checkout.directory == components.installed(modules.SKILLS),
            "what the host runs is the version directory its install holds",
        )
        check(
            rendezvous.unavailable_reason(modules.SKILLS) == "",
            "a module with an interpreter is available",
        )
    _install_probe()
    _disabled_probe()

    state = tempfile.mkdtemp(prefix="clutch-rendezvous-")
    workspace = tempfile.mkdtemp(prefix="clutch-ws-")
    os.environ["CLUTCH_WORKSPACE_DISCOVERY_DIR"] = state
    os.environ["CLUTCH_RENDEZVOUS_IDLE"] = "10"
    try:
        # 3. discovery: nothing published yet
        check(rendezvous._read_record(workspace, WS.service) is None, "no record before the first call")

        (Path(workspace) / "hello.txt").write_text("hello\n", encoding="utf-8")
        r = _call(workspace, READ_FILE, {"path": "hello.txt"}, {"max_chars": 20000})
        check(not r.error and r.content.strip() == "hello", "a rendered statement reads through the daemon")

        # 4. the published record is the frozen contract (version/port/pid/token)
        record = rendezvous._read_record(workspace, WS.service)
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
        daemon_statement = statement.prepare(modules.WORKSPACE, ws_obj, app_cfg)
        check(daemon_statement.runner is ws_obj, "a daemon statement rides the workspace's own transport")
        check(
            daemon_statement.runner.run("pwd", 10).stdout.strip() == str(Path(workspace).resolve()),
            "which runs in the workspace root, the machine that owns the files",
        )
        cli = next(
            (
                m.name
                for m in catalog.table().values()
                if m.runs_here and not m.resident and rendezvous.available(m.name)
            ),
            "",
        )
        if cli:
            cli_statement = statement.prepare(cli, ws_obj, app_cfg)
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
        check(rendezvous._read_record(workspace, WS.service) is None, "the daemon unpublished its record")

        # 9b. a REPLACED daemon does not unpublish its replacement. The record is
        #     rewritten to name somebody else (this test process — alive, so the
        #     record stays valid), then the daemon we started is stopped: its
        #     last act is remove(pid=…), which sees a different pid and leaves
        #     the file alone. Without that guard the daemon winding down would
        #     delete the record of whatever took over, and the next call would
        #     spawn a second daemon for a workspace that already had one.
        successor = rendezvous.service(workspace, modules.WORKSPACE)
        record_path = WS.service.record(workspace)
        replaced = json.loads(record_path.read_text(encoding="utf-8"))
        replaced["pid"] = os.getpid()
        record_path.write_text(json.dumps(replaced), encoding="utf-8")
        rendezvous.release(workspace, modules.WORKSPACE)
        check(wait_gone(successor.pid), "the daemon we started is stopped")
        check(record_path.exists(), "a replaced daemon left its replacement's record standing")
        record_path.unlink()  # the rest of the run starts from nothing, as before
        rendezvous._note_path(workspace, WS.service).unlink(missing_ok=True)

        # 10. the registry: the SAME Tool definition the model sees, executed by
        #     the executor, reaches the machine's workspace module and comes back
        #     as its envelope. Nothing below re-implements the wiring: this is
        #     the path a real tool call takes.
        cfg = Config()
        reg = ToolRegistry(build_tools(cfg))
        ws = LocalWorkspace(workspace)
        live = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
        check(not live.error and live.content.strip() == "hello", "the registry reads through the daemon")
        check(rendezvous._read_record(workspace, WS.service) is not None, "the registry started the daemon it needed")

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
        real_installed, real_resolve = components.installed, components.resolve
        components.installed = lambda name: None  # gone means gone: no install, nothing to run
        components.resolve = lambda name: None
        try:
            check(not rendezvous.available(modules.WORKSPACE), "a deleted component is not available")
            check("read_file" not in [t.name for t in build_tools(cfg)],
                  "the host offers no read_file with the component gone")
            gone = reg.execute(ws, cfg, "read_file", {"path": "hello.txt"})
            check(gone.error and modules.WORKSPACE in gone.content,
                  "the call is answered with the component's name, never a stand-in")
        finally:
            components.installed = real_installed
            components.resolve = real_resolve

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
