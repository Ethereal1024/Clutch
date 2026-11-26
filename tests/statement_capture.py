"""Golden capture for the statement layer (M3: `ui/host/statement.js` + `ui/host/orient.js`).

A component's tool call has exactly one form —

    render(template, the model's arguments ∪ the host's facts) → a runner → an envelope

— and `agent/tools/statement.py` is the whole of it; `agent/tools/registry.py`'s
`ToolRegistry.execute` is the order the pieces are used in, and
`prompt.module_blocked_reason` is the question asked before anything is prepared.
`tests/host-statement.test.js` and `tests/host-orient.test.js` replay both against
the two JS files.

    .venv/bin/python -m tests.statement_capture            # write the fixture
    .venv/bin/python -m tests.statement_capture --check    # regenerate+compare

Nothing here runs a process or touches the filesystem: the declaration table
(`catalog.table`), the artifact lookup (`rendezvous.resolve`), the service table
(`rendezvous.service`), the channel (`channel.current`/`channel.call`), the app
host's transport (`statement.LocalTransport`) and the "may this component serve
this root" probe (`registry.module_blocked_reason`) are all patched per case, and
the workspace is the same kind of stub `tests/tools_capture.py` uses — it records
what was asked of it, in a trace the JS replay reproduces call for call.

What each group pins:

  * `host_vars` — the facts a declaration may name (`{base}` ← `host.port_url`),
    and that a fact the host has no value for is LEFT OUT rather than rendered as
    an empty word;
  * `launch_prefix` — the artifact's shape as a line prefix: "" for a service, the
    interpreter + entry point for a checkout, `-m` with its directory on
    PYTHONPATH for a package, a bare executable for an installed onefile, and the
    rendezvous sentence when there is no artifact at all;
  * `fence_globs` — the protected paths in the three spellings a client's glob is
    matched against, sorted, with ""/"."/"/" dropped;
  * `line` / `run` — one statement, rendered and carried: the prefix in front, the
    host's values over the model's, `defaults` underneath, and a transport
    failure left for the caller to word;
  * `resident` / `per_call` / `client` — the three shapes `statement.prepare`
    dispatches on: which fact bundle each one reads (`rendezvous.service` for a
    service, the artifact for a one-process component, the live channel for a
    client's), that a client with no channel has NO statement — fail closed, in
    the channel's own words — and that a client statement carries no root and no
    fence: those were the second implementation of the client's own shell, and
    what crosses the wire is now the declaration's template and nothing else;
  * `client_run` — the template sent VERBATIM (not rendered, `defaults` ignored)
    with the model's arguments, `ChannelError` → `ERROR: …`, the reply → envelope;
  * `module_blocked` — `prompt.module_blocked_reason` itself, with `far_root`
    marking the verdicts a host that only serves a far root can still reach (see
    `ui/host/orient.js`'s header: the two subject clauses collapse there);
  * `execute` — 21 whole calls through `registry.ToolRegistry.execute`, each
    recording the trace of what the workspace/transport/channel saw AND the
    envelope the model reads: the blocked reason, an uninstalled component, a
    missing argument, success, a non-zero exit, a timeout, a Stop, an unreachable
    transport, the client's refusal and its answer, and six shapes of the undo
    record (replaced, created, failed run, escaping path, renamed argument, and a
    CLIENT's write — which keeps no record at all here: the file it changed is on
    the client's machine, where this process can neither read nor restore it,
    `Statement.local`).
"""

from __future__ import annotations

import contextlib
import json
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

from agent.config import Config
from agent.tools import catalog, channel, inst, prompt, registry, rendezvous, statement
from agent.tools.envelope import Envelope
from agent.tools.transport import CommandResult, TransportError

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "statement" / "expected.json"

ROOT = "/home/u/proj"
LOG_PATH = f"{ROOT}/demo.clc"
PORT = 51234
TIMEOUT = 30.0


# ----------------------------------------------------------------- the stubs


@contextlib.contextmanager
def patched(module, **names):
    """Set attributes for one case and put them back, whatever happens."""
    old = {name: getattr(module, name) for name in names}
    try:
        for name, value in names.items():
            setattr(module, name, value)
        yield
    finally:
        for name, value in old.items():
            setattr(module, name, value)


