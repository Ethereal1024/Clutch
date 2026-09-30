"""What the components themselves tell the model, and what the UI is told about
the ones this host does not have.

The host writes no word about a tool it does not own: a component may carry a
`prompt` file inside its own directory (catalog.Component.prompt) and this module
reads it, resolves the host facts it spends exactly as a tool description is
resolved, and joins the fragments in table order. A component that is absent,
renamed or replaced by a third party therefore cannot leave the prompt describing
tools that are not here.

The same reading answers the other two questions a caller has about a component
that is here but cannot serve THIS call: why not (module_blocked_reason — what the
loop says instead of running a statement) and what the user should be told about
it (components_unavailable, which only speaks for the components whose own
declaration asks to be explained).
"""

from __future__ import annotations

from pathlib import Path

from ..config import Config
from . import catalog, facts, rendezvous
from .answers import _drivable, _entries, _resolve, _say, _whole_fact
from .workspace import LocalWorkspace, Workspace


def prompt_section(config: Config) -> str:
    """What the components themselves tell the model, joined ("" when none does).

    A component may name a `prompt` file inside its own directory
    (catalog.Component.prompt); this reads it and returns the fragments in table
    order. It is why the host's own prose names no tool it does not own: what the
    model is told about a component's tools travels with the component, so one
    that is absent, renamed or replaced by a third party cannot leave the prompt
    describing tools that are not here.

    A fragment is resolved exactly like a tool description, so a component may
    spend `$config.<field>` / `$backends` / a published fact (`$skills`) in it
    too — and one fact gets a second reading, because a catalog is not a word in
    a sentence: a LINE that is exactly `$skills` becomes the block
    `- name: description` per entry (_prose), which is how a component writes
    "here is my catalog" without knowing a single entry of it. A fragment that
    spends a fact nobody here can answer is NOT appended (the calls it describes
    are gone by the same gate, and a prompt must not promise what the model
    cannot call); one that cannot be read is not fatal — the component's tools
    still work — but it is not silent either: nothing is appended and the word is
    said once, like every other the host cannot honor.
    """
    return "\n\n".join(text for text in (_fragment(c, config) for c in _drivable() if c.prompt) if text)


def _fragment(component: catalog.Component, config: Config) -> str | None:
    """One component's prompt fragment, or None when there is nothing to append."""
    resolved = rendezvous.resolve(component.name)
    if resolved is None:  # _drivable() already said why; nothing to read here
        return None
    path = Path(component.prompt)
    if not path.is_absolute():  # relative to the component's own directory
        path = resolved.directory / path
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError as e:
        _say(
            [
                catalog.Diagnostic(
                    component.name, "", f"prompt fragment {component.prompt!r} cannot be read ({e})", fatal=False
                )
            ]
        )
        return None
    missing = [token for token in facts.spent(text) if not _entries(token, config)]
    if missing:
        # The fragment is written around a fact nothing here can answer. The calls
        # it describes are not offered either (the same gate shuts them), and a
        # prompt must not promise what the model cannot call — so the fragment is
        # dropped whole, and _entries already said why.
        return None
    return _prose(text, config) or None


def _prose(text: str, config: Config) -> str:
    """A fragment's prose with the host's facts filled in, LINE by line.

    A line that is exactly one published fact is a BLOCK: one `- name:
    description` line per entry, in the shape the component's own human `list`
    renders — the component writes the header in its own words and says `$skills`
    under it, and knows no entry of the library it is describing. Anywhere else
    (a token inside a sentence) the fact reads as the list of names, exactly as
    it does in a tool description (_resolve).
    """
    out: list[str] = []
    for line in text.splitlines():
        token = _whole_fact(line.strip())
        if not token:
            out.append(str(_resolve(line, config)))
            continue
        out.extend(f"- {entry.name}: {entry.description}" for entry in _entries(token, config))
    return "\n".join(out)


def components_unavailable(config: Config) -> list[dict[str, str]]:
    """The components this host is MISSING, for the UI to explain — and only the
    ones whose declaration asks to be explained (catalog Component.ui.status).

    A component that says `status: True` declares that its absence is something
    the user should be told about, in the words its own declaration chooses
    (`ui.label`). One that says nothing about its state disappears quietly, which
    is the right default for an optional extra.
    """
    out: list[dict[str, str]] = []
    for component in catalog.table().values():
        if not component.ui.get("status"):
            continue
        reason = rendezvous.unavailable_reason(component.name)
        if reason:
            out.append(
                {
                    "name": component.name,
                    "label": str(component.ui.get("label", component.name)),
                    "reason": reason,
                }
            )
    return out


def module_blocked_reason(workspace: Workspace, module: str | None) -> str:
    """Why this host cannot run `module`'s statements for THIS call ("" = it can).

    Two facts, both local. The component has to be here and drivable
    (`rendezvous.unavailable_reason` — nothing on the host's side can stand in
    for it), and a component whose SUBJECT is the workspace root's own
    filesystem additionally needs the root to live HERE, because it serves the
    filesystem of the machine it runs on. A component serving anything else runs
    on the app host whatever kind of workspace the call came from — its subject
    is the project file / the network / the skill library, never the workspace's
    machine.
    """
    if module is None:
        return "no component serves this tool"
    missing = rendezvous.unavailable_reason(module)
    if missing:
        return missing
    # TODO(ssh-workspace): this branch disappears with the component that serves
    # a foreign filesystem over a channel of its own — that component's subject
    # is FOREIGN_FS and it is driven from here, so the root's home stops mattering.
    if rendezvous.serves_workspace_fs(module) and not isinstance(workspace, LocalWorkspace):
        return (
            f"{module} serves the filesystem of the machine this workspace root lives on, "
            f"and this root is another machine's"
        )
    return ""
