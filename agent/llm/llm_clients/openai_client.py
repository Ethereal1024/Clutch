import time
from typing import Any, Collection, Iterator

import httpx2
from openai import OpenAI

from ..client import LlmClient, LlmError
from ..proxy import get_proxy_for_url
from .chunk_handle import ChunkHandler, StreamState, get_default_handlers


class OpenaiLlmClient(LlmClient):
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        handlers: list[ChunkHandler] | None = None,
        request_timeout: float = 60.0,
        max_retries: int = 3,
        retryable_status: Collection[int] = frozenset({429, 500, 502, 503, 504}),
        reasoning_effort: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.handlers = handlers if handlers else get_default_handlers()
        self.request_timeout = request_timeout
        self.max_retries = max_retries
        self.retryable_status = retryable_status
        self.reasoning_effort = reasoning_effort

        proxy = get_proxy_for_url(base_url)
        http_client = httpx2.Client(proxy=proxy, trust_env=False, timeout=self.request_timeout)
        self.client = OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client)
        self.model = model

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        # Streamed chat completion. finish carries the provider-reported token
        # usage (when available) so the loop can detect context overflow.
        for attempt in range(self.max_retries):
            try:
                kwargs: dict[str, Any] = {
                    "model": self.model,
                    "messages": messages,
                    "stream_options": {"include_usage": True},
                }
                if tools:
                    kwargs["tools"] = tools
                # GLM-5.3 thinking depth (zhipu). Only set when configured: an
                # unset knob leaves the provider default (e.g. DeepSeek ignores
                # the field entirely, so it must not be sent to them).
                if self.reasoning_effort:
                    kwargs["extra_body"] = {
                        "thinking": {
                            "type": "enabled",
                            "reasoning_effort": self.reasoning_effort,
                        }
                    }
                resp = self.client.chat.completions.create(**kwargs, stream=True)
                state = StreamState()
                pending_finish: dict[str, Any] | None = None

                for chunk in resp:
                    usage = getattr(chunk, "usage", None)
                    if usage is not None:
                        state.usage = {
                            "prompt_tokens": usage.prompt_tokens,
                            "completion_tokens": usage.completion_tokens,
                            "total_tokens": usage.total_tokens,
                        }
                    if state.finished:
                        continue  # keep draining until the usage chunk arrives
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

                finish = pending_finish
                if finish is None:  # stream ended without a finish chunk (defensive)
                    finish = {
                        "type": "finish",
                        "reason": "stop",
                        "content": "".join(state.content_parts),
                        "tool_calls": [
                            {"id": e["id"], "name": e["name"], "arguments": e["args"]} for e in state.tool_args.values()
                        ],
                    }
                finish["usage"] = state.usage
                yield finish
            except Exception as e:  # noqa: BLE001 -- classify then decide to retry
                last_err = LlmError.classify(e, self.retryable_status)
                if not last_err.retryable or attempt == self.max_retries - 1:
                    raise last_err from e
                time.sleep((2**attempt) + attempt * 0.5)
