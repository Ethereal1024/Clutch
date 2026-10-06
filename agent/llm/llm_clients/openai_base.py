"""Shared OpenAI transport for the protocol clients.

Every configured endpoint speaks the openai SDK against the same host with the
same proxy handling, the same two timeout budgets and the same kernel keepalive;
the chat-completions client and the responses client differ only in which
resource they call and how the provider's stream is translated into our events.
Everything in here is transport, kept in one place so a budget fix lands for both.
"""

from __future__ import annotations

from typing import Collection

import httpx2
from openai import OpenAI

from .. import keepalive
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
        http_client = httpx2.Client(
            # the proxy has to sit on the transport, not on the client: given
            # both, httpx mounts the proxy over the transport and whatever the
            # transport was configured with becomes dead code
            transport=httpx2.HTTPTransport(proxy=proxy, trust_env=False),
            trust_env=False,
            timeout=timeout,
        )
        # the keepalive options go on the backend rather than on the transport:
        # httpcore2 2.12.0 drops transport-level socket_options for anything born
        # behind a proxy, and the backend is the one place every socket is born.
        # Those options matter most exactly when a proxy or a NAT silently drops
        # the connection (see ../keepalive.py)
        keepalive.install(http_client)
        self.timeout = timeout
        # max_retries=0: the SDK would otherwise retry every transport failure
        # (timeout / connection error / retryable status) up to its default of 2
        # times INSIDE one create() call, with its own backoff and log.debug-only
        # reporting. That is invisible to the caller: a dead route then burns up
        # to 3x the connect budget (~45s with the 15s connect timeout) before the
        # first notice could ever be shown. Retries belong to
        # stream_runner.run_streaming, which announces each one to the UI.
        self.client = OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client, max_retries=0)
        self.model = model
        # kept for endpoint_alive below: the probe has to go down the SAME path
        # as the stream (same base URL, same proxy decision), because that path
        # — not the provider in the abstract — is what a probe is asked about
        self.base_url = base_url

    def endpoint_alive(self, timeout: float = 6.0) -> bool:
        """Is anything still serving this base URL right now?

        Used by stream_runner's watchdog to tell a provider that is thinking from
        a path that has gone away: a trivial GET down the same path as the stream
        (same base URL, so the same proxy and the same tunnel hop). ANY HTTP
        response counts as alive — 200, 401, even a 404 for a route the endpoint
        does not implement — because the question is whether the transport
        reaches a peer at all, not what the peer thinks of the URL. A connect
        failure, a read timeout or a malformed reply is the "gone" verdict.

        It gets its own short-budget client on purpose: the streaming client's
        read budget (llm_read_timeout, 240s) is a budget for chunk gaps and would
        make the probe useless as a watchdog."""
        try:
            with httpx2.Client(
                transport=httpx2.HTTPTransport(proxy=get_proxy_for_url(self.base_url), trust_env=False),
                trust_env=False,
                timeout=timeout,
            ) as probe:
                probe.get(self.base_url.rstrip("/") + "/")
            return True
        except httpx2.HTTPError:
            # transport-level failure (refused / reset / timed out / bad reply)
            return False
        except Exception:  # noqa: BLE001 -- an unexpected probe failure is not a health verdict
            return False
