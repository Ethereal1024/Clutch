"""One statement, ready to run: a template, the facts it may name, a runner.

D3 says a call has exactly one form —

    render(template, the model's arguments ∪ the host's facts) → a runner → an envelope

— and nothing here asks WHAT KIND of component is being called. A statement is a
line of text; its placeholders are facts with providers; the runner is a
transport. The question a declaration answers is "where does `{port}` come
from", never "am I a daemon" (DECISIONS.md D3 / D3.1).

The facts, and who answers them:

  `{py} {dir} {name} {script}`   the ARTIFACT — rendezvous.resolve, the one
                                 lookup an installed onefile, an installed
                                 package and a dev checkout all go through,
                                 rendered here as the line's PREFIX and
                                 shq-quoted (this text is a shell line, not
                                 Popen words — that distinction stays in
                                 rendezvous.render_launch);
  `{port} {token} {pid}`         a running SERVICE — rendezvous.Service, one per
                                 (component, workspace root), whose published
                                 record is the only place these values come
                                 from;
  `{base} …`                     the HOST — the component's declared `vars`
                                 (catalog.Component.vars), each naming a fact
                                 only the host knows (host_vars below).

A provider that cannot answer RAISES; a fact is never invented and a component
this host cannot drive is never rendered at all (rendezvous.available /
unavailable_reason is the sentence the client shows instead).

The pick of providers is the one thing still keyed on `interface` (`SOURCES`) —
that is exactly the branch step ② of D3 deletes, when a statement names the facts
it needs and the declaration says who publishes them. Everything downstream of
the pick (facts ∪ arguments → template → prefix → runner) is already blind to
kinds: it is the same six lines for every component.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from . import catalog, inst, modules, rendezvous
from .localshell import shq
from .transport import LocalTransport


def host_vars(mod: catalog.Component, config) -> dict[str, str]:
    """The host facts a component's declaration asks for, by their published
    names (catalog.Component.vars: "host.port_url" -> {base}).

    These are the values only the host knows and only a particular component
    needs: the project file's content service. The prefix of a CLI line is NOT
    here — that is the artifact's own launch, rendered by launch_prefix() so a
    checkout, a package and an installed onefile all drive the same declaration.
    """
    # NB: a key here must never be one of a tool's own argument names — the
    # renderer fills {name} from the CALL's arguments, and a host var of the
    # same name would silently overwrite the model's value (clutch-memory's
    # `--title {name}` is exactly that).
    facts = {
        "host.port_url": lambda: f"http://127.0.0.1:{config.port}",
    }
    out: dict[str, str] = {}
    for name, fact in mod.vars.items():
        make = facts.get(fact)
        if make is None:
            continue
        resolved = make()
        # A host fact the host has no value for is not a fact: it is left out of
        # `vars` entirely, which is what makes an optional group naming it drop
        # whole (inst.render) instead of rendering a placeholder as an empty word
        # the component would then have to read as a value.
        if resolved:
            out[name] = resolved
    return out


def launch_prefix(module: str) -> str:
    """How one one-process component STARTS, as a line prefix ("" for a service,
    whose process rendezvous starts itself when a statement needs it).

    This is the launch contract: the artifact's shape decides the prefix — an
    interpreter plus an entry-point file for a checkout, `-m <package>` with its
    directory on PYTHONPATH for a package, a bare executable for an installed
    onefile — and the declaration only says which flags follow it. A component
    therefore needs no second implementation to be installed as a binary.
    """
    mod = catalog.table().get(module)
    if mod is None or mod.interface != catalog.CLI:
        return ""
    resolved = rendezvous.resolve(module)
    if resolved is None:
        raise rendezvous.RendezvousError(rendezvous.unavailable_reason(module))
    words = [shq(word) for word in resolved.argv]
    if resolved.module.launch.importable:
        words.insert(0, f"PYTHONPATH={shq(str(resolved.directory))}")
    return " ".join(words)


@dataclass(frozen=True)
class Statement:
    """One statement, ready to render and run: what fills it, where it runs.

    `vars` are the host values the template may name (a service's port/token/pid,
    a one-process component's endpoint/root facts); `runner` is the transport
    that carries the rendered line; `prefix` is how the component's own process
    starts, when the line is one the app host runs itself ("" for a service,
    whose line is the whole loopback call).
    """

    vars: Mapping[str, str]
    runner: Any
    prefix: str = ""

    def line(
        self,
        template: str,
        args: Mapping[str, Any] | None = None,
        defaults: Mapping[str, Any] | None = None,
    ) -> str:
        """The terminal line for one call: the component's template filled from
        the call (model arguments, then the host's values), behind the prefix its
        launch contributes.

        Every caller renders through here, so "prefix + rendered template" is
        written once (it used to be written twice: the tool path and the fact
        path).
        """
        command = inst.render(template, args, vars=self.vars, defaults=defaults or {})
        return f"{self.prefix} {command}".rstrip() if self.prefix else command


class Source:
    """Where a component's statements get their facts, and who runs them.

    One method, two implementations today (a one-process artifact, a per-workspace
    service). A Source answers with a Statement — never with a rendered line: the
    template belongs to the declaration and the arguments belong to the call, so
    only those two can fill it in.
    """

    name = ""

    def statement(self, mod: catalog.Component, workspace: Any, config) -> Statement:
        raise NotImplementedError


class Artifact(Source):
    """A statement whose component is ONE PROCESS per call.

    Its launch is the call's prefix — an installed onefile is one word, a
    checkout is `PYTHONPATH=… {py} {script}`, a package is `PYTHONPATH=… {py} -m
    …` — and the line runs on the APP HOST's machine: the subject of these
    components is the app's own project file, the network or the skill library,
    none of which belongs to a workspace.
    """

    name = "artifact"

    def statement(self, mod: catalog.Component, workspace: Any, config) -> Statement:
        return Statement(
            vars=host_vars(mod, config),
            runner=LocalTransport(str(modules.repo_root())),
            prefix=launch_prefix(mod.name),
        )


class Service(Source):
    """A statement spoken to a SERVICE that belongs to one workspace.

    The values are what the daemon published about itself (`{port} {token}
    {pid}`) and the line is carried by the workspace's own transport: a loopback
    call has to be issued by the machine the files are on. Which workspace, and
    whether one is running or has to be started, is rendezvous's question.
    """

    name = "service"

    def statement(self, mod: catalog.Component, workspace: Any, config) -> Statement:
        live = rendezvous.service(workspace.root, mod.name, protect=workspace.protected())
        return Statement(vars=live.vars(), runner=workspace)


# The one place the kind of a component still decides anything. A `plugin` has
# no entry: its statements are the CLIENT's to render and run (registry calls the
# channel, never this file), and saying so here is better than quietly asking a
# service that was never meant to exist.
SOURCES: dict[str, Source] = {catalog.CLI: Artifact(), catalog.DAEMON: Service()}


def prepare(module: str, workspace: Any, config) -> Statement:
    """Everything one statement needs before it can be rendered and run.

    A service component is reached through the workspace's own transport (loopback
    from the machine that owns the files); a one-process component through the app
    host's, whatever kind of workspace the call came from.
    """
    mod = catalog.table().get(module)
    if mod is None:
        raise rendezvous.RendezvousError(f"unknown module: {module}")
    source = SOURCES.get(mod.interface)
    if source is None:
        raise rendezvous.RendezvousError(
            f"{module} is a {mod.interface} component: no statement of its runs on this host"
        )
    return source.statement(mod, workspace, config)


def prepare_cli(module: str, config) -> Statement:
    """A one-process component's statement, ready to run WITHOUT a workspace.

    Separate entry point because not every question is a call: a host fact a
    component publishes (tools/facts.py) is asked of the component's own line,
    outside any workspace and outside any turn, and a service cannot answer it
    (its statements are spoken to a service that belongs to one workspace — see
    catalog.component_diagnostics). The runner is the app host's, which is whose
    machine these statements run on.
    """
    mod = catalog.table().get(module)
    if mod is None:
        raise rendezvous.RendezvousError(f"unknown module: {module}")
    if mod.interface != catalog.CLI:
        raise rendezvous.RendezvousError(
            f"{module} is a {mod.interface} component: only a one-process statement runs without a workspace"
        )
    return Artifact().statement(mod, None, config)