def table_of(*components) -> object:
    """A stand-in for `catalog.table()`: the declarations these cases are about.

    The declaration table is what `statement.prepare` reads a component's own
    shape from, so every case that goes through it says what THIS host holds —
    never what the install root happens to contain."""
    table = {component.name: component for component in components}
    return lambda: table


class FarWorkspace:
    """A far root, in the only sense the statement layer asks for: a root, a
    protected set, and file operations that RECORD what they were asked.

    `files` maps a root-relative path to its content; anything else does not
    exist. A path that names nothing inside the root is a `ValueError`, exactly
    as `fs.js::resolve` answers (`path escapes workspace`).
    """

    def __init__(self, files: dict | None = None, protected: tuple = (LOG_PATH,)) -> None:
        self.root = PurePosixPath(ROOT)
        self._protected = tuple(PurePosixPath(p) for p in protected)
        self._files = dict(files or {})
        self.trace: list[str] = []
        self.answers: dict[str, dict] = {}

    # -- what the statement layer asks of a workspace ----------------------

    def protected(self):
        return self._protected

    def resolve(self, path):
        text = str(path)
        self.trace.append(f"resolve {text}")
        if text.startswith("/") or ".." in PurePosixPath(text).parts:
            raise ValueError(f"path escapes workspace: {text}")
        return self.root if text in ("", ".") else self.root / text

    def read(self, path):
        self.trace.append(f"read {path}")
        key = str(PurePosixPath(path).relative_to(self.root))
        if key not in self._files:
            raise FileNotFoundError(str(path))
        return self._files[key]

    def snapshot(self, path, content):
        self.trace.append(f"snapshot {path} {content}")

    def record_mutation(self, path, existed, previous):
        self.trace.append(f"record {path} {1 if existed else 0} {previous}")

    # -- the runner (a service's statements go through the workspace) ------

    def run(self, command: str, timeout: float, cancel=None):
        self.trace.append(f"run {command}")
        return canned(self.answers.get(command))


class StubTransport:
    """The app host's transport, for the statements that do not belong to a
    workspace (`statement.LocalTransport`)."""

    def __init__(self, answers: dict) -> None:
        self.answers = answers
        self.trace: list[str] = []

    def run(self, command: str, timeout: float, cancel=None):
        self.trace.append(f"run {command}")
        return canned(self.answers.get(command))


class StubService:
    def __init__(self, values: dict) -> None:
        self._values = values

    def vars(self) -> dict:
        return dict(self._values)


class StubChannel:
    def __init__(self, reason: str) -> None:
        self._reason = reason

    def reason_for(self, name: str) -> str:
        return self._reason


def canned(answer):
    if answer is None:
        raise AssertionError("the capture has no canned answer for that line")
    error = answer.get("error")
    if error:
        raise TransportError(
            error["message"], timeout=bool(error.get("timeout")), aborted=bool(error.get("aborted"))
        )
    return CommandResult(answer["code"], answer["stdout"], answer["stderr"])


# --------------------------------------------------------------- the config


def config() -> Config:
    cfg = Config()
    cfg.port = PORT
    return cfg


def envelope_of(env: Envelope) -> dict:
    return {"content": env.content, "error": env.error}


# ----------------------------------------------------------- one artifact --


def resolved(argv, directory="/opt/clutch/components/probe", importable=False, name="clutch-probe"):
    component = catalog.Component(name=name, launch=catalog.Launch(importable=importable))
    return rendezvous.Resolved(
        module=component, directory=Path(directory), argv=tuple(argv), template=False
    )


def one_process(**fields) -> catalog.Component:
    """A declaration with no service: its own launch is the prefix of every call,
    run on this host's machine (`statement._artifact`)."""
    return catalog.Component(
        name="clutch-probe", launch=catalog.Launch(argv=("{py}", "-m", "clutch_probe")), **fields
    )


def launch_case(name: str, component: catalog.Component, *, artifact=None, unavailable="") -> dict:
    """One prefix case: the DECLARATION (a service, or a launch to render) and the
    artifact this host resolved for it (None when there is none)."""
    record = {"name": name, "service": component.service is not None}
    if artifact is not None:
        record["resolved"] = {
            "argv": list(artifact.argv),
            "directory": str(artifact.directory),
            "importable": artifact.module.launch.importable,
        }
    record["unavailable"] = unavailable
    with patched(rendezvous, resolve=lambda _name: artifact, unavailable_reason=lambda _name: unavailable):
        try:
            record["expect"] = {"prefix": statement.launch_prefix(component)}
        except rendezvous.RendezvousError as e:
            record["expect"] = {"error": str(e)}
    return record


