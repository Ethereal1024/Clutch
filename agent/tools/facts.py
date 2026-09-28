"""Host facts a component publishes: the other direction of `vars`.

`vars` (COMPONENTS.md §五) is what a component CONSUMES from the host: it names
one of the host's own facts and the host fills the placeholder. A `facts` entry
is the reverse — a host fact the component PUBLISHES, because only its own code
can compute it. `skills` is the one this host has: the catalog of the library
the skills component serves, a list that changes whenever the user drops a
directory in, and that the component's own `list` — its scan, its frontmatter,
its root — already knows how to produce. The host keeps no copy of that work.

So the host asks, in its own words. The token is the host's vocabulary
(catalog.FACT_TOKENS), spent wherever the host spends facts (registry._resolve,
registry._gate_ok); the statement is the component's declared way to answer it;
and the ANSWER SHAPE is the host's too, never the component's own wire format:

    [{"name": "refactor", "description": "..."}, ...]

one JSON array on stdout, one object per entry, `name` the string the model
picks from and `description` the line the prompt shows beside it. What a
component prints for its OWN `--json` contract is its business; this question is
the host's, so the answer is written in the host's shape.

An answer the host cannot read is fail-CLOSED and never silent: the fact reads
as no value at all (the gate that needs it shuts, a prompt fragment that spends
it is not appended) and the component's own reason is said once, out loud
(registry._report) — a library that cannot be read is something the user must
see, not an empty catalog. Answers are asked once per process (the cache below):
the table is rebuilt every run, but the fact behind it is the same machine's.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from functools import lru_cache
from typing import NamedTuple

from ..config import Config
from . import catalog, inst, modules, rendezvous
from .transport import CommandResult, LocalTransport, TransportError


class Entry(NamedTuple):
    """One answer entry: the name the model picks, the line the prompt shows."""

    name: str
    description: str


class Answer(NamedTuple):
    """One fact, answered or not.

    `owner` names the component the host asked, so a refusal can say WHERE it
    came from; `problem` is why there is no answer ("" when there is one) — it is
    reported, never raised: a component that cannot answer must not take the
    host's prompt down with it.
    """

    entries: tuple[Entry, ...]
    owner: str = ""
    problem: str = ""


# The one thing a component's answer may carry the host's tokens in: `$skills` in
# the prose of a declaration. `$config.<field>` / `$backends` are the host's own
# facts, computed here, so they are not "spent" in this sense.
_NAMED = re.compile(r"\$([a-z_]+)")


def spent(text: str) -> tuple[str, ...]:
    """Which PUBLISHED host facts a piece of prose spends, in order.

    Used by registry.prompt_section: a fragment that spends a fact nobody can
    answer is not appended, because the tools it describes are not offered
    either (the same gate), and a prompt must not promise a call the model cannot
    make.
    """
    return tuple(t for t in dict.fromkeys(_NAMED.findall(text)) if t in catalog.FACT_TOKENS)


def ask(component: catalog.Component, token: str, config: Config) -> Answer:
    """One component's answer to one host fact, or why it could not answer.

    The statement is the declaration's, rendered exactly like a tool's (host vars
    quoted, optional groups dropped): a fact statement may spend the same
    `{root}`-style host facts a tool statement does, and nothing else — there is
    no model argument to fill, because nobody called anything.
    """
    statement = component.facts.get(token, "")
    if not statement:
        return Answer((), component.name, "")
    if component.interface != catalog.CLI:
        # A daemon's statements are spoken to a service that belongs to one
        # workspace (rendezvous.prepare), and a host fact belongs to none.
        # component_diagnostics refuses this declaration as well; the answer here
        # keeps the fact fail-closed for a table that got in before the check.
        return Answer((), component.name, f"a {component.interface} component cannot publish the host fact {token!r}")
    try:
        ready = rendezvous.prepare_cli(component.name, config)
        command = inst.render(statement, vars=ready.vars)
    except rendezvous.RendezvousError as e:
        return Answer((), component.name, str(e))
    except inst.InstError as e:
        return Answer((), component.name, f"the statement for {token!r} cannot be rendered: {e}")
    if ready.prefix:
        command = f"{ready.prefix} {command}".rstrip()
    return _asked(command, config.command_timeout)._replace(owner=component.name)


@lru_cache(maxsize=16)
def _asked(command: str, timeout: float) -> Answer:
    """The one place a fact command is really run: same line, same answer.

    Keyed by the rendered statement, which already carries every host value that
    shaped it (the component's directory, the library root) — so two hosts, two
    roots or two components never share a cached answer.
    """
    try:
        result = LocalTransport(str(modules.repo_root())).run(command, timeout)
    except TransportError as e:
        return Answer((), "", str(e))
    return _read(result)


def _read(result: CommandResult) -> Answer:
    """One finished command -> the fact's entries, or why this is not an answer."""
    if result.code != 0:
        said = (result.stderr or result.stdout).strip().splitlines()
        reason = said[0] if said else "it said nothing"
        return Answer((), "", f"its answer failed (exit {result.code}): {reason}")
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return Answer((), "", f"its answer is not JSON: {result.stdout.strip()[:120]!r}")
    if not isinstance(data, list):
        return Answer((), "", f"its answer is not a JSON array: {result.stdout.strip()[:120]!r}")
    entries: list[Entry] = []
    for item in data:
        name = str(item.get("name", "")).strip() if isinstance(item, Mapping) else ""
        if not name:
            return Answer((), "", f"an answer entry names nothing: {item!r}")
        description = item.get("description", "")
        entries.append(Entry(name, str(description if isinstance(description, str) else "").strip()))
    return Answer(tuple(entries), "", "")


def forget() -> None:
    """Drop every remembered answer: the next ask runs the statement again.

    Nothing in normal operation needs this — a fact is a machine fact, and the
    statement's line already carries the root it was answered for — but a caller
    that changed what a component serves under the host's own feet (a test
    laying a library down out of band) can say so.
    """
    _asked.cache_clear()
