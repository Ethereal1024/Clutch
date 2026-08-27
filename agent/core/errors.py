"""Error handling.

Layer policy: recoverable errors always go back to the model as tool results
(error-as-data) so it can self-correct; only fatal errors stop the loop.
- tool/parse errors -> fed back as tool result (see parse.py / tools)
- API errors -> normalized LlmError + retry with backoff (see llm/client.py)
- budget exceeded / context overflow -> terminate with a summary
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class AgentError(Exception):
    """Fatal error: terminates the loop."""

    code: str = "agent_error"
    message: str = ""
    detail: Optional[str] = None

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


def context_window_error(detail: str) -> AgentError:
    return AgentError(
        code="context_window_exceeded",
        message="Context window is full; cannot continue. Restart with a more focused task.",
        detail=detail,
    )


def budget_exceeded_error(kind: str, detail: str) -> AgentError:
    return AgentError(code=f"budget_{kind}", message=f"Budget exceeded ({kind}).", detail=detail)
