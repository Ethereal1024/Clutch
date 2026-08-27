"""Model output parsing.

Core principle "error-as-data": any parse failure becomes a message fed back to the
model so it can self-correct; never crash.
- arguments arrive as a raw JSON string; parse failure -> error text for the model
- finish_reason classification: tool_calls -> execute; stop -> natural end; length -> truncated
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple


class ParseError(Exception):
    """Parse failure; message is safe to feed back to the model."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def parse_arguments(raw: str) -> Dict[str, Any]:
    """Parse tool arguments JSON; raise ParseError on failure (error-as-data)."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ParseError(
            f"Argument parse failed: invalid JSON ({e}). Regenerate the arguments as a valid JSON object."
        ) from e
    if not isinstance(data, dict):
        raise ParseError(f"Argument parse failed: expected a JSON object, got {type(data).__name__}.")
    return data


def parse_message(message: Dict[str, Any]) -> Tuple[Optional[str], List[Dict[str, Any]], str]:
    """Parse a single assistant message.

    Returns (content, tool_calls, finish_reason).
    tool_calls entries are [{id, name, arguments(raw string)}].
    Internal _reasoning is dropped so it never reaches the model as content.
    """
    message = {k: v for k, v in message.items() if k != "_reasoning"}
    content = message.get("content")
    if isinstance(content, list):  # newer openai content block array
        content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    if content is None:
        content = ""

    tool_calls: List[Dict[str, Any]] = []
    for tc in message.get("tool_calls", []) or []:
        fn = tc.get("function", {})
        tool_calls.append(
            {
                "id": tc.get("id", ""),
                "name": fn.get("name", ""),
                "arguments": fn.get("arguments", "{}"),
            }
        )
    return content, tool_calls, message.get("finish_reason", "stop")
