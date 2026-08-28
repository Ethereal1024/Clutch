"""Environment proxy resolution for the LLM client.

httpx cannot parse the `socks://` scheme (crashes with "Unknown scheme for proxy
URL") and openai's bundled httpx trusts ambient proxy env vars. So we read only the
protocol-specific proxy vars ourselves, skip socks proxies (httpx has no SOCKS
support), and respect no_proxy with a simple host/domain match.

Usage: `get_proxy_for_url("https://api.deepseek.com")` returns a proxy URL string
for httpx, or None for "connect directly".
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlparse

SOCK_SCHEMES = ("socks://", "socks4://", "socks4a://", "socks5://", "socks5h://")


def _env(key: str) -> str:
    return os.environ.get(key.lower(), "") or os.environ.get(key.upper(), "")


def _no_proxy_match(hostname: str) -> bool:
    """True if hostname is excluded by no_proxy (comma-separated host/domain entries)."""
    no_proxy = _env("no_proxy").strip()
    if not no_proxy or no_proxy == "*":
        return False
    for entry in no_proxy.split(","):
        entry = entry.strip().lstrip("*")
        if not entry:
            continue
        if hostname == entry or hostname.endswith("." + entry):
            return True
    return False


def get_proxy_for_url(input_url: str) -> Optional[str]:
    """Return an httpx-compatible proxy URL for the target, or None (direct)."""
    parsed = urlparse(input_url)
    if parsed.scheme not in ("http", "https"):
        return None
    hostname = parsed.hostname or ""
    if not hostname or _no_proxy_match(hostname):
        return None
    if hostname in ("127.0.0.1", "localhost", "::1"):
        # loopback never needs a proxy (e.g. the client-side LLM proxy via SSH -R)
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