# --------------------------------------------------------------- the capture


def capture() -> dict:
    cfg = config()
    return {
        "config": {"port": PORT, "command_timeout": TIMEOUT},
        "host_vars": capture_host_vars(cfg),
        "launch_prefix": capture_launch_prefix(),
        "fence_globs": capture_fence_globs(),
        "line": capture_line(),
        "run": capture_run(),
        "resident": capture_resident(cfg),
        "per_call": capture_per_call(cfg),
        "client": capture_client(cfg),
        "client_run": capture_client_run(),
        "module_blocked": capture_module_blocked(),
        "execute": capture_execute(cfg),
    }


def capture_host_vars(cfg) -> list:
    cases = [
        ("no vars", {}),
        ("one fact", {"base": "host.port_url"}),
        ("unknown fact skipped", {"other": "host.nothing", "base": "host.port_url"}),
        ("two names, one fact", {"a": "host.port_url", "b": "host.port_url"}),
        ("all unknown", {"x": "host.nope"}),
    ]
    out = []
    for name, vars_ in cases:
        component = catalog.Component(name="clutch-probe", vars=vars_)
        out.append({"name": name, "vars": vars_, "expect": statement.host_vars(component, cfg)})
    return out


def capture_launch_prefix() -> list:
    binary = resolved(["/usr/local/bin/clutch-probe"])
    checkout = resolved(["python3", "/home/u/proj/clutch-probe/main.py"])
    package = resolved(["python3", "-m", "clutch_probe"], directory="/opt/other dir", importable=True)
    hostile = resolved(["python3", "/opt/it's here/main.py"], directory="/opt/it's here")
    service = catalog.Component(name="clutch-probe", service=catalog.Service(app_dir="clutch", prefix="probe-"))
    return [
        launch_case("a service answers with no prefix", service, artifact=package),
        launch_case("an installed onefile is one word", one_process(), artifact=binary),
        launch_case("a checkout is interpreter + entry", one_process(), artifact=checkout),
        launch_case("a package goes on PYTHONPATH", one_process(), artifact=package),
        launch_case("quoting survives the prefix", one_process(), artifact=hostile),
        launch_case(
            "no artifact",
            one_process(),
            artifact=None,
            unavailable="clutch-probe is not installed on this host",
        ),
    ]


def capture_fence_globs() -> list:
    cases = [
        ("one protected file", [LOG_PATH], ROOT),
        ("several", [LOG_PATH, f"{ROOT}/notes.clc"], ROOT),
        ("outside the root", ["/etc/clutch/clutch.clc"], ROOT),
        ("the root itself", [ROOT], ROOT),
        ("duplicates collapse", [LOG_PATH, LOG_PATH, f"{LOG_PATH}"], ROOT),
        ("none", [], ROOT),
        ("relative entries", ["demo.clc", "./demo.clc"], ROOT),
    ]
    out = []
    for name, protected, root in cases:
        out.append(
            {
                "name": name,
                "protected": list(protected),
                "root": root,
                "expect": list(rendezvous.fence_globs(protected, root)),
            }
        )
    return out


