"""Shared OpenAI transport for the protocol clients.

Every configured endpoint speaks the openai SDK against the same host with the
same proxy handling and the same two timeout budgets; the chat-completions
client and the responses client differ only in which resource they call and how
the provider's stream is translated into our events. Everything in here is
transport, kept in one place so a budget fix lands for both.
"""

from __future__ import annotations

from typing import Collection

import httpx2
from openai import OpenAI

from ..client import LlmClient
from ..proxy import get_proxy_for_url


class BaseOpenaiClient(LlmClient):
    """HTTP/proxy/timeout plumbing for an OpenAI-protocol provider."""

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
