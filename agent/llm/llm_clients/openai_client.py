from __future__ import annotations

import threading
from typing import Any, Iterator

from .chunk_handle import StreamState, get_default_handlers
from .openai_base import BaseOpenaiClient
from .stream_runner import Attempt, run_streaming


class OpenaiLlmClient(BaseOpenaiClient):
    """Chat-completions provider — the default wire protocol (DeepSeek and the
    rest of the OpenAI-compatible field speak it)."""

    # chunk handlers carry no state of their own between chunks
    handlers = get_default_handlers()

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        cancel: threading.Event | None = None,
    ) -> Iterator[dict[str, Any]]:
        # Streamed chat completion. The retry policy — when a mid-stream failure
        # is worth another request, and how Stop interrupts a read blocked
        # mid-attempt — lives in stream_runner.run_streaming; this method only
        # builds the request and translates chunks into events.
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
            lambda: self._open(kwargs),
            max_retries=self.max_retries,
            retryable_status=self.retryable_status,
            # our consumers (the agent loop, the compactor) honor the discard
            # flag of the retry notice: they drop what a dead attempt streamed,
            # so a drop in the middle of an answer becomes a reconnect instead
            # of the end of the run
            mid_stream_retry=True,
            cancel=cancel,
        )

    def _open(self, kwargs: dict[str, Any]) -> Attempt:
        """Issue the request eagerly and hand back events + the kill switch.

        Eager matters: the attempt factory runs between retries, so a Stop that
        lands during backoff is honored before the next request is even sent.
        The openai Stream's own close() is the connection closer the guard uses
        to break a read that is already blocked."""
        resp = self.client.chat.completions.create(**kwargs, stream=True)
        return Attempt(events=self._events(resp), close=resp.close)

    def _events(self, resp) -> Iterator[dict[str, Any]]:
        """Translate one response stream into events, ending with exactly one finish."""
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