def capture_line() -> list:
    cases = [
        ("plain", {"prefix": "", "vars": {}, "module": "clutch-probe"},
         "--json read {path}", {"path": "a.txt"}, {}),
        ("behind a launch", {"prefix": "'python3' '-m' 'clutch_probe'", "vars": {"root": ROOT},
                             "module": "clutch-probe"},
         "--workspace {root} read {path}", {"path": "a.txt"}, {}),
        ("a host value wins", {"prefix": "", "vars": {"root": "/host/root"}, "module": "clutch-probe"},
         "read {root}", {"root": "/model/root"}, {}),
        ("defaults fill what the model omitted", {"prefix": "", "vars": {}, "module": "clutch-probe"},
         "read {max_chars} {*}", {"path": "a.txt"}, {"max_chars": 20000}),
        ("an optional group drops", {"prefix": "", "vars": {}, "module": "clutch-probe"},
         "curl [--data {body}] http://127.0.0.1:{port}/x", {}, {"port": "51234"}),
        ("a missing value is a sentence", {"prefix": "", "vars": {}, "module": "clutch-probe"},
         "read {path}", {}, {}),
    ]
    out = []
    for name, fields, template, args, defaults in cases:
        ready = statement.Statement(
            vars=fields["vars"], runner=SimpleNamespace(), prefix=fields["prefix"], module=fields["module"]
        )
        record = {
            "name": name,
            "prefix": fields["prefix"],
            "vars": fields["vars"],
            "module": fields["module"],
            "template": template,
            "args": args,
            "defaults": defaults,
        }
        try:
            record["expect"] = {"line": ready.line(template, args, defaults)}
        except inst.InstError as e:
            record["expect"] = {"error": str(e)}
        out.append(record)
    return out


def capture_run() -> list:
    cases = [
        ("an envelope passes through", {"code": 0, "stdout": '{"content":"hi","error":false,"diff":""}', "stderr": ""},
         "", "clutch-probe"),
        ("a non-zero exit is framed", {"code": 2, "stdout": "", "stderr": "ls: nope"}, "", "clutch-probe"),
        ("a timeout is the transport's", {"error": {"message": "timed out", "timeout": True}}, "", "clutch-probe"),
        ("a stop is the transport's", {"error": {"message": "aborted", "aborted": True}}, "", "clutch-probe"),
        ("an unreachable transport keeps its words",
         {"error": {"message": "the bridge is not answering"}}, "", "clutch-probe"),
    ]
    out = []
    for name, answer, prefix, module in cases:
        runner = StubTransport({})
        ready = statement.Statement(vars={}, runner=runner, prefix=prefix, module=module)
        record = {"name": name, "template": "read {path}", "args": {"path": "a.txt"}, "prefix": prefix,
                  "module": module, "timeout": TIMEOUT, "answer": answer}
        # the runner's answer is keyed by the line the REAL renderer produces, so
        # the capture never guesses what a statement looks like
        runner.answers[ready.line("read {path}", {"path": "a.txt"}, {})] = answer
        try:
            record["expect"] = envelope_of(ready.run("read {path}", {"path": "a.txt"}, {}, timeout=TIMEOUT))
        except TransportError as e:
            record["expect"] = {"raises": f"TransportError: {e}"}
        record["trace"] = runner.trace
        out.append(record)
    # a missing argument never reaches the runner at all
    runner = StubTransport({})
    ready = statement.Statement(vars={}, runner=runner, prefix="", module="clutch-probe")
    record = {"name": "a missing argument raises before the runner", "template": "read {path}", "args": {},
              "prefix": "", "module": "clutch-probe", "timeout": TIMEOUT, "answer": {}}
    try:
        record["expect"] = envelope_of(ready.run("read {path}", {}, {}, timeout=TIMEOUT))
    except inst.InstError as e:
        record["expect"] = {"raises": f"InstError: {e}"}
    record["trace"] = runner.trace
    out.append(record)
    return out


def capture_resident(cfg) -> dict:
    """A component with a SERVICE: `prepare` asks the service table for the
    workspace THIS call is about, and the workspace's own transport carries the
    loopback call."""
    workspace = FarWorkspace()
    calls = []

    def service(root, name, protect=()):
        calls.append([str(root), name, [str(p) for p in protect]])
        return StubService({"port": "51234", "token": "abc", "pid": "77"})

    component = catalog.Component(name="clutch-probe", service=catalog.Service(app_dir="clutch", prefix="probe-"))
    with patched(rendezvous, service=service), patched(catalog, table=table_of(component)):
        ready = statement.prepare(component.name, workspace, cfg)
    line = ready.line("curl -H X-Token:{token} http://127.0.0.1:{port}/read {*}", {"path": "a.txt"}, {})
    return {
        "service_call": calls,
        "vars": dict(ready.vars),
        "prefix": ready.prefix,
        "module": ready.module,
        "runner": "the workspace",
        "template": "curl -H X-Token:{token} http://127.0.0.1:{port}/read {*}",
        "args": {"path": "a.txt"},
        "line": line,
    }


