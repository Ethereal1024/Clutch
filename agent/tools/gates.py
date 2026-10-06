"""The words the host honors: how a declaration's policy is enforced.

A declaration speaks a VOCABULARY — the access word that says what a call may
touch (catalog.ACCESS_ARGS), the gate under which a tool is offered at all
(catalog.GATE_WORDS) — and this module binds each word to the implementation that
makes it true on THIS host: the guard a path policy is enforced by
(filesystem.guard_read / guard_grep / guard_write), the condition a gate stands
behind. Keeping the names in the declaration's vocabulary and the code here is
the split: a component says "this names a path the workspace may protect", the
host decides what protection means.

Neither half can drift from the other silently: _check_vocabulary runs at import
and asserts that every word the protocol lists has an implementation here, and
every implementation is named by a word — a mismatch is a host bug, not a
component's, so it is loud.

The words themselves come from catalog's built-in table with this machine's
document merged over it (tools/hostconfig.py), which is how a host is taught a
word that reuses a guard it already has without touching host source.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..config import Config
from ..memory import MemoryStore
from . import catalog, filesystem, host
from .answers import _entries
from .envelope import Envelope
from .workspace import Workspace

# (workspace, config, **args) -> the result the model reads
ToolImpl = Callable[..., Envelope]
# a refusal, or None to proceed — (workspace, config, args, arg), where `arg` is
# the argument this policy judges, from the tool's own declaration
# (catalog.Tool.access_arg) — never assumed to be "path".
GuardImpl = Callable[[Workspace, Config, dict[str, Any], str], Envelope | None]


@dataclass(frozen=True)
class Access:
    """One host policy word: how it is enforced, and the argument it judges when
    a declaration does not rename it.

    `guard` is the host's own refusal (None when the word needs no host-side
    check — permission rules alone judge `command`); `arg` is the default name
    the policy reads. The WORDS live in catalog.ACCESS_ARGS (the declaration
    vocabulary); this table binds each one to the implementation, and the keys
    are checked against that vocabulary at import time (see _check_vocabulary).
    """

    guard: GuardImpl | None
    arg: str


# The guard each access word is enforced by, under the name the host's document
# calls it (catalog.GUARD_IMPLS lists the ones that exist — _check_vocabulary
# keeps the two lists equal — and hostconfig refuses a document that names
# anything else, so a word can never point at a guard this host does not have).
_GUARD_IMPLS: dict[str, GuardImpl] = {
    "guard_read": filesystem.guard_read,
    "guard_grep": filesystem.guard_grep,
    "guard_write": filesystem.guard_write,
}


# The host POLICY a declaration may put a tool under, by the name it is declared
# with (catalog.Tool.access). Keeping the names in the declaration's vocabulary
# and the implementations here is the split: a component says "this names a path
# the workspace may protect", the host decides what protection means. The words
# come from catalog.ACCESS_WORDS — the built-in table with this machine's
# document merged over it (tools/hostconfig.py), so a host can be taught a word
# that reuses a guard it already has without touching host source.
ACCESS: dict[str, Access] = {
    word: Access(_GUARD_IMPLS.get(rec.guard), rec.arg) for word, rec in catalog.ACCESS_WORDS.items()
}


# The policies under which a call is "working ON a file" rather than sweeping for
# one: the context reader after a compaction re-reads the files a call NAMED, and
# READ/WRITE are the words that name exactly one. `sweep` (a search) deliberately
# stays out — it has no single file to re-read.
WATCHED_ACCESS: frozenset[str] = frozenset({"read", "write"})


def gate_project(config: Config, memories: MemoryStore | None) -> bool:
    """`project`: a memory store is open for the workspace being served."""
    return memories is not None


def gate_skills(config: Config, memories: MemoryStore | None) -> bool:
    """`skills`: the library the `skills` fact publishes has something in it.

    Nothing to load: an enum over an empty library is a schema that offers the
    model nothing to pick. The gate word is also the fact token, so a library the
    host cannot read shuts this gate too.
    """
    return bool(_entries("skills", config))


# The host-side condition a NAMED `gate` word stands behind, by the name the
# host's document calls it (catalog.GATE_IMPLS lists the ones that exist —
# _check_vocabulary keeps the two lists equal — and "" / "always" are structural,
# no condition at all, so they are not here).
_GATE_IMPLS: dict[str, Callable[[Config, MemoryStore | None], bool]] = {
    "project": gate_project,
    "skills": gate_skills,
}


def _gate_ok(gate: str, config: Config, memories: MemoryStore | None) -> bool:
    """Whether a tool's declared host-side condition holds at all (see
    catalog.Tool.gate). A tool whose gate is shut is not offered — it is not
    offered-with-an-error, because the model would only learn to stop trying.

    The word is looked up in the host's table (catalog.GATE_WORDS: the built-in
    conditions with this machine's document merged over them), and a word whose
    condition this host does not have shuts the gate: an unreadable condition is
    not "always true" (a declaration naming one the host cannot answer is refused
    by tool_diagnostics anyway, so this is the second lock on the same door)."""
    if gate in ("", "always"):
        return True
    impl = _GATE_IMPLS.get(catalog.GATE_WORDS.get(gate, ""))
    return bool(impl(config, memories)) if impl else False


def _check_vocabulary() -> None:
    """Neither half of the host's vocabulary can drift from the declarations
    behind it silently: every access word the declaration protocol lists must have
    an implementation here (and every implementation a word may name), every named
    gate a condition, and the host's own tool names must be exactly the ones
    tools/host.py declares. A mismatch is a host bug, not a component's, so it is
    loud."""
    assert set(ACCESS) == set(catalog.ACCESS_ARGS), (
        f"access vocabulary drift: catalog {sorted(catalog.ACCESS_ARGS)} vs gates.py {sorted(ACCESS)}"
    )
    assert set(_GUARD_IMPLS) == set(catalog.GUARD_IMPLS), (
        f"guard implementation drift: catalog {sorted(catalog.GUARD_IMPLS)} vs gates.py {sorted(_GUARD_IMPLS)}"
    )
    assert set(_GATE_IMPLS) == set(catalog.GATE_IMPLS), (
        f"gate implementation drift: catalog {sorted(catalog.GATE_IMPLS)} vs gates.py {sorted(_GATE_IMPLS)}"
    )
    assert set(host.names()) == set(catalog.HOST_TOOL_NAMES), (
        f"host tool drift: catalog {sorted(catalog.HOST_TOOL_NAMES)} vs host {sorted(host.names())}"
    )


_check_vocabulary()
