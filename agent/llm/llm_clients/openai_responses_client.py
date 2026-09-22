"""Responses-API provider (``POST /v1/responses``).

A second wire protocol behind the same client contract. Chat completions cannot
carry what the Responses API exposes first-class — typed stream events, reasoning
text, function calls announced as items — and providers are moving to it:
DeepSeek serves /responses for Codex compatibility **on the very same base_url**
as its chat-completions API, so switching is a one-field change for the user.

Three format differences are bridged here; nothing downstream notices:

- the conversation is a flat list of ITEMS (message / function_call /
  function_call_output) instead of ``[{role, content}]``, and the system prompt
  is the top-level ``instructions`` string (servers turn it into the first
  system message);
- tools are flat (``{type, name, description, parameters}``) — there is no
  nested ``function`` object as in chat completions;
- the stream is a typed event feed; its translation lives in response_handle.py.

History is replayed as the visible transcript, which is exactly what the loop's
event log holds: message text, function calls and their outputs. Reasoning items
are NOT replayed — DeepSeek merges plaintext reasoning given in the input into
the adjacent assistant message and needs nothing back, while a provider that
demands the reasoning item alongside a replayed function_call (OpenAI's
reasoning models with ``store=False``) reports that as an error, which surfaces
as-is rather than being papered over here.
"""

from __future__ import annotations

from typing import Any, Iterator

from .openai_base import BaseOpenaiClient
from .response_handle import ResponsesState, finish_event, get_default_handlers
from .stream_runner import run_streaming

# The knob's levels are the chat protocol's (low/medium/max); the Responses API
# names its top level "high". Anything else passes through untouched.
_REASONING_EFFORT = {"low": "low", "medium": "medium", "max": "high"}


def _text_of(content: Any) -> str:
    """Chat-style message content (a plain string everywhere in this repo) -> text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # defensive: a provider-shaped content list
        return "".join(block.get("text", "") for block in content if isinstance(block, dict))
    return ""


def to_responses_input(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Chat-completions history -> (instructions, input items).

    Plain-string message content is used (both protocols' item types accept a
    string), so no input_text/output_text block typing can mismatch a role.
    """
    instructions: list[str] = []
    items: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            text = _text_of(msg.get("content"))
            if text:
                instructions.append(text)
        elif role in ("user", "assistant"):
            text = _text_of(msg.get("content"))
            if text:
                items.append({"role": role, "content": text})
            for call in msg.get("tool_calls") or []:
                fn = call.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.get("id") or "",
                        "name": fn.get("name") or "",
                        "arguments": fn.get("arguments") or "",
                    }
                )
        elif role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id") or "",
                    "output": _text_of(msg.get("content")),
                }
            )
    return "\n\n".join(instructions), items


def to_responses_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Chat-completions function schemas -> flat Responses tools."""
    tools = []
    for schema in schemas:
        fn = schema.get("function") or {}
        tool: dict[str, Any] = {
            "type": "function",
            "name": fn.get("name") or "",
            "parameters": fn.get("parameters") or {},
        }
        if fn.get("description"):
            tool["description"] = fn["description"]
        tools.append(tool)
    return tools


class OpenaiResponsesLlmClient(BaseOpenaiClient):
    """Responses provider: same transport, same events, different wire format."""

    # event handlers carry no state of their own between events
    handlers = get_default_handlers()

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        # The retry policy (and why a retry is only safe before the first event
        # of an attempt) lives in stream_runner.run_streaming; this method only
        # builds the request and the handler list translates the event feed.
        instructions, items = to_responses_input(messages)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": items,
            "stream": True,
            # our own event log IS the history: never retain a conversation
            # server-side (stateless providers report store: false anyway)
            "store": False,
        }
        if instructions:
            kwargs["instructions"] = instructions
        if tools:
            kwargs["tools"] = to_responses_tools(tools)
        # reasoning_effort: only set when configured (provider default otherwise)
        if self.reasoning_effort:
            kwargs["reasoning"] = {"effort": _REASONING_EFFORT.get(self.reasoning_effort, self.reasoning_effort)}
        yield from run_streaming(
            lambda: self._attempt(kwargs),
            max_retries=self.max_retries,
            retryable_status=self.retryable_status,
        )

    def _attempt(self, kwargs: dict[str, Any]) -> Iterator[dict[str, Any]]:
        """One request/response pass: yields events, ends with exactly one finish."""
        state = ResponsesState()
        for event in self.client.responses.create(**kwargs):
            for handler in self.handlers:
                for out in handler.handle(event, state):
                    yield out
            if state.finished:
                return
        # the feed ended without a terminal event (a relay that dropped it):
        # report what arrived instead of leaving the turn without a finish
        yield finish_event(state)
