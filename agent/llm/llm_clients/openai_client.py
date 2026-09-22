from typing import Any, Iterator

from .chunk_handle import StreamState, get_default_handlers
from .openai_base import BaseOpenaiClient
from .stream_runner import run_streaming


class OpenaiLlmClient(BaseOpenaiClient):
    """Chat-completions provider — the default wire protocol (DeepSeek and the
    rest of the OpenAI-compatible field speak it)."""

    # chunk handlers carry no state of their own between chunks
    handlers = get_default_handlers()

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        # Streamed chat completion. The retry policy — including why a retry is
        # only safe before the first token of an attempt — lives in
        # stream_runner.run_streaming; this method only builds the request and
        # translates chunks into events.
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
        # reasoning_effort: only set when configured (provider default otherwise)
        if self.reasoning_effort:
            kwargs["extra_body"] = {
                "thinking": {
                    "type": "enabled",
                    "reasoning_effort": self.reasoning_effort,
                }
            }
        yield from run_streaming(
            lambda: self._attempt(kwargs),
            max_retries=self.max_retries,
            retryable_status=self.retryable_status,
        )

    def _attempt(self, kwargs: dict[str, Any]) -> Iterator[dict[str, Any]]:
        """One request/response pass: yields events, ends with exactly one finish."""
        resp = self.client.chat.completions.create(**kwargs, stream=True)
        state = StreamState()
        pending_finish: dict[str, Any] | None = None

        for chunk in resp:
            if state.finished:
                break  # finish chunk received; nothing left to drain
            if not getattr(chunk, "choices", None):
                continue
            for handler in self.handlers:
                for event in handler.handle(chunk, state):
                    if event["type"] == "finish":
                        pending_finish = event
                    else:
                        yield event
            if state.finished:
                break

        if pending_finish is None:  # stream ended without a finish chunk (defensive)
            pending_finish = {
                "type": "finish",
                "reason": "stop",
                "content": "".join(state.content_parts),
                "tool_calls": [
                    {"id": e["id"], "name": e["name"], "arguments": e["args"]} for e in state.tool_args.values()
                ],
            }
        yield pending_finish
