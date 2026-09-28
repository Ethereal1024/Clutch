"""Kernel-keepalive checks for the LLM transport (loopback only).

Run: uv run python -m tests.llm_keepalive_test

Why this exists: a route change under a live request (a second NIC taking the
default route, a NAT that drops the old address) black-holes the connection
silently — no FIN, no RST, no ICMP — so a read sat there until the 240s
llm_read_timeout expired and only then did the user learn anything. The fix is
KEEPALIVE socket options on the ONE httpx client the transport builds; this
suite pins three things that a "looks wired up" diff can still get wrong:

  1. the option set: right shape, accepted by THIS kernel, and a total
     watchdog well under llm_read_timeout (a refused option would fail every
     connect, so nothing may be assumed about the platform)
  2. the wrapper: it adds the options to the backend call and stays transparent
     to the connection's own options (no network here)
  3. the real client, a real request: the options are on the LIVE socket, not
     just on a config tuple (this is what the kernel probes)
  4. a proxied endpoint: the same, for the case httpcore2 2.12.0 gets wrong —
     a proxied connection's socket only gets the options from our backend
     wrapper (the module docstring of llm/keepalive.py names the library's
     line), so this section asserts rather than reports

Sections 3 and 4 talk to 127.0.0.1 only — no internet, no key, no quota.
"""

from __future__ import annotations

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent.config import Config
from agent.llm import keepalive
from agent.llm.llm_clients.openai_client import OpenaiLlmClient
from tests.testsupport import check

# httpx2 proxies loopback hosts directly (see llm/proxy.py), so a proxied
# endpoint has to be addressed by name; the name never resolves — the request
# goes to the local proxy and stops there
PROXIED_BASE_URL = "http://llm.invalid"


# ---- a loopback server the transport can actually talk to -------------------


