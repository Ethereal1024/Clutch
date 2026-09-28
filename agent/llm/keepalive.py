"""Kernel TCP keepalive for the LLM transport.

A route that changes under a live request (a second NIC taking the default
route, a NAT that drops the old source address) can black-hole an established
connection: no FIN, no RST, no ICMP, so the read just blocks until httpx's
llm_read_timeout expires — minutes of silence where the user sees a spinner.
The kernel is the only layer that can notice such a socket, because keepalive
probes are answered by the peer's kernel and an unanswered one *is* the
liveness answer.

Budgets: idle 20s + 3 probes every 5s ≈ 35s to report a black hole, far below
the 240s read budget and far above any legitimate quiet moment (a model
thinking between chunks is silent for tens of seconds while its kernel keeps
answering probes).

Nothing here is assumed about the platform: a refused socket option makes
`socket.create_connection` fail in httpcore (it applies these right after
connect), so every option is probed on a throwaway socket first and only the
accepted ones are handed to the transport.

A gap in the library, worked around here rather than by it: httpcore2 2.12.0's
HTTPProxy takes socket_options but its create_connection never passes them to
the proxied connection (same code in httpcore's master — the options reach
ForwardHTTPConnection/TunnelHTTPConnection, which accept them, from nobody), and
ConnectionPool's own proxy branches drop them the same way, so `socket_options=`
on the transport covers every socket EXCEPT the ones born behind a proxy.

So the options are applied at the one place all of those sockets share: every
connection class, proxied or not, asks the pool's NetworkBackend for its socket,
and install() wraps that backend. It reaches two private names (httpx's
HTTPTransport._pool, httpcore's ConnectionPool._network_backend) and therefore
raises instead of quietly reverting to the 240s budget when they move;
tests/llm_keepalive_test.py section 4 pins the proxied case. Delete the wrapper
the day httpcore forwards socket_options on its own.
"""

from __future__ import annotations

import functools
import socket
from collections.abc import Iterable
from typing import Any

# 20s idle, then 3 probes 5s apart -> a black hole is a dead socket in ~35s.
KEEPALIVE_IDLE = 20
KEEPALIVE_INTERVAL = 5
KEEPALIVE_COUNT = 3
# what the two knobs above add up to: how long a silently dropped peer can hold
# a read open. Kept as a name so the test can pin it against llm_read_timeout.
DEAD_AFTER_SECONDS = KEEPALIVE_IDLE + KEEPALIVE_INTERVAL * KEEPALIVE_COUNT


def _accepted(sock: socket.socket, level: int, option: int, value: int) -> bool:
    """Whether THIS kernel takes this socket option at this value."""
    try:
        sock.setsockopt(level, option, value)
    except OSError:
        return False
    return True


@functools.lru_cache(maxsize=None)
def socket_options(
    idle: int = KEEPALIVE_IDLE,
    interval: int = KEEPALIVE_INTERVAL,
    count: int = KEEPALIVE_COUNT,
) -> tuple[tuple[int, int, int], ...]:
    """The keepalive socket options this host accepts, as httpx socket_options.

    Cached: the result can only change with the interpreter's platform, and
    every LLM client construction would otherwise repeat the syscalls.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if not _accepted(probe, socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1):
            # no keepalive concept at all: better no options than a transport
            # whose every connect raises
            return ()
        options = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
        # the idle knob is spelled two ways: TCP_KEEPIDLE (Linux, Windows 10
        # 1709+) and TCP_KEEPALIVE (the BSDs, macOS)
        idle_option = getattr(socket, "TCP_KEEPIDLE", None) or getattr(socket, "TCP_KEEPALIVE", None)
        knobs = [
            (idle_option, idle),
            (getattr(socket, "TCP_KEEPINTVL", None), interval),
            (getattr(socket, "TCP_KEEPCNT", None), count),
        ]
        for option, value in knobs:
            if option is not None and _accepted(probe, socket.IPPROTO_TCP, option, value):
                options.append((socket.IPPROTO_TCP, option, value))
    return tuple(options)


def _merged(caller_options: Iterable[tuple] | None) -> tuple[tuple, ...]:
    """Our keepalive options plus the caller's, with the caller's value winning.

    httpcore hands a connection's own socket options through the same kwarg, so
    the two sets meet here. A knob the connection names itself is left to it (it
    asked for something more specific than "on"): ours go on first, the caller's
    after, and the duplicate is dropped so no option is set twice.
    """
    ours = socket_options()
    if not caller_options:
        return ours
    named = {(option[0], option[1]) for option in caller_options}
    return (*(option for option in ours if (option[0], option[1]) not in named), *caller_options)


class KeepaliveBackend:
    """A network backend that adds the keepalive options to every socket it opens.

    Wraps whatever backend the pool already had (httpcore's own SyncBackend,
    normally), so nothing about the connection changes except the options the
    socket is born with. httpcore only ever calls connect_tcp,
    connect_unix_socket and sleep on it.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[tuple] | None = None,
    ) -> Any:
        return self._inner.connect_tcp(
            host,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=_merged(socket_options),
        )

    def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Iterable[tuple] | None = None
    ) -> Any:
        return self._inner.connect_unix_socket(path, timeout=timeout, socket_options=_merged(socket_options))

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


def install(client: Any) -> None:
    """Put KeepaliveBackend in front of every socket this httpx client opens.

    Raising here is deliberate: the two private names it reaches for are an
    implementation detail of the installed httpx, and losing the watchdog
    quietly is the exact failure mode this module exists to remove — a route
    change would go back to holding a read for the full llm_read_timeout with no
    signal anywhere. tests/llm_keepalive_test.py fails on the same change.
    """
    pool = getattr(getattr(client, "_transport", None), "_pool", None)
    if pool is None:
        raise RuntimeError("keepalive: the httpx client exposes no transport pool to install on")
    inner = getattr(pool, "_network_backend", None)
    if inner is None:
        raise RuntimeError("keepalive: the httpcore pool exposes no network backend to wrap")
    if not isinstance(inner, KeepaliveBackend):
        pool._network_backend = KeepaliveBackend(inner)
