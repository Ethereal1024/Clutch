"""Offline view of what the extractor does with a saved page (no network).

Usage: python3 scripts/_html_peek.py FILE.html [chars]

Prints, for a saved HTML file: how many anchors the extractor rendered, how
many of a target path's blob links are real <a href> markup vs. JSON payload
text, and the head of the extracted text.
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

path = Path(sys.argv[1])
chars = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
html = path.read_text(encoding="utf-8", errors="replace")

title, text = ws.html_to_text(html, "https://github.com/vllm-project/vllm/tree/main/csrc")
links = re.findall(r"\]\((https?://[^)]+)\)", text)
print(f"file: {path}  ({len(html)} chars)")
print(f"title: {title!r}")
print(f"extracted: {len(text)} chars, {len(links)} markdown links")
for u in links[:10]:
    print("   ", u)

# Are those blob paths real anchors or JSON payload text?
real = re.findall(r'<a[^>]+href="(/vllm-project/vllm/blob/main/csrc/[^"]*)"', html)
payload = re.findall(r'"(?:href|url)":"(/vllm-project/vllm/blob/main/csrc/[^"]*)"', html)
print(f"<a href=...csrc/...> markup count: {len(real)}")
print(f"JSON-payload csrc urls: {len(payload)}")
# Where does the first blob path sit?
m = re.search(r"blob/main/csrc/[A-Za-z0-9_.\-/]+", html)
if m:
    lo = max(0, m.start() - 160)
    print("\ncontext around first blob path:\n", html[lo : m.end() + 80].replace("\n", " "))

print("\n--- extracted text head ---")
print(text[:chars])
