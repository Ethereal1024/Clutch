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

The pick of providers asks ONE question, and it is the declaration's to answer:
does this component publish a `service`? If it does, the statement's values are
what that process published, and the line is spoken to one workspace. If it does
not, the statement is a line this host runs itself and `launch` is its prefix.
Everything downstream of that pick (facts ∪ arguments → template → prefix →
runner) is blind to kinds: it is the same four lines for every component.
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
    needs: the project file's content service. The prefix of a one-process line is
    NOT here — that is the artifact's own launch, rendered by launch_prefix() so a
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


def launch_prefix(mod: catalog.Component) -> str:
    """How a one-process component STARTS, as a line prefix ("" for a service,
    whose process rendezvous starts itself when a statement needs it).

    This is the launch contract: the artifact's shape decides the prefix — an
    interpreter plus an entry-point file for a checkout, `-m <package>` with its
    directory on PYTHONPATH for a package, a bare executable for an installed
    onefile — and the declaration only says which flags follow it. A component
    therefore needs no second implementation to be installed as a binary.
    """
    if mod.service is not None:
        # Its launch starts a process that STAYS; a statement is the loopback call
        # that process answers, with no prefix of its own.
        return ""
    resolved = rendezvous.resolve(mod.name)
    if resolved is None:
        raise rendezvous.RendezvousError(rendezvous.unavailable_reason(mod.name))
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


def prepare(module: str, workspace: Any, config) -> Statement:
    """Everything one statement needs before it can be rendered and run.

    The declaration answers one question and this is it: does the component
    publish a SERVICE? A service belongs to one workspace, so its statement is
    carried by that workspace's own transport — a loopback call has to be issued by
    the machine the files are on — and rendezvous decides which workspace, whether
    one is running, or whether one has to be started. Everything else is the
    artifact's own line, run on the app host's machine, whatever kind of workspace
    the call came from.
    """
    mod = _declared(module)
    if mod.service is None:
        return _artifact(mod, config)
    live = rendezvous.service(workspace.root, mod.name, protect=workspace.protected())
    return Statement(vars=live.vars(), runner=workspace)


def prepare_cli(module: str, config) -> Statement:
    """A standalone statement, ready to run WITHOUT a workspace.

    Separate entry point because not every question is a call: a host fact a
    component publishes (tools/facts.py) is asked of the component's own line,
    outside any workspace and outside any turn. A service cannot answer it — its
    statements are spoken to a service that belongs to one workspace, and a host
    fact belongs to none (catalog.component_diagnostics refuses the declaration for
    the same reason). The runner is the app host's, whose machine these statements
    run on.
    """
    mod = _declared(module)
    if mod.service is not None:
        raise rendezvous.RendezvousError(
            f"{mod.name} publishes a service: its statements belong to one workspace, and this one belongs to none"
        )
    return _artifact(mod, config)


def _declared(module: str) -> catalog.Component:
    mod = catalog.table().get(module)
    if mod is None:
        raise rendezvous.RendezvousError(f"unknown module: {module}")
    return mod


def _artifact(mod: catalog.Component, config) -> Statement:
    """A statement this host runs itself, once per call: its launch IS the prefix.

    The component is one process per call — an installed onefile is one word, a
    checkout is `PYTHONPATH=… {py} {script}`, a package is `PYTHONPATH=… {py} -m …`
    — and the line runs on the APP HOST's machine, because the subject of such a
    component is the app's own project file, the network or the skill library, none
    of which belongs to a workspace.

    A component with no artifact on this host has no such line at all, and
    `launch_prefix` says so in the component's own terms
    (rendezvous.unavailable_reason): for a plugin — whose statements are the
    CLIENT's to render and run, and which registry sends down the channel instead of
    here — the sentence is "runs on the client that calls it, and this host has no
    channel to that client".
    """
    return Statement(
        vars=host_vars(mod, config),
        runner=LocalTransport(str(modules.repo_root())),
        prefix=launch_prefix(mod),
    )
