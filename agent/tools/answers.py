"""The host's answers to what a declaration asks, and what it can drive.

A declaration never carries this host's own values: it NAMES what it wants to
know — `$config.<field>`, `$backends`, and any fact a component publishes
(catalog.published) — and the host answers while the schema, the description or
the prompt fragment is built. This module is that answer, and it is the only
place a fact is spent or read:

  * _resolve / _fact fill a declaration's placeholders, and _whole_fact is how a
    value that IS a fact (an enum, a block) is told apart from one inside a
    sentence;
  * _entries is the single door to a fact, whoever spends it: the schema and the
    description the model reads (registry._wire), the gate a tool is offered
    under (gates._gate_ok), the fragment written around it (prompt._fragment);
  * _drivable is the one filter for what this host can drive at all, so the
    schema and the prose can never disagree about what is here;
  * _say routes a refusal to the sink that says it once.

Nothing here decides anything about a CALL and nothing here knows the shape of a
tool: the wiring is registry.py, the words the host honors are gates.py, the
model-facing text is prompt.py. All three read this module; it reads none of them.
"""

from __future__ import annotations

import re
from typing import Any

from ..config import Config
from . import catalog, facts, rendezvous


# -- declaration -> the schema the model sees ---------------------------------


# A placeholder is a `$` and a name. Reading one is SYNTAX, not a lookup: what
# the name means is decided when it is answered (_fact / _resolve), where
# `config.<field>` and `backends` are values this host computes itself and every
# other name is a host fact some component publishes (catalog.published, asked of
# the component that declares it — _entries). A name nobody publishes is
# therefore read and answered as NO VALUE, instead of surviving as a literal `$`
# in the text the model reads. Syntax here has a second use: the reading cannot
# drift from the table, and a fact published tomorrow needs no edit at all.
_PLACEHOLDER = re.compile(r"\$([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)")


def _vocabulary() -> tuple[str, ...]:
    """The published facts a placeholder may name, as of now.

    Asked of the table every time and never cached: this module is imported long
    before anything is installed, and the table is what a component installs into.
    """
    return tuple(filter(catalog._publishable, catalog.published()))


def placeholder() -> re.Pattern[str]:
    """The pattern a declaration's text is read with: `$` and a name, with the
    meaning settled where it is answered. The reading is the schema's own, so a
    caller that wants to know which words a text spends asks here rather than
    writing a second regex that could drift from this one (api/decls.py)."""
    return _PLACEHOLDER


def _whole_fact(value: str) -> str:
    """The host fact a whole value names, or "" when the value is not one.

    A whole `$<name>` names a fact — not one of the host's own words, which a
    whole value answers with its own type (`$config.<field>`) or its own list
    (`$backends`). Whether anything publishes the name is settled where every
    fact is (no supplier, no entries), so this stays a reading of the syntax.
    """
    token = value[1:] if value.startswith("$") else ""
    if not token or token == "backends" or token.startswith("config."):
        return ""
    return token if _PLACEHOLDER.fullmatch(value) else ""


def _resolve(value: Any, config: Config) -> Any:
    """A declaration's schema value with the host's own facts filled in.

    Three placeholders, all of them things only this host knows when it builds
    the schema: `$config.<field>` (a knob the user set), `$backends` (the search
    backends this machine is configured for) and any fact a component publishes
    (`$<fact>` — catalog.published, answered by the component that declares it;
    see _entries). A value that IS a fact stays a list — an enum — while the same
    token inside a sentence reads as the list of names; likewise a value that IS
    `$config.<field>` keeps the knob's own type (a default of
    `$config.read_max_chars` is the integer the statement sends), and the same
    placeholder inside a sentence is spelled out.
    """
    if isinstance(value, str):
        token = _whole_fact(value)
        if token:  # a whole value: the fact's own shape (the names, as a list)
            return list(_names(token, config))
        if value.startswith("$config."):  # a whole value: the host's own type
            return getattr(config, value.split(".", 1)[1], "")
        return placeholder().sub(lambda m: _fact(m.group(1), config), value)
    if isinstance(value, list):
        return [_resolve(v, config) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v, config) for k, v in value.items()}
    return value


