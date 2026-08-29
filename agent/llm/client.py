"""LLM client contract + error normalization.

- LlmClient is the streaming contract (see stream()); concrete providers live in
  llm_clients/ (OpenaiLlmClient) and are built through the factory (factory.py).
- Errors are normalized to LlmError; the caller decides retry vs abort.
- Proxy is resolved through our own env logic (see proxy.py) so the socks://
  scheme httpx cannot parse never reaches it.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Collection, Iterator


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
            return LlmError(code="rate_limit", status=429, retryable=True, message=str(e))
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
                    message=str(e),
                )
            return LlmError(
                code="api_error",
                status=status,
                retryable=status in retryable_status,
                message=str(e),
            )
        return LlmError(code="unknown", retryable=False, message=str(e))


class LlmClient(ABC):
    @abstractmethod
    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]: ...
