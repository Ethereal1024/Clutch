"""Probe the keyless search backends: how often do they actually answer, and
with what? Usage: python3 scripts/_backend_probe.py "query" [runs]
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ws", Path(__file__).resolve().parent.parent / "clutch-websearch" / "websearch.py"
)
ws = importlib.util.module_from_spec(spec)
sys.modules["ws"] = ws
spec.loader.exec_module(ws)

query = sys.argv[1]
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
s = ws.load_settings()

for name in ("bing", "ddg"):
    ok = 0
    for i in range(runs):
        try:
            r = ws.all_backends()[name].search(query, 5, s, ws._http_get)
            ok += 1
            print(f"{name} run{i}: {len(r)} items, first={r[0]['url']}")
        except Exception as e:  # noqa: BLE001
            print(f"{name} run{i}: FAILED {type(e).__name__}: {str(e)[:200]}")
    print(f"-- {name}: {ok}/{runs} answered\n")

# raw shape of the ddg answer, once
try:
    resp = ws._http_get(
        "https://html.duckduckgo.com/html/?" + ws.urllib.parse.urlencode({"q": query}),
        timeout=s.timeout,
        allow_private=True,
    )
    body = ws._decode_body(resp.body, resp.content_type)
    print("ddg raw:", resp.content_type, len(resp.body), "bytes;",
          "anomaly" if "anomaly" in body.lower() else "no-anomaly-marker",
          "| result__a count:", body.count("result__a"))
    print(body[:400].replace("\n", " "))
except Exception as e:  # noqa: BLE001
    print("ddg raw FAILED:", type(e).__name__, str(e)[:200])
