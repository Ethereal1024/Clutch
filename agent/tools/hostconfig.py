"""The host's own document: the tables that ARE this host's half of the protocol.

A declaration is data (COMPONENTS.md) — but the words it may use were, until this
document, the host's Python constants: which `access` words exist and what each
one is enforced by, which `gate` words a tool can stand behind, what a tool's
events look like when its `ui` block says nothing, and which search backends this
machine's config can switch on. Those are the HOST's vocabulary, and a host that
only ever read them from its own source could not be taught a word without
editing that source (COMPONENTS_REVIEW §3.4: the one thing the host was not
file-driven about). So one document may name them:

    {
      "access":   {"read": {"guard": "guard_read", "arg": "path"}},
      "gates":    {"project": "project", "skills": "skills"},
      "ui":       {"chip": "name"},
      "backends": [{"name": "tavily", "field": "tavily_api_key"}]
    }

WHERE it is: `CLUTCH_HOST_CONFIG` names a file explicitly, and a blank value
means "no document"; otherwise this host reads `~/.clutch/host.json` — the
directory `server._settings_path()` already uses for this machine's
settings.json. Deliberately not a file inside the repo: these are the tables of
THE HOST ON THIS MACHINE, and reading them from a document is only worth
anything if the document is the user's to write. Absent is a valid state and the
normal one: every table keeps its built-in default.

Three rules, and the third is what makes the other two safe:

  * the constants in tools/catalog.py stay, as the DEFAULTS. A section the
    document does not name is the built-in table, whole; a section it does name
    is merged over it word by word ("点名即覆盖", the rule declarations got for
    their own fields), so `{"access": {"read": {"arg": "file"}}}` renames one
    argument and leaves every other word alone, and a word named `null` stops
    existing. A chain (`backends`) is ORDERED — there is no key to merge on — so
    naming it replaces it whole;
  * the document chooses among implementations the HOST already has and never
    brings one: `guard_read` is filesystem.guard_read or it is nothing. A word
    pointing at an implementation this host does not have is not created, and it
    does not take a built-in word down with it — the built-in word stands. That
    is the fail-closed half: a typo can never quietly take the workspace's fence
    off a tool, because the alternative to a guard the host cannot name is the
    guard it already had;
  * everything the document said that this host could not read is said out loud
    once (`_problem`), and `said()` reads the list back. This is a host file:
    when it does not say what its author meant, the user has to see it. A
    document unreadable as a WHOLE is ignored as a whole — a file the host
    cannot parse is one whose every table would be a guess — and the built-in
    defaults stand.
"""

from __future__ import annotations

import json
import os
from collections.abc import Container, Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any, NamedTuple


class AccessWord(NamedTuple):
    """One `access` word as this host implements it: the guard that enforces it
    ("" = the host itself applies nothing — the permission engine still judges
    the call, by `arg`) and the argument that guard reads when a declaration does
    not rename it."""

    guard: str
    arg: str


class Backend(NamedTuple):
    """One entry of the search-backend chain: its name, and the `Config` field
    that switches it on ("" = always available)."""

    name: str
    field: str


def path() -> Path | None:
    """The document to read, or None when this host has none.

    `CLUTCH_HOST_CONFIG` wins whenever it is set at all — including when it is
    blank, which is how a caller says "the built-in tables" without depending on
    what happens to be in the home directory.
    """
    named = os.environ.get("CLUTCH_HOST_CONFIG")
    if named is not None:
        named = named.strip()
        return Path(named).expanduser() if named else None
    return Path.home() / ".clutch" / "host.json"


@lru_cache(maxsize=1)
def document() -> Mapping[str, Any]:
    """The document, read once per process ({} when there is nothing to read)."""
    at = path()
    if at is None:
        return {}
    if not at.is_file():
        return {}  # absent is the normal state: the built-in tables are the host's
    try:
        raw = at.read_text(encoding="utf-8")
    except OSError as e:
        _problem(f"{at}: cannot be read ({e.strerror or e}); the built-in tables stand")
        return {}
    try:
        data = json.loads(raw)
    except ValueError as e:
        _problem(f"{at}: is not valid JSON ({e}); the built-in tables stand")
        return {}
    if not isinstance(data, Mapping):
        _problem(f"{at}: is not a JSON object; the built-in tables stand")
        return {}
    return data


# ------------------------------------------- what this host could not read ----


_SAID: list[str] = []
_LOGGED: set[str] = set()


def _problem(message: str) -> None:
    """Record one unreadable thing, and say it out loud once per process.

    Same shape as registry._report for a component's typo: the host keeps
    working on what it CAN read, and the user is told what it dropped and why.
    """
    _SAID.append(message)
    if message in _LOGGED:
        return
    _LOGGED.add(message)
    from ..procmgr.stdio import log

    log(f"[host] host.json: {message}")


def said() -> tuple[str, ...]:
    """Everything the document said that this host could not read, as found."""
    return tuple(_SAID)


