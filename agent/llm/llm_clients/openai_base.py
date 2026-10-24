"""Shared OpenAI transport for the protocol clients.

Every configured endpoint speaks the openai SDK against the same host with the
same proxy handling, the same two timeout budgets and the same kernel keepalive;
the chat-completions client and the responses client differ only in which
resource they call and how the provider's stream is translated into our events.
Everything in here is transport, kept in one place so a budget fix lands for both.
"""

from __future__ import annotations

import threading
from typing import Any, Collection

import httpx2
from openai import OpenAI

from .. import keepalive
from ..client import LlmClient
from ..proxy import get_proxy_for_url


def _close_quietly(obj: Any) -> None:
    """Close a response/client we may be racing: any outcome is fine, and the
    only thing it is for (unblocking a parked read) has no failure mode."""
    try:
        obj.close()
    except Exception:  # noqa: BLE001 -- a close that lost a race is not an error
        pass


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

        # the endpoint is mutable (repoint below): the lock guards the swap, and
        # _live is every response currently streaming down the OLD one, so a
        # re-point can break a read that no reconnect could reach
        self._lock = threading.Lock()
        self._live: dict[int, Any] = {}
        self.model = model
        self.base_url = base_url
        # kept for endpoint_alive below: the probe has to go down the SAME path
        # as the stream (same base URL, same proxy decision), because that path
        # — not the provider in the abstract — is what a probe is asked about
        self.client = self._connect(base_url)

    def _connect(self, base_url: str) -> OpenAI:
        """Build the SDK client for one endpoint — the only construction site.

        One function for the first endpoint and every re-point after it: the
        proxy decision is per-URL (get_proxy_for_url), so a client built any
        other way would keep the previous endpoint's routing."""
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
        # the wrapper is this endpoint's ONLY lever on a read that is already
        # parked: it remembers every socket the endpoint opened, so a re-point
        # can shut them down (repoint below, and keepalive.interrupt's docstring
        # for why closing the response is not enough)
        self._sockets = keepalive.install(http_client)
        self.timeout = timeout
        # max_retries=0: the SDK would otherwise retry every transport failure
        # (timeout / connection error / retryable status) up to its default of 2
        # times INSIDE one create() call, with its own backoff and log.debug-only
        # reporting. That is invisible to the caller: a dead route then burns up
        # to 3x the connect budget (~45s with the 15s connect timeout) before the
        # first notice could ever be shown. Retries belong to
        # stream_runner.run_streaming, which announces each one to the UI.
        return OpenAI(api_key=self.api_key, base_url=base_url, http_client=http_client, max_retries=0)

    # ---- live attempts + endpoint re-point ----

    def _track(self, resp: Any) -> None:
        """Remember one in-flight response: it is the only handle a re-point has
        on a read that is already parked in its budget."""
        with self._lock:
            self._live[id(resp)] = resp

    def _release(self, resp: Any) -> None:
        """Forgot one response and close it. Safe from any thread, any number of
        times: it is both the Attempt's own closer and the re-point's lever."""
        with self._lock:
            self._live.pop(id(resp), None)
        _close_quietly(resp)

    def repoint(self, base_url: str, model: str | None = None) -> bool:
        """Move this client to another endpoint IN PLACE; True when it moved.

        The reason this exists: a REMOTE session's LLM endpoint is decided by the
        client that claimed it (the phone's own proxy at the end of an SSH
        reverse forward), and that client can lose the port it lent us — a hop
        that died without a FIN leaves the far sshd holding the old listener, so
        the next reverse forward lands somewhere else. The session's --base-url
        was frozen at spawn (agent/supervisor.py start_session), and a process
        that cannot be re-pointed is a run that can never be recovered: the
        session outlives the tunnel (300s stale window) while every attempt it
        makes goes down a path nobody serves any more.

        So the endpoint becomes mutable state: swap the SDK client, then BREAK
        every read still riding the old one. That break is the point — a thread
        parked in a read against a path that is gone will not return for its
        whole budget (llm_read_timeout), and no reconnect on the far end can
        reach it.

        Two kinds of parked read, and both have to go:
          - one the SDK has already handed back (``_live``): its response is
            closed, which releases the connection;
          - one that has not even got its response HEAD yet (create() is still
            blocked, so nothing is registered anywhere): only the SOCKET can
            reach that one. It is also the exact shape of a hop that accepts a
            connection and then says nothing, so it is not a corner case —
            keepalive's wrapper owns every socket this endpoint opened and
            ``interrupt()`` shuts them down (closing a response does NOT wake a
            recv that is already blocked; measured, see keepalive.py).

        The retry policy then sees a transport failure and the redial issues the
        request down the NEW endpoint (``source()`` reads ``self.client`` when
        it runs, not when the stream started).

        ``endpoint_alive`` follows along for the same reason: after a re-point
        the watchdog's question ("is anything still serving this base_url?")
        must be about the endpoint we are now using."""
        base_url = (base_url or "").strip()
        if not base_url:
            return False
        model = (model or "").strip() or None
        with self._lock:
            if base_url == self.base_url and (model is None or model == self.model):
                return False
            old = self.client
            old_sockets = self._sockets
            self.base_url = base_url
            if model is not None:
                self.model = model
            self.client = self._connect(base_url)  # also re-arms self._sockets
            stranded = list(self._live.values())
            self._live.clear()
        if old_sockets is not None:
            # before the closes: shutdown is what wakes a blocked recv, and it
            # has to land while the descriptor still belongs to that read
            old_sockets.interrupt()
        for resp in stranded:
            _close_quietly(resp)
        _close_quietly(old)
        return True

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
        base = self.base_url  # one read: a re-point mid-probe must not split the pair
        try:
            with httpx2.Client(
                transport=httpx2.HTTPTransport(proxy=get_proxy_for_url(base), trust_env=False),
                trust_env=False,
                timeout=timeout,
            ) as probe:
                probe.get(base.rstrip("/") + "/")
            return True
        except httpx2.HTTPError:
            # transport-level failure (refused / reset / timed out / bad reply)
            return False
        except Exception:  # noqa: BLE001 -- an unexpected probe failure is not a health verdict
            return False