def _fact(token: str, config: Config) -> str:
    """One placeholder read INSIDE a sentence: the fact as prose, never a list."""
    if token.startswith("config."):
        return str(getattr(config, token.split(".", 1)[1], ""))
    if token == "backends":
        return " or ".join(catalog.available_backends(config)) or "none"
    # anything else names a host fact: answered by the component that publishes
    # it, or no value at all — a name nobody publishes is never a guess, and never
    # a `$` left standing in the text the model reads.
    return ", ".join(_names(token, config)) or "none"


def _names(token: str, config: Config) -> tuple[str, ...]:
    """The names a published fact offers right now: what the model picks from."""
    return tuple(entry.name for entry in _entries(token, config))


def _entries(token: str, config: Config) -> tuple[facts.Entry, ...]:
    """One published host fact's entries, or () when there is no value to read.

    The single door to a fact, whoever spends it: the enum of a schema (_resolve),
    a sentence of a description (_fact), the gate under which a tool is offered
    (_gate_ok), the prompt fragment written around it (_fragment). An answer this
    host cannot read is fail-CLOSED — no value at all, never a guess — and the
    component's own reason is said once, out loud (tools/facts.py): a library that
    cannot be read is something the user has to see, not an empty catalog.
    """
    answer = _fact_answer(token, config)
    if answer.problem:
        _say(
            [
                catalog.Diagnostic(
                    answer.owner,
                    "",
                    f"cannot answer the host fact {token!r}: {answer.problem}",
                    fatal=False,
                )
            ]
        )
    return answer.entries


def _fact_answer(token: str, config: Config) -> facts.Answer:
    """One host fact: what the single component publishing it answered.

    The host keeps no value of its own behind a published fact — that is the
    whole point of the direction (facts.py) — so the answer is the publishing
    component's own statement, on its own line, through its own transport. What IS
    the host's here is who may answer, and when the question is asked at all:

      * only ONE component may publish a token. Two suppliers answer nothing and
        say so: the host cannot tell which library the model is about to pick a
        name from, and picking one is how two truth sources start.
    """
    suppliers = [component for component in _drivable() if token in component.facts]
    if not suppliers:
        return facts.Answer(())
    if len(suppliers) > 1:
        return facts.Answer((), "", f"{' and '.join(c.name for c in suppliers)} both publish it")
    return facts.ask(suppliers[0], token, config)


def _drivable() -> list[catalog.Component]:
    """The components this host can drive right now, each refusal said once.

    One filter for everything a component says to the model — the tools it
    declares and the prompt fragment it carries alike: a declaration naming a word
    the host cannot honor contributes nothing (catalog.component_diagnostics), and
    neither does a component this host cannot launch at all
    (rendezvous.available). Read in one place so the schema and the prose can
    never disagree about what is here.
    """
    out: list[catalog.Component] = []
    for component in catalog.table().values():
        fatal = [d for d in catalog.component_diagnostics(component) if d.fatal]
        if fatal:
            _say(fatal)
            continue
        if not rendezvous.available(component.name):
            continue
        out.append(component)
    return out


def _say(diags: list[catalog.Diagnostic]) -> None:
    """Say what the host refuses, through the one sink that says it once.

    `registry._report` lives on the public face because the tests swap it to READ
    what the host says instead of watching a log (tests/catalog_test.py), and its
    memory (_REPORTED) is once per process — swapping the function is the only way
    to read a refusal. A satellite file must therefore not bind it by name: a
    `from .registry import _report` would freeze today's function, and a swapped
    sink would see nothing. The import is late, at the call — the one indirection
    this split pays for, paid once, here.
    """
    from . import registry

    registry._report(diags)
