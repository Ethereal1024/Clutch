"""GET /api/declarations: the machine's half of the tool surface (P3-1).

Which tools the model may call, what each call's schema says, how a call is
shown in the page, and which argument of it named a file are four readings of
ONE thing: the declarations this machine holds. Since P3-1 that reading is made
in the HOST half (`ui/tool-decl.js`), on the user's own machine, and what is
left here is the execution layer — it runs a call (`POST /api/exec`) and keeps
the log (`/api/log`). A tool surface this side computed too would be a second
reading of the same files, and the two would drift; `GET /api/host` already
serves the `ui` table for the same reason.

So this endpoint is DATA and nothing else:

  declarations   every raw manifest this machine holds, in merge order (the
                 files verbatim — checkouts, then the install root, then the
                 user's catalog directory; catalog.registrations)
  available      {component: true|false} — could this host drive it at all
                 (rendezvous.available: its code is here, its `requires` hold,
                 it is not disabled, a client-side one has a live channel)
  config         the knobs the loaded declarations actually name with
                 `$config.<field>`, and only those (see below)
  backends       the configured search chain, for `$backends`
  facts          {token: names} — each published host fact, already answered
                 (`$skills`), so the frontend never runs a component's statement
  host           {ui, access, gates} — the machine's own tables, the document
                 over the built-ins (catalog.DEFAULTS / ACCESS_WORDS / GATE_WORDS)
  project        whether a project log is open (the `project` gate)
  mode           "work" / "chat"

There is no 409 here: a session with no project open still has a surface (the
host's own tools), and the page asks for it before it can open one.

`config` is the one narrow part. A declaration may spend a knob by naming it,
so only the fields the loaded declarations NAME are served — a field nothing
names is not part of any schema and has no business crossing — and only when
the value is a number or a bool. Credentials are strings, so a manifest cannot
name its way to one; a knob that really is text and belongs in the surface has
to be added here deliberately, which is the fail-closed direction (TODO.md I3).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Mapping

from ..tools import answers, catalog, gates, rendezvous


def _strings(node: Any) -> Iterator[str]:
    """Every string in a declaration tree, keys included.

    A `$config` token may sit in a description, in a schema default, or in a
    `ui` value rendered as text, so the walk is over the whole file rather than
    over the fields a schema happens to have today.
    """
    if isinstance(node, str):
        yield node
    elif isinstance(node, Mapping):
        for key, value in node.items():
            yield str(key)
            yield from _strings(value)
    elif isinstance(node, (list, tuple)):
        for item in node:
            yield from _strings(item)


def _config(cfg: Any, declarations: list[Mapping[str, Any]]) -> dict[str, Any]:
    """The knobs these declarations name, as values this host may hand out.

    The token reading is the schema's own (answers._PLACEHOLDER), not a second
    regex: if `$config.<field>` means something to the reading, it means the
    same field here. The type test is what keeps credentials out; `bool` is
    tested first only because it is also an `int`.
    """
    named: set[str] = set()
    for text in _strings(declarations):
        for token in answers._PLACEHOLDER.findall(text):
            if token.startswith("config."):
                named.add(token[len("config.") :])
    fields = catalog.BACKEND_FIELDS  # Config's own field list, read off the dataclass
    out: dict[str, Any] = {}
    for name in sorted(named):
        if name not in fields:
            continue
        value = getattr(cfg, name, None)
        if isinstance(value, (bool, int, float)):
            out[name] = value
    return out


class DeclsMixin:
    "The machine's half of the tool surface: files, and the values a file may spend."
    # ---- API implementations ----

    def _decls_get(self) -> None:
        cfg = self._cfg
        project = self._state.project
        declarations = catalog.registrations()
        self._json(
            {
                "declarations": declarations,
                # asked of the same table the reading merges, so a name this
                # host cannot drive is answered "no" instead of the key being
                # absent — the frontend skips either way, but a refusal that is
                # a value can be shown, and a missing key cannot
                "available": {name: rendezvous.available(name) for name in catalog.table()},
                "config": _config(cfg, declarations),
                "backends": list(catalog.available_backends(cfg)),
                "facts": {token: list(answers._names(token, cfg)) for token in catalog.FACT_TOKENS},
                "host": {
                    "ui": dict(catalog.DEFAULTS),
                    "access": {word: {"arg": rec.arg} for word, rec in catalog.ACCESS_WORDS.items()},
                    "gates": dict(catalog.GATE_WORDS),
                },
                # the log IS the project (gates.gate_project): an in-memory
                # scratch log has no path and shuts the two readers
                "project": gates.gate_project(cfg, project.log if project is not None else None),
                "mode": cfg.mode,
            }
        )
