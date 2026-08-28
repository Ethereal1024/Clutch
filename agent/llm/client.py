"""LLM client: openai SDK against DeepSeek (OpenAI-compatible).

- API key comes from the environment only; never committed.
- Retry with backoff: network/rate-limit/5xx, bounded attempts.
- Errors normalized to LlmError; the caller decides retry vs abort.
- Proxy: resolved through our own env logic (see proxy.py) so the socks://
  scheme httpx cannot parse never reaches it.
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional

import httpx2
from openai import OpenAI

from .proxy import get_proxy_for_url

DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com"
MAX_RETRIES = 3
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
REQUEST_TIMEOUT = 60.0


@dataclass
class LlmError(Exception):
    code: str = "unknown"
    status: Optional[int] = None
    retryable: bool = False
    message: str = ""


class LlmClient(ABC):
    """Streaming chat client contract. ``stream`` emits the event protocol
    reasoning/text/tool_call_start/tool_call_delta/finish (see DeepSeekLlmClient)."""

    @abstractmethod
    def stream(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Iterator[Dict[str, Any]]: ...


class DeepSeekLlmClient(LlmClient):
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
    ) -> None:
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise RuntimeError("missing DEEPSEEK_API_KEY (env or argument)")
        # Build our own httpx transport: trust_env=False so httpx never reads the
        # ambient *proxy vars (socks:// would crash it); instead we feed it a single
        # proxy URL resolved through proxy.py, which skips unsupported schemes.
        proxy = get_proxy_for_url(base_url)
        http_client = httpx2.Client(proxy=proxy, trust_env=False, timeout=REQUEST_TIMEOUT)
        self.client = OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client)
        self.model = model

    def stream(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Streamed chat completion.

        Yields event dicts as tokens arrive:
          {"type":"reasoning","delta":str}          thinking tokens
          {"type":"text","delta":str}               content tokens
          {"type":"tool_call_start","index":..,"id":..,"name":..}
          {"type":"tool_call_delta","index":..,"delta":str}
          {"type":"finish","reason":str,"content":str,"tool_calls":[{id,name,arguments}]}
        """
        for attempt in range(MAX_RETRIES):
            try:
                kwargs: Dict[str, Any] = {"model": self.model, "messages": messages}
                if tools:
                    kwargs["tools"] = tools
                resp = self.client.chat.completions.create(**kwargs, stream=True)
                content_parts: List[str] = []
                tool_args: Dict[int, Dict[str, Any]] = {}

                for chunk in resp:
                    choice = chunk.choices[0] if chunk.choices else None
                    if choice is None:
                        continue
                    delta = choice.delta
                    if delta is None:
                        continue
                    reasoning = getattr(delta, "reasoning_content", None)
                    if reasoning:
                        yield {"type": "reasoning", "delta": reasoning}
                    if delta.content:
                        content_parts.append(delta.content)
                        yield {"type": "text", "delta": delta.content}
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            idx = tc.index
                            if idx not in tool_args:
                                tool_args[idx] = {
                                    "id": tc.id or "",
                                    "name": (tc.function.name if tc.function else "") or "",
                                    "args": "",
                                }
                                yield {
                                    "type": "tool_call_start",
                                    "index": idx,
                                    "id": tool_args[idx]["id"],
                                    "name": tool_args[idx]["name"],
                                }
                            entry = tool_args[idx]
                            if tc.id:
                                entry["id"] = tc.id
                            if tc.function and tc.function.name:
                                entry["name"] = tc.function.name
                            if tc.function and tc.function.arguments:
                                entry["args"] += tc.function.arguments
                                yield {
                                    "type": "tool_call_delta",
                                    "index": idx,
                                    "delta": tc.function.arguments,
                                }
                    if choice.finish_reason:
                        tool_calls = [
                            {
                                "id": entry["id"],
                                "name": entry["name"],
                                "arguments": entry["args"],
                            }
                            for entry in tool_args.values()
                        ]
                        yield {
                            "type": "finish",
                            "reason": choice.finish_reason,
                            "content": "".join(content_parts),
                            "tool_calls": tool_calls,
                        }
                        return
                # stream ended without finish (defensive)
                yield {
                    "type": "finish",
                    "reason": "stop",
                    "content": "".join(content_parts),
                    "tool_calls": [],
                }
                return
            except Exception as e:  # noqa: BLE001 -- classify then decide to retry
                last_err = _classify(e)
                if not last_err.retryable or attempt == MAX_RETRIES - 1:
                    raise last_err from e
                time.sleep((2**attempt) + attempt * 0.5)


def _classify(e: Exception) -> LlmError:
    """Normalize openai SDK exceptions into a structured LlmError."""
    import openai

    if isinstance(e, openai.RateLimitError):
        return LlmError(code="rate_limit", status=429, retryable=True, message=str(e))
    if isinstance(e, openai.APITimeoutError):
        return LlmError(code="timeout", retryable=True, message=str(e))
    if isinstance(e, openai.APIConnectionError):
        return LlmError(code="connection", retryable=True, message=str(e))
    if isinstance(e, openai.APIStatusError):
        status = e.status_code
        if status == 400 and "context" in str(e).lower():
            return LlmError(code="context_window_exceeded", status=400, retryable=False, message=str(e))
        return LlmError(
            code="api_error",
            status=status,
            retryable=status in RETRYABLE_STATUS,
            message=str(e),
        )
    return LlmError(code="unknown", retryable=False, message=str(e))