def capture_per_call(cfg) -> dict:
    """A one-process component, asked OUTSIDE any workspace (`prepare_cli`, which
    is what a host fact goes through): the artifact's launch is the prefix and the
    app host's transport carries the line."""
    artifact = resolved(["python3", "-m", "clutch_probe"], importable=True)
    transport = StubTransport({})
    component = one_process(vars={"base": "host.port_url"})
    with patched(catalog, table=table_of(component)), patched(
        rendezvous, resolve=lambda _name: artifact
    ), patched(statement, LocalTransport=lambda _root: transport):
        ready = statement.prepare_cli(component.name, cfg)
    template = "--base {base} read {*}"
    return {
        "vars": dict(ready.vars),
        "prefix": ready.prefix,
        "module": ready.module,
        "template": template,
        "args": {"path": "a.txt"},
        "line": ready.line(template, {"path": "a.txt"}, {}),
    }


def capture_client(cfg) -> list:
    """A component with neither a service nor a launch: its statement is the
    CLIENT's, and a declaration no live channel holds has none at all.

    The case still records the workspace's root and its protected set: they are
    what the JS builder has to hand the client WITH the call (ui/host/statement.js)
    and the replay checks them against these inputs — the Python's client
    statement names nothing but the component, so the fixture's `expect` pins that
    and no root/fence of its own."""
    cases = [
        ("a live channel holds it", "", [LOG_PATH], ROOT),
        ("no channel", "clutch-probe runs on the client that calls it and this host has no channel to that client",
         [LOG_PATH], ROOT),
        ("a stopped client", "clutch-probe is stopped on this client — start it before calling it", [], ROOT),
        ("no root", "", [], ""),
    ]
    out = []
    component = catalog.Component(name="clutch-probe", entry="clutch-ws")
    for name, reason, protected, root in cases:
        workspace = FarWorkspace(protected=tuple(protected))
        workspace.root = PurePosixPath(root)
        # the root as the JS builder reads it (`String(workspace.root)`): an empty
        # path is Python's ".", and recording the case's own "" instead would hide
        # that spelling from the replay
        record = {"name": name, "reason": reason, "protected": list(protected), "root": str(workspace.root)}
        with patched(catalog, table=table_of(component)), patched(
            channel, current=lambda _reason=reason: StubChannel(_reason)
        ):
            try:
                ready = statement.prepare(component.name, workspace, cfg)
            except rendezvous.RendezvousError as e:
                record["expect"] = {"error": str(e)}
            else:
                record["expect"] = {"module": ready.module, "local": ready.local}
        out.append(record)
    return out


def capture_client_run() -> list:
    """One statement of a client's own: `Statement.run` sends the template VERBATIM
    with the model's arguments — no rendering, no prefix, and nothing about the
    workspace, which the client already holds."""
    cases = [
        ("the client answers", {"content": "file contents", "error": False}),
        ("the client reports an error", {"content": "no such file", "error": True}),
        ("the channel refuses", {"channel_error": "clutch-probe is not installed for this client"}),
    ]
    out = []
    for name, answer in cases:
        calls = []

        def call(component, command, args, timeout_s, _answer=answer):
            calls.append([component, command, dict(args), timeout_s])
            if "channel_error" in _answer:
                raise channel.ChannelError(_answer["channel_error"])
            return channel.Reply(content=_answer["content"], error=_answer["error"])

        ready = statement.Statement(vars={}, runner=statement.Client(), module="clutch-probe")
        record = {
            "name": name,
            "module": ready.module,
            "local": ready.local,
            "template": "read_file {*}",
            "args": {"path": "a.txt"},
            "defaults": {"max_bytes": 100},
            "timeout": TIMEOUT,
            "reply": answer,
        }
        with patched(channel, call=call):
            record["expect"] = envelope_of(
                ready.run("read_file {*}", {"path": "a.txt"}, {"max_bytes": 100}, timeout=TIMEOUT)
            )
        record["calls"] = calls
        out.append(record)
    return out


