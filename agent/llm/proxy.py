"""Environment proxy resolution for the LLM client.

Adapted from opencode's proxy-env.ts (which is itself a port of the
proxy-from-env npm package). Two differences from the naive `httpx2` behavior:

1. We read ONLY the protocol-specific lowercase/uppercase proxy vars
   (https_proxy / HTTP_PROXY ...) plus all_proxy, like opencode, instead of
   letting httpx parse every `*_proxy` variable itself. httpx2 (the client the
   openai SDK bundles) cannot parse the `socks://` scheme and raises
   "Unknown scheme for proxy URL" when ALL_PROXY=socks://... is present.
2. Any proxy value whose scheme is socks/socks5/socks5h is skipped (httpx has
   no built-in SOCKS support), so a socks-only environment falls back to a
   direct connection instead of crashing.

Usage: `get_proxy_for_url("https://api.deepseek.com")` returns a proxy URL
string for httpx, or None for "connect directly".
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlparse

DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}
SOCK_SCHEMES = ("socks://", "socks4://", "socks4a://", "socks5://", "socks5h://")


def _env(key: str) -> str:
    return os.environ.get(key.lower(), "") or os.environ.get(key.upper(), "")


def _should_proxy(hostname: str, port: int) -> bool:
    no_proxy = _env("no_proxy").lower()
    if not no_proxy:
        return True
    if no_proxy == "*":
        return False
    for entry in no_proxy.split(","):
        entry = entry.strip().split()[0] if entry.strip() else ""
        if not entry:
            continue
        parsed_host, parsed_port = entry, None
        if ":" in entry:
            parsed_host, _, port_str = entry.rpartition(":")
            parsed_port = int(port_str) if port_str.isdigit() else None
        if parsed_port is not None and parsed_port != port:
            continue
        if not parsed_host.startswith("*"):
            if hostname == parsed_host:
                return False
        elif hostname.endswith(parsed_host[1:]):
            return False
    return True


def get_proxy_for_url(input_url: str) -> Optional[str]:
    """Return an httpx-compatible proxy URL for the target, or None (direct)."""
    parsed = urlparse(input_url)
    if parsed.scheme not in DEFAULT_PORTS:
        return None
    hostname = parsed.hostname or ""
    port = parsed.port or DEFAULT_PORTS[parsed.scheme]
    if not _should_proxy(hostname, port):
        return None

    proxy = _env(f"{parsed.scheme}_proxy") or _env("all_proxy")
    if not proxy:
        return None
    if any(proxy.lower().startswith(s) for s in SOCK_SCHEMES):
        # httpx cannot use SOCKS; fall back to a direct connection
        return None
    if "://" in proxy:
        return proxy
    return f"{parsed.scheme}://{proxy}"
