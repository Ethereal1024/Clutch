"""The one shape a finished tool call takes.

Every producer of a tool result — the statement layer's `inst.unwrap`, a
transport failure's `transport.failure_envelope`, the host's own command
(`shell.run_command`), the guards that refuse before a component is spoken to —
answers with THIS object, and every consumer (the loop, the tests) reads three
attributes that are always there.

The point is the third one. `{content, error, diff}` used to be assembled by
whoever happened to remember: `unwrap` filled all three only on the branch where
the component printed an envelope, `failure_envelope` never carried a `diff`,
and `ToolRegistry.execute` patched the difference with `setdefault` — so a
caller indexing `["error"]` on a command that simply succeeded hit a KeyError,
and the only place that promised all three keys was the last one in the chain.
A dataclass with defaults cannot express a missing key, so the question does not
come up any more: a producer says what it knows, and the rest is the shape's.

`diff` stays a plain string (`""` = nothing to show) because that is what the
declaration's `ui.body == "diff"` pane renders; there is no richer shape to keep.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Envelope:
    """One tool result: what the model reads back, whether it failed, what changed."""

    content: str
    error: bool = False
    diff: str = ""