class _Handler(BaseHTTPRequestHandler):
    """Answers the two requests the checks make and nothing else."""

    # HTTP/1.1 keeps the connection alive in the pool after the response —
    # HTTP/1.0 would close it and leave the pool empty to inspect
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # a banner-free test run
        pass

    def _reply(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        # a chat completion, shaped the way the openai SDK parses one
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._reply(
            {
                "id": "chatcmpl-local",
                "object": "chat.completion",
                "created": 0,
                "model": "m",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "hi"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    def do_GET(self) -> None:
        self._reply({"data": []})


def _serve() -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _pool_entries(pool) -> list:
    connections = getattr(pool, "_connections", None)
    if connections is None:
        raise AssertionError("httpcore pool has no _connections (internals moved)")
    if isinstance(connections, dict):  # origin -> [connection, ...]
        return [c for group in connections.values() for c in group]
    return list(connections)


def _live_socket(http_client) -> socket.socket:
    """The raw socket a finished keep-alive request left idle in the pool.

    Deliberately reaching through the stack: what matters is the socket the
    KERNEL probes, and nothing above it can prove the option landed there. The
    walk is explicit so a moved internal fails with a message naming it rather
    than an AttributeError.
    """
    pool = getattr(http_client._transport, "_pool", None)
    entries = _pool_entries(pool)
    if not entries:
        raise AssertionError("no pooled connection to inspect (server closed it?)")
    node = entries[0]
    for _ in range(6):  # HTTPConnection / ForwardHTTPConnection -> HTTP11Connection
        node = getattr(node, "_connection", None)
        stream = getattr(node, "_network_stream", None)
        if stream is not None and hasattr(stream, "_sock"):
            return stream._sock
    raise AssertionError("could not reach the live socket (httpcore internals moved)")


def _options_on(sock: socket.socket) -> dict[str, int]:
    """Every keepalive knob this platform exposes, read back off a live socket."""
    knobs = {
        "SO_KEEPALIVE": (socket.SOL_SOCKET, socket.SO_KEEPALIVE),
        "idle": (socket.IPPROTO_TCP, _idle_option()),
        "TCP_KEEPINTVL": (socket.IPPROTO_TCP, getattr(socket, "TCP_KEEPINTVL", None)),
        "TCP_KEEPCNT": (socket.IPPROTO_TCP, getattr(socket, "TCP_KEEPCNT", None)),
    }
    return {
        name: sock.getsockopt(level, option)
        for name, (level, option) in knobs.items()
        if option is not None
    }


def _idle_option() -> int | None:
    option = getattr(socket, "TCP_KEEPIDLE", None) or getattr(socket, "TCP_KEEPALIVE", None)
    return option


def _check_options_shape() -> None:
    """Section 1: the option set, and what this kernel does with it."""
    print("\n[1] the option set")
    options = keepalive.socket_options()
    check(keepalive.socket_options() is options, "the option set is computed once (cached)")
    check((socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1) in options, "keepalive is switched on")
    idle_option = _idle_option()
    if idle_option is None:
        print("!! skip: this platform exposes no keepalive idle knob")
    else:
        check((socket.IPPROTO_TCP, idle_option, keepalive.KEEPALIVE_IDLE) in options, "the idle knob is set")
    for name, value in (
        ("TCP_KEEPINTVL", keepalive.KEEPALIVE_INTERVAL),
        ("TCP_KEEPCNT", keepalive.KEEPALIVE_COUNT),
    ):
        option = getattr(socket, name, None)
        if option is None:
            print(f"!! skip: this platform exposes no {name}")
            continue
        check((socket.IPPROTO_TCP, option, value) in options, f"{name} is set")
    # a refused option fails socket.create_connection in httpcore, so every
    # option handed to the transport must apply cleanly to a fresh socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        applied = True
        for option in options:
            try:
                probe.setsockopt(*option)
            except OSError:
                applied = False
        check(applied, "this kernel accepts every option we hand the transport")
    dead_after = keepalive.DEAD_AFTER_SECONDS
    check(
        dead_after < Config().llm_read_timeout,
        f"a black hole is reported in {dead_after}s, well inside the {Config().llm_read_timeout}s read budget",
    )


class _RecordingBackend:
    """Stands in for httpcore's SyncBackend and records what it was asked to do."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.slept: list[float] = []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.calls.append(
            {
                "host": host,
                "port": port,
                "timeout": timeout,
                "local_address": local_address,
                "socket_options": socket_options,
            }
        )
        return object()

    def connect_unix_socket(self, path, timeout=None, socket_options=None):
        self.calls.append({"path": path, "timeout": timeout, "socket_options": socket_options})
        return object()

    def sleep(self, seconds) -> None:
        self.slept.append(seconds)


def _check_wrapper() -> None:
    """Section 2: the backend wrapper, with a recording stand-in backend.

    Two properties, neither of which needs a network: our options ride along on
    the connect call (otherwise the wrapper would be a no-op that still passes
    every live-socket check when the pool happens to get its options elsewhere),
    and the connection's own options survive the wrapper — the wrapper has to be
    invisible to everything that is not keepalive.
    """
    print("\n[2] the backend wrapper")
    inner = _RecordingBackend()
    backend = keepalive.KeepaliveBackend(inner)
    backend.connect_tcp("example.com", 443)
    check(
        tuple(inner.calls[-1]["socket_options"]) == keepalive.socket_options(),
        "the wrapper hands the keepalive options to the backend's connect",
    )
    check(
        inner.calls[-1]["host"] == "example.com" and inner.calls[-1]["port"] == 443,
        "the wrapper passes the connection through unchanged",
    )
    own = (socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    backend.connect_tcp("example.com", 443, local_address="0.0.0.0", socket_options=[own])
    merged = inner.calls[-1]["socket_options"]
    check(own in merged, "an option the connection asked for itself survives the wrapper")
    check(all(option in merged for option in keepalive.socket_options()), "the keepalive set is still there")
    off = (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 0)
    backend.connect_tcp("example.com", 443, socket_options=[off])
    merged = inner.calls[-1]["socket_options"]
    check(
        off in merged and (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1) not in merged,
        "a connection that names the same knob itself wins over our value",
    )
    check(len(merged) == len(set(merged)), "the merged set carries no duplicate option")
    backend.connect_unix_socket("/tmp/x.sock")
    check(
        tuple(inner.calls[-1]["socket_options"]) == keepalive.socket_options(),
        "the unix-socket path gets them too",
    )
    # httpcore may call sleep on the pool's backend (retry backoff): delegating
    # is the whole contract of a wrapper
    backend.sleep(0.0)
    check(inner.slept == [0.0], "sleep is delegated to the wrapped backend")


def _check_live_socket() -> None:
    """Section 3: the options on the socket of a real, completed request."""
    print("\n[3] the live socket of a real request")
    srv = _serve()
    base_url = f"http://127.0.0.1:{srv.server_address[1]}"
    client = OpenaiLlmClient(api_key="test", base_url=base_url, model="m")
    try:
        # the app's own path: the SDK, its http_client, one ordinary call
        reply = client.client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
        check(reply.choices[0].message.content == "hi", "the loopback server answered through the real client")
        http_client = client.client._client
        check(http_client._transport is not None, "the client rides on the transport we built")
        sock = _live_socket(http_client)
        seen = _options_on(sock)
        check(seen.get("SO_KEEPALIVE") == 1, "the live socket has keepalive on")
        if "idle" in seen:
            check(
                seen["idle"] == keepalive.KEEPALIVE_IDLE,
                f"the live socket idles at {seen['idle']}s (not the OS default)",
            )
        if "TCP_KEEPINTVL" in seen:
            check(seen["TCP_KEEPINTVL"] == keepalive.KEEPALIVE_INTERVAL, "the live socket probes every 5s")
        if "TCP_KEEPCNT" in seen:
            check(seen["TCP_KEEPCNT"] == keepalive.KEEPALIVE_COUNT, "the live socket gives up after 3 probes")
    finally:
        client.client.close()
        srv.shutdown()
        srv.server_close()


def _check_proxied_socket() -> None:
    """Section 4: a proxied connection's socket — the case B exists for.

    httpcore2 2.12.0 never passes transport-level socket_options to a proxied
    connection (HTTPProxy.create_connection; upstream, still true in httpcore
    master), so a proxied endpoint only gets its keepalive from our backend
    wrapper. Both halves are asserted: the wrapper is installed on the proxy
    pool, and the socket the proxied request rides on really carries the options
    — that is the socket the kernel probes, and the day our injection silently
    stops working this section goes red instead of a route change silently
    costing the full read budget again.
    """
    print("\n[4] a proxied endpoint")
    srv = _serve()
    proxy = f"http://127.0.0.1:{srv.server_address[1]}"
    # http_proxy wins over all_proxy in llm/proxy.py, and an ambient one would
    # send this request at whatever the developer has configured: pin every
    # spelling of "use a proxy" at the local server for the duration
    env_names = ("http_proxy", "no_proxy", "all_proxy")
    keys = [name for base in env_names for name in (base, base.upper())]
    saved = {name: os.environ.get(name) for name in keys}
    for name in env_names:
        os.environ[name] = proxy if name != "no_proxy" else ""
        os.environ.pop(name.upper(), None)
    client = None
    try:
        client = OpenaiLlmClient(api_key="test", base_url=PROXIED_BASE_URL, model="m")
        http_client = client.client._client
        pool = http_client._transport._pool
        check(getattr(pool, "_proxy_url", None) is not None, "the endpoint goes through the proxy transport")
        check(
            isinstance(pool._network_backend, keepalive.KeepaliveBackend),
            "the proxy pool's network backend is the keepalive wrapper",
        )
        # asked for by absolute URI, so the request lands on the local proxy
        check(http_client.get(PROXIED_BASE_URL + "/v1/models").status_code == 200, "the proxy answered")
        sock = _live_socket(http_client)
        seen = _options_on(sock)
        check(seen.get("SO_KEEPALIVE") == 1, "the proxied socket has keepalive on")
        # the wrapper sits BELOW the pool, so it must leave keep-alive reuse alone:
        # a second request rides the same pooled connection, same socket
        check(http_client.get(PROXIED_BASE_URL + "/v1/models").status_code == 200, "the proxy answered again")
        check(_live_socket(http_client) is sock, "the wrapper leaves proxy connection reuse intact")
        if "idle" in seen:
            check(
                seen["idle"] == keepalive.KEEPALIVE_IDLE,
                f"the proxied socket idles at {seen['idle']}s (not the OS default)",
            )
        if "TCP_KEEPINTVL" in seen:
            check(seen["TCP_KEEPINTVL"] == keepalive.KEEPALIVE_INTERVAL, "the proxied socket probes every 5s")
        if "TCP_KEEPCNT" in seen:
            check(seen["TCP_KEEPCNT"] == keepalive.KEEPALIVE_COUNT, "the proxied socket gives up after 3 probes")
    finally:
        if client is not None:
            client.client.close()
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        srv.shutdown()
        srv.server_close()


def main() -> int:
    _check_options_shape()
    _check_wrapper()
    _check_live_socket()
    _check_proxied_socket()
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
