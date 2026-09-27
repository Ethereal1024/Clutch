"""Probe: does a page's visible text carry its links, or only its embedded JSON?

Usage: python3 scripts/_link_probe.py URL [URL ...]

For each URL prints: extracted-text length, markdown-link count, and the number
of absolute http(s) URLs sitting inside <script> payloads that the extractor
currently throws away.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ws", Path(__file__).resolve().parent.parent / "clutch-websearch" / "websearch.py"
)
ws = importlib.util.module_from_spec(spec)
sys.modules["ws"] = ws
spec.loader.exec_module(ws)

SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.S | re.I)
ABS_URL_RE = re.compile(r"https?://[^\s\"'<>\\)]+")

for url in sys.argv[1:]:
    try:
        resp = ws._http_get(url, timeout=20, allow_private=False)
    except Exception as e:  # noqa: BLE001
        print(f"{url}\n   FETCH FAILED: {type(e).__name__}: {e}")
        continue
    html = ws._decode_body(resp.body, resp.content_type)
    _title, text = ws.html_to_text(html, resp.url)
    links = re.findall(r"\]\((https?://[^)]+)\)", text)
    script_urls: set[str] = set()
    for blob in SCRIPT_RE.findall(html):
        script_urls.update(ABS_URL_RE.findall(blob))
    print(f"{resp.url}\n   text={len(text)} chars, {len(links)} markdown links, "
          f"{len(script_urls)} absolute URLs inside <script>")
    print(f"   sample script urls: {sorted(script_urls)[:4]}")
