"""LLM client contract + error normalization.

- LlmClient is the streaming contract (see stream()); concrete providers live in
  llm_clients/ (OpenaiLlmClient) and are built through the factory (factory.py).
- Errors are normalized to LlmError; the caller decides retry vs abort.
- Proxy is resolved through our own env logic (see proxy.py) so the socks://
  scheme httpx cannot parse never reaches it.
"""

from __future__ import annotations

import ast
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Collection, Iterator

import httpx2
import openai


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


def is_context_overflow(*texts: str | None) -> bool:
    """True when a provider failure says the history no longer fits its window.

    Shared by BOTH wire protocols, because it is the one failure the loop
    answers by compacting and retrying instead of aborting the run. Providers
    word it differently — a chat-completions HTTP 400 whose message says
    "maximum context length", a failed Responses turn carrying
    code "context_length_exceeded" — so the check keys on the word itself
    rather than on a code, and every caller sees the same verdict.
    """
    return any("context" in t.lower() for t in texts if t)


def timeout_error(e: httpx2.TimeoutException) -> "LlmError":
    """One timeout, one actionable wording. The phase is what the user needs:
    a connect timeout points at routing / a proxy / the base_url (the "the
    network is down" case), a read timeout at the provider stalling its stream.

    Shared by both arrival paths — raw httpx2 exceptions raised while the SSE
    body is consumed, and the openai SDK's APITimeoutError, which wraps (and
    flattens to "Request timed out.") the very same underlying exception.
    """
    if isinstance(e, httpx2.ConnectTimeout):
        return LlmError(
            code="timeout",
            retryable=True,
            message=(
                "Connect timed out: no route to the API endpoint "
                "(network to the provider, a proxy, or the base_url)."
            ),
        )
    if isinstance(e, httpx2.PoolTimeout):
        return LlmError(
            code="timeout", retryable=True, message="Timed out waiting for a free connection slot."
        )
    return LlmError(
        code="timeout",
        retryable=True,
        message=(
            "Read timed out: the API sent no data for a long stretch "
            "(provider stall or a buffering relay)."
        ),
    )


def _unwrap(e: Exception) -> BaseException | None:
    """The exception the SDK's wrapper was raised from, if any (the SDK does
    ``raise APITimeoutError(...) from err``), else None."""
    return e.__cause__ or e.__context__


@dataclass
class LlmError(Exception):
    code: str = "unknown"
    status: int | None = None
    retryable: bool = False
    message: str = ""

    @staticmethod
    def classify(e: Exception, retryable_status: Collection[int]) -> LlmError:
        """Normalize openai SDK / httpx2 transport exceptions into a structured
        LlmError. The openai SDK only wraps errors raised while the *request* is
        being sent; errors raised while the SSE *body* is being consumed (a
        mid-stream stall past the read timeout, a sudden disconnect/reset, a
        truncated response) escape `Stream.__stream__` unwrapped (its try only
        closes the response), so they arrive here as raw httpx2 exceptions and
        must be mapped explicitly — otherwise they fall into the non-retryable
        "unknown" catch-all and a transient network blip kills the whole run.
        """
        if isinstance(e, openai.RateLimitError):
            return LlmError(code="rate_limit", status=429, retryable=True, message=_clean_provider_message(str(e), 429))
        if isinstance(e, openai.APITimeoutError):
            # the SDK wraps the httpx timeout that actually fired and flattens it
            # to "Request timed out."; unwrap it so the user reads the phase
            cause = _unwrap(e)
            if isinstance(cause, httpx2.TimeoutException):
                return timeout_error(cause)
            return LlmError(code="timeout", retryable=True, message=str(e))
        if isinstance(e, openai.APIConnectionError):
            # likewise: the SDK's own text is "Connection error."; the cause
            # names what actually failed (DNS, refused, TLS, a reset)
            cause = _unwrap(e)
            if isinstance(cause, httpx2.TransportError) and str(cause):
                return LlmError(code="connection", retryable=True, message=f"Cannot reach the API endpoint: {cause}")
            return LlmError(code="connection", retryable=True, message=str(e))
        if isinstance(e, openai.APIStatusError):
            status = e.status_code
            if status == 400 and is_context_overflow(str(e)):
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
        # httpx2 transport errors raised mid-stream (read timeout / reset / EOF /
        # remote protocol error). TimeoutException is itself a TransportError
        # subclass, so check it first to keep the more specific code. The phase
        # matters to the user: connect points at routing/proxy/base_url, read
        # at the provider stalling or buffering a streaming reply.
        if isinstance(e, httpx2.TimeoutException):
            return timeout_error(e)
        if isinstance(e, httpx2.TransportError):
            return LlmError(
                code="connection",
                retryable=True,
                message=f"Connection interrupted: {e}" if str(e) else "Connection interrupted.",
            )
        return LlmError(code="unknown", retryable=False, message=str(e))


class LlmClient(ABC):
    """Streaming chat client contract.

    ``stream`` emits the event protocol reasoning/text/tool_call_start/
    tool_call_delta/finish. ``cancel`` (the run's Stop event) is optional but
    real clients should pass it down: it arms the guard that interrupts a read
    blocked mid-attempt (see stream_runner.run_streaming).
    """

    @abstractmethod
    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        cancel: threading.Event | None = None,
    ) -> Iterator[dict[str, Any]]: ...
