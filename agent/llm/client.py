"""LLM client: openai SDK against DeepSeek (OpenAI-compatible).

- API key comes from the environment only; never committed.
- Retry with backoff: network/rate-limit/5xx, bounded attempts.
- Errors normalized to LlmError; the caller decides retry vs abort.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from openai import OpenAI

DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com"
MAX_RETRIES = 3
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


@dataclass
class LlmError(Exception):
    code: str = "unknown"
    status: Optional[int] = None
    retryable: bool = False
    message: str = ""


class LlmClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
    ) -> None:
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise RuntimeError("missing DEEPSEEK_API_KEY (env or argument)")
        self.client = OpenAI(api_key=self.api_key, base_url=base_url)
        self.model = model

    def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Single non-streaming chat completion; returns an OpenAI message dict."""
        last_err: LlmError | None = None
        for attempt in range(MAX_RETRIES):
            try:
                kwargs: Dict[str, Any] = {"model": self.model, "messages": messages}
                if tools:
                    kwargs["tools"] = tools
                resp = self.client.chat.completions.create(**kwargs)
                return resp.choices[0].message.model_dump(exclude_none=True)
            except Exception as e:  # noqa: BLE001 -- classify then decide to retry
                last_err = _classify(e)
                if not last_err.retryable or attempt == MAX_RETRIES - 1:
                    break
                time.sleep((2**attempt) + attempt * 0.5)
        assert last_err is not None
        raise last_err


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
