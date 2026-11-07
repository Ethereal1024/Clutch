"""The one fatal error a non-loop module raises.

Layer policy: recoverable errors always go back to the model as tool results
(error-as-data) so it can self-correct; only fatal errors stop the work. What
that means for the layer that is still Python here: a project that cannot be
opened is fatal to THIS operation and is raised (project_lock.ProjectOpenConflict),
while tool and parse errors are envelopes the client's loop feeds back.

The loop's own retry/normalize/terminate policy went with the loop (P4-1/P4-3):
retries, the context-window verdict and the budget live in ui/ (ui/llm-client.js,
ui/compaction.js, ui/run.js).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AgentError(Exception):
    """Fatal error: the operation cannot continue."""

    code: str = "agent_error"
    message: str = ""
    detail: str | None = None

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"
