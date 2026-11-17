"""The values a component's `settings` block lets a person set.

A declaration may carry a `settings` block (catalog.Component.settings): one
entry per knob — `{"type", "default", "description"}` — and this module is the
other half. It knows no knob of anybody. It draws nothing (the supervisor serves
the schema, the renderer draws it), validates nothing of its own (catalog.
setting_value is the one reading of a setting's type), and decides nothing about
what a knob MEANS.

Two decisions, both taken to keep the surface small:

  * one file per component, holding the EFFECTIVE document — every declared knob
    at its current value, defaults included — under
    `<components.root()>/settings/<name>.json`. A file that held only what is
    not defaulted would be a second source of truth for the defaults, which are
    the declaration's and may change with a new version of the component. So the
    document is written whole, and a key the declaration no longer names is
    dropped on the way out;
  * the values reach the component through the interface it ALREADY has for host
    facts: a `vars` entry naming `host.settings` (statement.host_vars) is the
    path of that file, and the statement spends it like any other host fact. No
    new wire format, no new call, nothing the host has to teach a component, and
    a component that declares no settings never sees the placeholder at all.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from . import catalog, components


class BadSetting(ValueError):
    """A write the declaration cannot honor: the key, or the value, is not its."""


def path(name: str) -> Path:
    """Where one component's settings document lives (whether or not it exists).

    Beside the payloads it configures, under the same machine-local root: a
    component is installed for THIS host, and so is what a person set on it.
    """
    return components.root() / "settings" / f"{name}.json"


def values(name: str, component: catalog.Component) -> dict[str, Any]:
    """Every setting's current value: what is stored over what is declared."""
    return catalog.setting_defaults(component) | _stored(name, component)


def _stored(name: str, component: catalog.Component) -> dict[str, Any]:
    """What the file holds, read through the declaration (anything else drops).

    A value that no longer fits its declaration — an older version wrote it, or
    the declaration changed — is not an error and not a value: it is left out,
    and the default stands in its place. Refusing to start a component over a
    stale knob would make an upgrade a trap.
    """
    raw = _read(path(name))
    out: dict[str, Any] = {}
    for key, spec in component.settings.items():
        if key not in raw:
            continue
        value, ok = catalog.setting_value(spec, raw[key]) if isinstance(spec, Mapping) else (None, False)
        if ok:
            out[key] = value
    return out


def write(name: str, component: catalog.Component, updates: Mapping[str, Any]) -> dict[str, Any]:
    """Set one or more knobs; answer the whole effective document.

    Partial on purpose: the form sends the knob a person touched, and two
    windows open on the same machine cannot overwrite each other's work with a
    stale copy of the rest. A key or a value the declaration does not carry is
    REFUSED (`BadSetting`) rather than dropped: the caller believed something
    false about the component, and a silent no-op would keep that belief.
    """
    current = values(name, component)
    for key, raw in updates.items():
        spec = component.settings.get(key)
        if not isinstance(spec, Mapping):
            raise BadSetting(f"{name} declares no setting {key!r}")
        value, ok = catalog.setting_value(spec, raw)
        if not ok:
            raise BadSetting(f"setting {key!r} is not a {spec.get('type')}")
        current[key] = value
    _store(name, current)
    return current


def materialize(name: str, component: catalog.Component) -> str:
    """The path of the effective document, written down first ("" = none declared).

    Called when a statement is rendered (statement.host_vars): the component's
    `{settings}` placeholder has to name a file that EXISTS and says what its own
    declaration plus this host's stored values come to. A machine that never
    opened the form therefore still gets a document — a component cannot tell
    "never set" from "set to the defaults", and should not have to.
    """
    if not component.settings:
        return ""
    document = values(name, component)
    target = path(name)
    if _read(target) != document:
        _store(name, document)
    return str(target)


def _read(target: Path) -> dict[str, Any]:
    """One settings document, or {} when there is not a readable one."""
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return dict(data) if isinstance(data, Mapping) else {}


def _store(name: str, document: Mapping[str, Any]) -> None:
    """Replace the file whole, atomically: a reader sees the old one or the new.

    Never a partial write, because two processes read this file at once — the
    session host renders a statement from it while the supervisor accepts a
    write — and a truncated document would read as "every setting is at its
    default", which is the one wrong answer that looks like a right one.
    """
    target = path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    scratch.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    # A knob may hold something a person would not print in a log; the file is
    # this user's own, and nothing else on the machine has business reading it.
    try:
        os.chmod(scratch, 0o600)
    except OSError:
        pass  # a platform without POSIX modes: the directory is the boundary
    os.replace(scratch, target)
