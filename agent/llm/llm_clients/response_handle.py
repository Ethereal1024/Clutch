"""Responses-API SSE events -> the internal stream protocol.

The Responses wire protocol is not chunk-shaped like chat completions: every
event is typed (``response.*``), text / reasoning / function-call arguments
arrive as separate event families keyed by ``output_index``, and the turn ends
with one terminal event (``response.completed`` / ``response.incomplete`` /
``response.failed``) carrying the final Response object. These handlers
translate all of that into the same events the chat client emits — reasoning /
text / tool_call_start / tool_call_delta / finish — so the loop, the UI and the
transcript never learn which protocol produced a turn.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..client import LlmError, is_context_overflow


class ResponsesState:
    """Per-attempt accumulation. Mirrors chunk_handle.StreamState: the handlers
    are stateless, all progress lives here."""

    def __init__(self) -> None:
        self.content_parts: list[str] = []
        self.tool_args: dict[Any, dict[str, Any]] = {}  # output_index -> {id, name, args}
        self.finished: bool = False
        self.finish_reason: str | None = None
        self.reasoning_started: bool = False


def _key(event: Any) -> Any:
    """Where a streamed delta belongs: the output item's index, or its item_id
    when a provider omits output_index (the two are used consistently within one
    stream, so tool_call_start and its deltas still line up)."""
    idx = getattr(event, "output_index", None)
    return getattr(event, "item_id", "") if idx is None else idx


def _response_tool_calls(response: Any) -> list[dict[str, Any]]:
    calls = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", "") != "function_call":
            continue
        calls.append(
            {
                "id": getattr(item, "call_id", "") or getattr(item, "id", "") or "",
                "name": getattr(item, "name", "") or "",
                "arguments": getattr(item, "arguments", "") or "",
            }
        )
    return calls


def _response_text(response: Any) -> str:
    parts: list[str] = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", "") != "message":
            continue
        for block in getattr(item, "content", None) or []:
            if getattr(block, "type", "") == "output_text":
                parts.append(getattr(block, "text", "") or "")
            elif getattr(block, "type", "") == "refusal":
                parts.append(getattr(block, "refusal", "") or "")
    return "".join(parts)


def finish_event(
    state: ResponsesState, *, reason: str | None = None, response: Any = None
) -> dict[str, Any]:
    """The turn's final event. Falls back to the terminal Response's own output
    when the stream carried no deltas (a buffering relay, or a non-streaming
    provider answering a stream request)."""
    tool_calls = [{"id": e["id"], "name": e["name"], "arguments": e["args"]} for e in state.tool_args.values()]
    if not tool_calls and response is not None:
        tool_calls = _response_tool_calls(response)
    content = "".join(state.content_parts)
    if not content and response is not None:
        content = _response_text(response)
    if reason is None:
        reason = "tool_calls" if tool_calls else "stop"
    return {"type": "finish", "reason": reason, "content": content, "tool_calls": tool_calls}


def _failure_code(code: str, message: str) -> str:
    """The code the loop acts on. A provider-level failure keeps its own code,
    EXCEPT a window overflow: there the provider's own wording ("this model's
    maximum context length is …", "context_length_exceeded") is normalized to
    the one code the loop answers by compacting and retrying. Without this the
    same overflow that chat completions survives would abort a responses run."""
    return "context_window_exceeded" if is_context_overflow(code, message) else code


class ResponseEventHandler(ABC):
    @abstractmethod
    def handle(self, event: Any, state: ResponsesState) -> list[dict[str, Any]]: ...


class ReasoningHandler(ResponseEventHandler):
    """Reasoning text -> the UI's reasoning panel.

    ``reasoning_text`` is the raw chain of thought (DeepSeek); OpenAI exposes
    the model's own summary instead. Both stream to the same place. A new
    summary part starts a paragraph, so the panel does not run them together.
    """

    def handle(self, event: Any, state: ResponsesState) -> list[dict[str, Any]]:
        etype = getattr(event, "type", "")
        if etype == "response.reasoning_summary_part.added":
            if not state.reasoning_started:
                return []
            return [{"type": "reasoning", "delta": "\n\n"}]
        if etype not in ("response.reasoning_text.delta", "response.reasoning_summary_text.delta"):
            return []
        delta = getattr(event, "delta", "") or ""
        if not delta:
            return []
        state.reasoning_started = True
        return [{"type": "reasoning", "delta": delta}]


class ContentHandler(ResponseEventHandler):
    """Assistant-visible text. A refusal is the turn's visible content too: the
    user must see it, so it streams on the same channel."""

    def handle(self, event: Any, state: ResponsesState) -> list[dict[str, Any]]:
        if getattr(event, "type", "") not in ("response.output_text.delta", "response.refusal.delta"):
            return []
        delta = getattr(event, "delta", "") or ""
        if not delta:
            return []
        state.content_parts.append(delta)
        return [{"type": "text", "delta": delta}]


class ToolCallHandler(ResponseEventHandler):
    """Function calls are ITEMS, not a delta list: ``output_item.added``
    announces {call_id, name} and ``function_call_arguments.delta`` streams the
    argument JSON, both keyed by output_index — so a call is fully identified
    before its arguments arrive (the chat protocol sends id/name in the same
    delta as the first argument fragment)."""

    def handle(self, event: Any, state: ResponsesState) -> list[dict[str, Any]]:
        etype = getattr(event, "type", "")
        if etype in ("response.output_item.added", "response.output_item.done"):
            item = getattr(event, "item", None)
            if getattr(item, "type", "") != "function_call":
                return []
            key = _key(event)
            entry = state.tool_args.get(key)
            fresh = entry is None
            if fresh:
                entry = {"id": "", "name": "", "args": ""}
                state.tool_args[key] = entry
            # the item is authoritative (output_item.done carries the complete
            # arguments): a delta that never arrived cannot leave a call short
            entry["id"] = getattr(item, "call_id", "") or getattr(item, "id", "") or entry["id"]
            entry["name"] = getattr(item, "name", "") or entry["name"]
            entry["args"] = getattr(item, "arguments", None) or entry["args"]
            if not fresh:
                return []
            return [{"type": "tool_call_start", "index": key, "id": entry["id"], "name": entry["name"]}]

        if etype == "response.function_call_arguments.delta":
            delta = getattr(event, "delta", "") or ""
            if not delta:
                return []
            key = _key(event)
            entry = state.tool_args.setdefault(key, {"id": "", "name": "", "args": ""})
            entry["args"] += delta
            return [{"type": "tool_call_delta", "index": key, "delta": delta}]

        if etype == "response.function_call_arguments.done":
            key = _key(event)
            entry = state.tool_args.setdefault(key, {"id": "", "name": "", "args": ""})
            entry["args"] = getattr(event, "arguments", None) or entry["args"]
        return []


class CompletionHandler(ResponseEventHandler):
    """Turn end.

    ``completed`` / ``incomplete`` carry the final Response object and close the
    turn. ``failed`` and the mid-stream ``error`` event raise instead: a failed
    turn is terminal (not retryable — the attempt already reached the caller or
    the provider said the request itself was bad), and the provider's own
    message is what the user needs to see. One exception: a window overflow is
    normalized to ``context_window_exceeded`` (see ``_failure_code``), the code
    the loop answers by compacting the history and retrying the turn.
    """

    def handle(self, event: Any, state: ResponsesState) -> list[dict[str, Any]]:
        etype = getattr(event, "type", "")
        if etype == "response.completed":
            response = getattr(event, "response", None)
            state.finished = True
            state.finish_reason = self._reason(response, state)
            return [finish_event(state, reason=state.finish_reason, response=response)]
        if etype == "response.incomplete":
            response = getattr(event, "response", None)
            details = getattr(response, "incomplete_details", None)
            # max_output_tokens = the turn was truncated: report it as "length"
            # so the loop drops partial tool calls and asks for a concise retry.
            # Anything else (content_filter) ends the turn like a stop.
            reason = "length" if getattr(details, "reason", None) == "max_output_tokens" else "stop"
            state.finished = True
            state.finish_reason = reason
            return [finish_event(state, reason=reason, response=response)]
        if etype == "response.failed":
            error = getattr(getattr(event, "response", None), "error", None)
            code = str(getattr(error, "code", None) or "failed")
            message = str(getattr(error, "message", None) or "the provider reported a failed response")
            raise LlmError(code=_failure_code(code, message), retryable=False, message=message)
        if etype == "error":
            code = str(getattr(event, "code", None) or "error")
            message = str(getattr(event, "message", None) or "the provider reported an error")
            raise LlmError(code=_failure_code(code, message), retryable=False, message=message)
        return []

    @staticmethod
    def _reason(response: Any, state: ResponsesState) -> str:
        if state.tool_args or _response_tool_calls(response):
            return "tool_calls"
        return "stop"


def get_default_handlers() -> list[ResponseEventHandler]:
    return [ReasoningHandler(), ContentHandler(), ToolCallHandler(), CompletionHandler()]
