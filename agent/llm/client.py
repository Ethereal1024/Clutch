"""LLM client contract + error normalization.

- LlmClient is the streaming contract (see stream()); concrete providers live in
  llm_clients/ (OpenaiLlmClient) and are built through the factory (factory.py).
- Errors are normalized to LlmError; the caller decides retry vs abort.
- Proxy is resolved through our own env logic (see proxy.py) so the socks://
  scheme httpx cannot parse never reaches it.
"""

from __future__ import annotations

import ast
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Collection, Iterator


def _clean_provider_message(raw: str, status: int | None) -> str:
    """Tidy an OpenAI-SDK error string. The SDK renders HTTP failures as
    ``Error code: 429 - {'error': {'message': …, 'code': …}}`` (a Python repr
    of the provider's JSON); surface the provider's own message instead of
    that dump. Anything that does not parse stays verbatim."""
    text = raw.strip()
    _, sep, body = text.partition(" - ")
    if not sep:
        return text
    try:
        data = ast.literal_eval(body)
    except (ValueError, SyntaxError):
        return text
    err = data.get("error") if isinstance(data, dict) else None
    if not (isinstance(err, dict) and isinstance(err.get("message"), str) and err["message"].strip()):
        return text
    extra = []
    if err.get("code"):
        extra.append(f"code {err['code']}")
    if status is not None:
        extra.append(f"HTTP {status}")
    tidied = err["message"].strip()
    return f"{tidied} ({', '.join(extra)})" if extra else tidied


@dataclass
class LlmError(Exception):
    code: str = "unknown"
    status: int | None = None
    retryable: bool = False
    message: str = ""

    @staticmethod
    def classify(e: Exception, retryable_status: Collection[int]) -> LlmError:
        """Normalize openai SDK exceptions into a structured LlmError."""
        import openai

        if isinstance(e, openai.RateLimitError):
            return LlmError(code="rate_limit", status=429, retryable=True, message=_clean_provider_message(str(e), 429))
        if isinstance(e, openai.APITimeoutError):
            return LlmError(code="timeout", retryable=True, message=str(e))
        if isinstance(e, openai.APIConnectionError):
            return LlmError(code="connection", retryable=True, message=str(e))
        if isinstance(e, openai.APIStatusError):
            status = e.status_code
            if status == 400 and "context" in str(e).lower():
                return LlmError(
                    code="context_window_exceeded",
                    status=400,
                    retryable=False,
                    message=_clean_provider_message(str(e), status),
                )
            return LlmError(
                code="api_error",
                status=status,
                retryable=status in retryable_status,
                message=_clean_provider_message(str(e), status),
            )
        return LlmError(code="unknown", retryable=False, message=str(e))


class LlmClient(ABC):
    """Streaming chat client contract.

    ``stream`` emits the event protocol reasoning/text/tool_call_start/
    tool_call_delta/finish.
    """

    @abstractmethod
    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]: ...