def forget() -> None:
    """Read the document again next time, and forget what was said about it.

    For a caller that rewrote the document under the host's own feet (a test, or
    a future reload): normal operation reads it once, at import, and never again.
    """
    document.cache_clear()
    _SAID.clear()
    _LOGGED.clear()


# ----------------------------------------------------- the table merges -------


def _doc(doc: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return document() if doc is None else doc


def _table(doc: Mapping[str, Any], name: str) -> Mapping[str, Any] | None:
    """The document's table for `name`, or None when it says nothing about it.

    A missing section is None ("keep the built-in table"); an explicit `null` is
    an empty table ("I mean it to be empty"); anything that is not an object
    cannot be read as a table and leaves the built-in one in force.
    """
    if name not in doc:
        return None
    value = doc[name]
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        _problem(f"{name}: is not an object, so the built-in {name} table stands")
        return None
    return value


def _known(words: Container[str]) -> str:
    return ", ".join(repr(w) for w in sorted(words))


def access(
    defaults: Mapping[str, AccessWord],
    guards: Container[str],
    doc: Mapping[str, Any] | None = None,
) -> dict[str, AccessWord]:
    """The `access` vocabulary: the built-in words, then the document's.

    `guards` names the guard implementations this host HAS (the keys of
    registry._GUARD_IMPLS, whose vocabulary is catalog.GUARD_IMPLS). An entry the
    host cannot read leaves the built-in word (if any) exactly as it was.
    """
    out = dict(defaults)
    table = _table(_doc(doc), "access")
    if table is None:
        return out
    for word, entry in table.items():
        if entry is None:
            out.pop(word, None)  # named null: this word stops existing
            continue
        if not isinstance(entry, Mapping):
            _problem(f"access {word!r}: {entry!r} is not an object; the word is not offered")
            continue
        base = out.get(word, AccessWord("", ""))
        guard, arg = entry.get("guard", base.guard), entry.get("arg", base.arg)
        guard = "" if guard is None else guard
        arg = "" if arg is None else arg
        if not isinstance(guard, str) or not isinstance(arg, str):
            _problem(f"access {word!r}: guard and arg must be strings; the built-in word stands")
            continue
        if guard and guard not in guards:
            _problem(f"access {word!r}: guard {guard!r} is not one of {_known(guards)}; the word is not offered")
            continue
        if not arg:
            _problem(f"access {word!r}: names no argument for its guard; the word is not offered")
            continue
        out[word] = AccessWord(guard, arg)
    return out


def gates(
    defaults: Mapping[str, str],
    impls: Container[str],
    doc: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """The named `gate` conditions: the built-in words, then the document's.

    A gate word maps to the name of a host condition (catalog.GATE_IMPLS lists
    the ones that exist; registry._GATE_IMPLS implements them). "" and "always"
    are structural — no condition — and are not part of this table.
    """
    out = dict(defaults)
    table = _table(_doc(doc), "gates")
    if table is None:
        return out
    for word, impl in table.items():
        if impl is None:
            out.pop(word, None)
            continue
        if not word or not isinstance(impl, str) or impl not in impls:
            _problem(f"gate {word!r}: condition {impl!r} is not one of {_known(impls)}; the gate is not offered")
            continue
        out[word] = impl
    return out


def ui(defaults: Mapping[str, Any], doc: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The renderer's defaults: the built-in keys, then the document's.

    A `ui` key carries a VALUE, not an implementation — `null` is one of them (it
    is what `group` means) — so every key the document names is taken as it is:
    nothing here is refused and nothing is dropped. The renderer ignores what it
    does not know, and no tool's safety rests on this table.
    """
    out = dict(defaults)
    table = _table(_doc(doc), "ui")
    if table is not None:
        out.update(table)
    return out


def backends(
    defaults: Sequence[Backend],
    fields: Container[str],
    doc: Mapping[str, Any] | None = None,
) -> tuple[Backend, ...]:
    """The search-backend chain: the built-in chain, or the document's whole.

    `fields` are the `Config` fields a backend may be switched on by ("" = a
    backend that needs no configuration). An entry this host cannot read is
    dropped — a backend no config field can switch on is a backend this host does
    not have — and what is left keeps the order it was written in.
    """
    data = _doc(doc)
    if "backends" not in data:
        return tuple(defaults)
    raw = data["backends"]
    if not isinstance(raw, list):
        _problem(f"backends: {raw!r} is not a list, so the built-in chain stands")
        return tuple(defaults)
    out: list[Backend] = []
    for entry in raw:
        name, field = (entry.get("name"), entry.get("field", "")) if isinstance(entry, Mapping) else ("", "")
        field = "" if field is None else field
        if not isinstance(name, str) or not name or not isinstance(field, str):
            _problem(f"backends: {entry!r} names no backend; ignored")
            continue
        if field and field not in fields:
            _problem(f"backends: {name!r} is switched on by config field {field!r}, which this host has not got")
            continue
        out.append(Backend(name, field))
    return tuple(out)
