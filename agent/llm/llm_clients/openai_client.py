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
    ) -> None:
        self.api_key = api_key
        self.handlers = handlers if handlers else get_default_handlers()
        self.request_timeout = request_timeout
        self.max_retries = max_retries
        self.retryable_status = retryable_status

        proxy = get_proxy_for_url(base_url)
        http_client = httpx2.Client(proxy=proxy, trust_env=False, timeout=self.request_timeout)
        self.client = OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client)
        self.model = model

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        # Streamed chat completion.
        for attempt in range(self.max_retries):
            try:
                kwargs: dict[str, Any] = {"model": self.model, "messages": messages}
                if tools:
                    kwargs["tools"] = tools
                resp = self.client.chat.completions.create(**kwargs, stream=True)
                state = StreamState()

                for chunk in resp:
                    if not getattr(chunk, "choices", None):
                        continue
                    events = []
                    for handler in self.handlers:
                        events.extend(handler.handle(chunk, state))
                    for event in events:
                        yield event
                    if state.finished:
                        return
                # stream ended without finish (defensive)
                if not state.finished:
                    tool_calls = [
                        {"id": entry["id"], "name": entry["name"], "arguments": entry["args"]}
                        for entry in state.tool_args.values()
                    ]
                    yield {
                        "type": "finish",
                        "reason": "stop",
                        "content": "".join(state.content_parts),
                        "tool_calls": tool_calls,
                    }
            except Exception as e:  # noqa: BLE001 -- classify then decide to retry
                last_err = LlmError.classify(e, self.retryable_status)
                if not last_err.retryable or attempt == self.max_retries - 1:
                    raise last_err from e
                time.sleep((2**attempt) + attempt * 0.5)