def capture_module_blocked() -> list:
    """The three clauses of `prompt.module_blocked_reason`, one case each.

    The workspace is not a dimension any more: this host builds a local root for
    every project, so only the component's own answers decide.
    """
    cases = [
        ("an unknown component says so",
         {"unavailable": "unknown component: ghost", "serves_channel": False}),
        ("not installed on this host",
         {"unavailable": "clutch-probe is not installed on this host", "serves_channel": False}),
        ("a client-side component cannot serve this host's root",
         {"unavailable": "", "serves_channel": True}),
        ("drivable here",
         {"unavailable": "", "serves_channel": False}),
    ]
    out = []
    for name, fields in cases:
        with patched(
            rendezvous,
            unavailable_reason=lambda _name, _f=fields: _f["unavailable"],
            # `serves_channel` is `serves_remote_workspace_fs`: the component's
            # process is the CLIENT's, so no root this host builds is its subject.
            serves_remote_workspace_fs=lambda _name, _f=fields: _f["serves_channel"],
        ):
            reason = prompt.module_blocked_reason("clutch-probe")
        out.append(
            {
                "name": name,
                **fields,
                "expect": reason,
            }
        )
    return out


def capture_execute(cfg) -> list:
    artifact = resolved(["python3", "-m", "clutch_probe"], importable=True)
    out = []
    for case in EXECUTE_CASES:
        out.append(run_execute_case(case, artifact, cfg))
    return out


def component_of(case: dict) -> catalog.Component:
    """The declaration one execute case is about: a process that stays here, one
    process per call here, or nothing here at all (the client's)."""
    fields: dict = {"name": case["component"], "vars": case.get("vars", {})}
    if case["kind"] == "resident":
        fields["service"] = catalog.Service(app_dir="clutch", prefix="probe-")
    elif case["kind"] == "perCall":
        fields["launch"] = catalog.Launch(argv=("{py}", "-m", "clutch_probe"))
    else:
        fields["entry"] = "clutch-ws"
    return catalog.Component(**fields)


def run_execute_case(case: dict, artifact, cfg) -> dict:
    name = case["name"]
    workspace = FarWorkspace(files=case.get("files"))
    transport = StubTransport({})
    calls = []

    def service(root, component_name, protect=()):
        return StubService(case.get("service_vars", DEFAULT_SERVICE_VARS))

    def channel_call(component, command, args, timeout_s):
        calls.append(f"send {component} {command} {json.dumps(dict(args), sort_keys=True, ensure_ascii=False)}")
        reply = case.get("reply") or {}
        if "channel_error" in reply:
            raise channel.ChannelError(reply["channel_error"])
        return channel.Reply(content=reply.get("content", ""), error=bool(reply.get("error")))

    run_ = case["kind"]
    component = component_of(case)
    tool = registry.Tool(
        name=case.get("tool", "read_file"),
        description="",
        parameters={"properties": {}, "required": []},
        inst=case["template"],
        module=component.name,
        access="",
        access_arg="",
        snapshot=case.get("snapshot", False),
        snapshot_arg=case.get("snapshot_arg", ""),
        defaults=case.get("defaults", {}),
    )
    record = {
        "name": name,
        "kind": run_,
        "component": case["component"],
        "template": case["template"],
        "args": case.get("args", {}),
        "defaults": case.get("defaults", {}),
        "snapshot": case.get("snapshot", False),
        "snapshot_arg": case.get("snapshot_arg", ""),
        "vars": case.get("vars", {}),
        "blocked": case.get("blocked", ""),
        "files": case.get("files", {}),
        "resolved": None if run_ != "perCall" else {
            "argv": list(artifact.argv),
            "directory": str(artifact.directory),
            "importable": True,
        },
        "unavailable": case.get("unavailable", ""),
        "channel_reason": case.get("channel_reason", ""),
        "service_vars": dict(case.get("service_vars", DEFAULT_SERVICE_VARS)),
        "answer": case.get("answer", {}),
        "reply": case.get("reply"),
    }
    tools = registry.ToolRegistry([tool])
    with patched(
        registry,
        module_blocked_reason=lambda _name, _blocked=case.get("blocked", ""): _blocked,
    ), patched(
        catalog,
        table=table_of(component),
    ), patched(
        rendezvous,
        resolve=lambda _name: artifact if run_ == "perCall" and not case.get("unavailable") else None,
        unavailable_reason=lambda _name, _u=case.get("unavailable", ""): _u,
        service=service,
    ), patched(
        statement,
        LocalTransport=lambda _root: transport,
    ), patched(
        channel,
        current=lambda _reason=case.get("channel_reason", ""): StubChannel(_reason),
        call=channel_call,
    ):
        workspace.answers = {
            tool_line(case, artifact): case.get("answer", {}),
        }
        transport.answers = dict(workspace.answers)
        result = tools.execute(workspace, cfg, tool.name, dict(case.get("args", {})))
    record["expect"] = envelope_of(result)
    record["trace"] = workspace.trace + transport.trace + calls
    return record


