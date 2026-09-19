import time
from typing import Any, Collection, Iterator

import httpx2
from openai import OpenAI

from ..client import LlmClient, LlmError
from ..proxy import get_proxy_for_url
from .chunk_handle import StreamState, get_default_handlers


class OpenaiLlmClient(LlmClient):
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        request_timeout: float = 60.0,
        read_timeout: float = 240.0,
        max_retries: int = 3,
        retryable_status: Collection[int] = frozenset({429, 500, 502, 503, 504}),
        reasoning_effort: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.handlers = get_default_handlers()
        self.request_timeout = request_timeout
        self.read_timeout = read_timeout
        self.max_retries = max_retries
        self.retryable_status = retryable_status
        self.reasoning_effort = reasoning_effort

        proxy = get_proxy_for_url(base_url)
        # split budgets (a single float would set read=connect): connect fails
        # fast on dead routes, read tolerates long streaming chunk gaps — the
        # "good network, frequent request timed out" case is a read-budget
        # problem, not a connect one (see Config.llm_read_timeout)
        timeout = httpx2.Timeout(
            self.request_timeout, connect=min(15.0, self.request_timeout), read=self.read_timeout
        )
        http_client = httpx2.Client(proxy=proxy, trust_env=False, timeout=timeout)
        self.timeout = timeout
        self.client = OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client)
        self.model = model

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        # Streamed chat completion.
        #
        # Transport failures raised while the SSE body is being consumed (read
        # timeout / reset / truncated response) escape the openai SDK unwrapped
        # as raw httpx2 exceptions (see LlmError.classify); this loop turns them
        # into a retry. A retry restarts the request from scratch, so it is only
        # safe when NOTHING of this attempt has reached the caller yet — retrying
        # after a partial stream would re-emit already-delivered text and
        # duplicate it in the transcript. A failure after the first token is
        # therefore raised immediately (clear error instead of a silent stall);
        # a failure before it retries with backoff, yielding a
        # {"type": "retry", ...} notice first so the caller/UI can show
        # "reconnecting…" instead of looking frozen until the next attempt dies.
        attempts = max(1, int(self.max_retries))
        for attempt in range(attempts):
            delivered = False
            try:
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
                                delivered = True
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
                yield finish
                return  # this attempt completed the turn: never start another one
            except Exception as e:  # noqa: BLE001 -- classify then decide to retry
                last_err = LlmError.classify(e, self.retryable_status)
                if not last_err.retryable or delivered or attempt == attempts - 1:
                    if not delivered and last_err.retryable:
                        # all attempts exhausted: say so instead of a bare transport message
                        last_err.message = f"{last_err.message} (after {attempts} attempts)"
                    raise last_err from e
                # announce the retry before the backoff sleep so the caller/UI can
                # show the recovery process instead of a silent stall
                yield {
                    "type": "retry",
                    "attempt": attempt + 1,
                    "max": attempts,
                    "code": last_err.code,
                    "message": f"{last_err.message} — retrying ({attempt + 1}/{attempts})",
                }
                time.sleep((2**attempt) + attempt * 0.5)