def tool_line(case: dict, artifact) -> str:
    """The line this case is expected to run, so the stub can answer it.

    Rendered with the REAL renderer and a throwaway runner, which is the point:
    the capture must not re-implement what it is measuring. "" means nothing is
    rendered at all — an unrenderable template, a component with no statement.
    """
    if case["kind"] == "clientRun":
        # the template IS the statement: sent verbatim, never rendered here
        return case["template"]
    component = component_of(case)
    service_vars = dict(case.get("service_vars", DEFAULT_SERVICE_VARS))
    workspace = FarWorkspace(files=case.get("files"))
    with patched(catalog, table=table_of(component)), patched(
        rendezvous,
        resolve=lambda _name: None if case.get("unavailable") else artifact,
        unavailable_reason=lambda _name, _u=case.get("unavailable", ""): _u,
        service=lambda *a, **k: StubService(service_vars),
    ):
        try:
            ready = statement.prepare(component.name, workspace, config())
        except rendezvous.RendezvousError:
            return ""
    workspace.trace.clear()
    try:
        return ready.line(case["template"], case.get("args", {}), case.get("defaults", {}))
    except inst.InstError:
        return ""


DEFAULT_SERVICE_VARS = {"port": "51234", "token": "abc"}


EXECUTE_CASES = [
    # -- the artifact half: one process per call ---------------------------
    {
        "name": "a per-call statement runs behind its launch",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}",
        "args": {"path": "a.txt"},
        "answer": {"code": 0, "stdout": '{"content":"hi","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "a host fact the declaration asks for is in the line",
        "kind": "perCall",
        "component": "clutch-probe",
        "vars": {"base": "host.port_url"},
        "template": "--base {base} read {*}", "args": {"path": "a.txt"},
        "answer": {"code": 0, "stdout": '{"content":"based","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "a non-zero exit is framed, not swallowed",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "answer": {"code": 2, "stdout": "", "stderr": "no such component state"},
    },
    {
        "name": "a timeout is the transport's verdict",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "answer": {"error": {"message": "timed out after 30s", "timeout": True}},
    },
    {
        "name": "a stop is the user's, and says so",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "answer": {"error": {"message": "aborted", "aborted": True}},
    },
    {
        "name": "an unreachable transport never ran the command",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "answer": {"error": {"message": "the exec bridge is not answering"}},
    },
    {
        "name": "a missing argument is the model's mistake",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {},
        "answer": {"code": 0, "stdout": "", "stderr": ""},
    },
    {
        "name": "a component this host has no artifact for says why",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "unavailable": "clutch-probe is not installed on this host",
        "answer": {"code": 0, "stdout": "", "stderr": ""},
    },
    # -- the service half: a loopback call on the root's machine ------------
    {
        "name": "a service statement is the loopback call",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} http://127.0.0.1:{port}/read {*}",
        "args": {"path": "a.txt"},
        "answer": {"code": 0, "stdout": '{"content":"served","error":false,"diff":""}', "stderr": ""},
    },
    # -- the blocked reason comes first ------------------------------------
    {
        "name": "a blocked component is answered, never prepared",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl http://127.0.0.1:{port}/read {*}",
        "args": {"path": "a.txt"},
        "blocked": "clutch-probe serves the filesystem of the machine this workspace root lives on, "
                   "and this root is another machine's",
        "answer": {"code": 0, "stdout": "", "stderr": ""},
    },
    {
        "name": "a component no declaration answers to still has a sentence",
        "kind": "perCall",
        "component": "clutch-probe",
        "template": "--json read {path}", "args": {"path": "a.txt"},
        "blocked": "unknown component: clutch-probe",
        "answer": {"code": 0, "stdout": "", "stderr": ""},
    },
    # -- the client half: the template IS the statement --------------------
    {
        "name": "a client statement is sent, not rendered",
        "kind": "clientRun",
        "component": "clutch-ws",
        "template": "read_file {*}",
        "args": {"path": "a.txt"},
        "defaults": {"max_bytes": 100},
        "reply": {"content": "client file contents", "error": False},
    },
    {
        "name": "the client's error is the model's error",
        "kind": "clientRun",
        "component": "clutch-ws",
        "template": "read_file {*}",
        "args": {"path": "a.txt"},
        "reply": {"content": "no such file", "error": True},
    },
    {
        "name": "a component with no live channel has no statement at all",
        "kind": "clientRun",
        "component": "clutch-ws",
        "template": "read_file {*}",
        "args": {"path": "a.txt"},
        "channel_reason": "clutch-ws runs on the client that calls it and this host has no channel to that client",
        "reply": {"content": "", "error": False},
    },
    {
        "name": "a channel that refuses says so in its own words",
        "kind": "clientRun",
        "component": "clutch-ws",
        "template": "read_file {*}",
        "args": {"path": "a.txt"},
        "reply": {"channel_error": "clutch-ws is not installed for this client"},
    },
    # -- the undo record ---------------------------------------------------
    {
        "name": "a replaced file is remembered",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} -X POST http://127.0.0.1:{port}/write {*}",
        "args": {"path": "a.txt"},
        "snapshot": True,
        "snapshot_arg": "path",
        "files": {"a.txt": "old contents"},
        "answer": {"code": 0, "stdout": '{"content":"wrote","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "a created file is journaled without a snapshot",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} -X POST http://127.0.0.1:{port}/write {*}",
        "args": {"path": "new.txt"},
        "snapshot": True,
        "snapshot_arg": "path",
        "answer": {"code": 0, "stdout": '{"content":"wrote","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "a failed write leaves nothing to restore",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} -X POST http://127.0.0.1:{port}/write {*}",
        "args": {"path": "a.txt"},
        "snapshot": True,
        "snapshot_arg": "path",
        "files": {"a.txt": "old contents"},
        "answer": {"code": 0, "stdout": '{"content":"refused","error":true,"diff":""}', "stderr": ""},
    },
    {
        "name": "a path outside the root is never remembered",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} -X POST http://127.0.0.1:{port}/write {*}",
        "args": {"path": "/etc/passwd"},
        "snapshot": True,
        "snapshot_arg": "path",
        "answer": {"code": 0, "stdout": '{"content":"wrote","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "the declaration names the argument",
        "kind": "resident",
        "component": "clutch-probe",
        "template": "curl -s -H X-Clutch-Token:{token} -X POST http://127.0.0.1:{port}/write {*}",
        "args": {"file": "b.txt"},
        "snapshot": True,
        "snapshot_arg": "file",
        "files": {"b.txt": "bee"},
        "answer": {"code": 0, "stdout": '{"content":"wrote","error":false,"diff":""}', "stderr": ""},
    },
    {
        "name": "a client's write is the client's to undo, not this host's",
        "kind": "clientRun",
        "component": "clutch-ws",
        "template": "write_file {*}",
        "args": {"path": "a.txt"},
        "snapshot": True,
        "snapshot_arg": "path",
        "files": {"a.txt": "old contents"},
        "reply": {"content": "wrote", "error": False},
    },
]


def verify(fixture: dict) -> int:
    expected = json.loads(OUT.read_text("utf-8"))
    if expected != fixture:
        print("statement goldens DO NOT reproduce:")
        for key in fixture:
            if expected.get(key) != fixture[key]:
                print(f"  {key}: differs")
                if isinstance(fixture[key], list):
                    for want, have in zip(expected.get(key) or [], fixture[key]):
                        if want != have:
                            print(f"    want {json.dumps(want, ensure_ascii=False)}")
                            print(f"    have {json.dumps(have, ensure_ascii=False)}")
                            break
        return 1
    print(
        f"statement goldens reproduce: {len(fixture['launch_prefix'])} prefixes, "
        f"{len(fixture['fence_globs'])} fences, {len(fixture['line'])} lines, "
        f"{len(fixture['run'])} runs, {len(fixture['execute'])} calls"
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
