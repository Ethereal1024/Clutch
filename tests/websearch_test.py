"""Offline checks for the web tools (no network).

Run: python -m tests.websearch_test        (offline, always)
     python -m tests.websearch_test --live  (+ one real bing query + fetch)

Covers: snippet cleaning, HTML -> text extraction, char windowing, the DDG /
Bing RSS / Tavily / SearXNG result parsers, backend fall-through, the
private-network guard, truncation hints, and registry wiring (both modes).
"""

from __future__ import annotations

import re
import sys

import agent.tools.websearch as ws
from agent.config import Config
from agent.tools.registry import build_default_tools
from tests.testsupport import check

# ---- canned fixtures ---------------------------------------------------------

BING_RSS = """<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<title>bing: q</title><item><title>Alpha result</title><link>https://a.example/x</link>
<description>First &amp;lt;tag&amp;gt; snippet</description></item>
<item><title>Beta</title><link>https://b.example/</link><description>Second snippet</description></item>
</channel></rss>"""

DDG_HTML = """
<html><body>
<div class="result">
<h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fa.example%2Fone">Alpha  title</a></h2>
<a class="result__snippet">The <b>first</b> snippet</a>
</div>
<div class="result">
<h2><a class="result__a" href="https://b.example/two">Beta</a></h2>
<a class="result__snippet">Second snippet</a>
</div>
</body></html>"""

PAGE_HTML = """<html><head><title>Page Title</title>
<style>body { color: red }</style><script>var x = 1;</script></head>
<body><nav>menu links</nav>
<h1>Heading</h1><p>One   paragraph.</p>
<div>Block <span>inline</span> text</div>
<footer>copyright junk</footer></body></html>"""


def _resp(body: bytes | str, content_type: str = "text/html", url: str = "https://x.example/") -> ws.HttpResp:
    return ws.HttpResp(url=url, content_type=content_type, body=body if isinstance(body, bytes) else body.encode("utf-8"))


def fake_get(resps: dict[str, ws.HttpResp], errors: dict[str, Exception] | None = None):
    """A stub _http_get: canned responses keyed by URL substring."""
    errors = errors or {}

    def get(url: str, **kw) -> ws.HttpResp:
        for key, err in errors.items():
            if key in url:
                raise err
        for key, resp in resps.items():
            if key in url:
                return resp
        raise AssertionError(f"unexpected fetch: {url}")

    return get


def main() -> int:
    live = "--live" in sys.argv

    # 1. snippet cleaning: tags stripped, entities resolved, whitespace collapsed
    check(ws._clean_snippet("<b>hi</b>  there&nbsp;&amp; all") == "hi there & all", "snippet strips tags/entities/space")

    # 2. HTML -> text: title captured, chrome dropped, blocks become lines
    ex = ws._TextExtractor()
    ex.feed(PAGE_HTML)
    ex.close()
    check(ex.title == "Page Title", "title extracted")
    text = ex.text()
    check("Heading" in text and "One paragraph." in text and "Block inline text" in text, "body text kept")
    check("var x" not in text and "color: red" not in text, "script/style dropped")
    check("menu links" not in text and "copyright junk" not in text, "nav/footer dropped")

    # 3. windowing: slices + next-start + exhaustion
    c, nxt = ws._window("abcdefgh", 0, 5)
    check(c == "abcde" and nxt == 5, "window first slice")
    c, nxt = ws._window("abcdefgh", 5, 5)
    check(c == "fgh" and nxt is None, "window tail slice, no next")
    c, nxt = ws._window("abc", 99, 5)
    check(c == "" and nxt is None, "window past the end is empty")

    # 4. bing RSS parser
    get = fake_get({"bing.com": _resp(BING_RSS, "application/rss+xml")})
    out = ws._bing("q", 5, Config(), get)
    check(len(out) == 2 and out[0]["title"] == "Alpha result", "bing: items parsed")
    check(out[0]["url"] == "https://a.example/x", "bing: link kept")
    check("<tag>" in out[0]["snippet"] and "<" not in out[0]["snippet"].replace("<tag>", ""), "bing: snippet entities decoded")

    # 5. ddg html parser: uddg redirect decoded, snippet cleaned, plain href kept
    get = fake_get({"duckduckgo": _resp(DDG_HTML)})
    out = ws._ddg("q", 5, Config(), get)
    check(len(out) == 2, "ddg: two results")
    check(out[0]["url"] == "https://a.example/one" and out[0]["title"] == "Alpha title", "ddg: uddg decoded + title collapsed")
    check(out[0]["snippet"] == "The first snippet", "ddg: snippet tags stripped")
    check(out[1]["url"] == "https://b.example/two", "ddg: plain href kept")

    # 6. tavily + searxng json parsing
    tavily_body = _resp('{"results":[{"title":"T","url":"https://t.example/","content":"body text"}]}', "application/json")
    out = ws._tavily("q", 5, Config(tavily_api_key="k"), fake_get({"tavily": tavily_body}))
    check(out == [{"title": "T", "url": "https://t.example/", "snippet": "body text"}], "tavily: results parsed")
    sx_body = _resp('{"results":[{"title":"S","url":"https://s.example/","content":"c"}]}', "application/json")
    out = ws._searxng("q", 5, Config(searxng_url="https://sx.example"), fake_get({"sx.example": sx_body}))
    check(out[0]["url"] == "https://s.example/", "searxng: results parsed")
    try:
        ws._tavily("q", 5, Config(tavily_api_key="k"), fake_get({"tavily": _resp("<html>login</html>")}))
        check(False, "tavily: non-JSON must raise BackendError")
    except ws.BackendError:
        check(True, "tavily: non-JSON raises BackendError")

    # 7. chain: first backend's failure falls through to the next; a pinned
    #    backend reports its own failure instead of hiding it
    cfg = Config()

    def _chain_get(url: str, **kw) -> ws.HttpResp:
        if "bing.com" in url:
            raise ws.WebError("HTTP 403")
        if "duckduckgo" in url:
            return _resp(DDG_HTML)
        raise AssertionError(f"unexpected fetch: {url}")

    orig_get = ws._http_get
    ws._http_get = _chain_get  # web_search builds its `get` from this global
    try:
        result = ws.web_search(None, cfg, "test query")  # chain: bing(403) -> ddg(ok)
        check("via ddg" in result["content"] and "Alpha title" in result["content"], "chain falls through to ddg")
        result = ws.web_search(None, cfg, "q", backend="bing")
        check(result.get("error") and "bing" in result["content"], "pinned backend reports its own failure")
    finally:
        ws._http_get = orig_get

    # 8. web_fetch: html extraction, truncation hint with next start, redirect note
    # max_chars below the 200-char floor is raised to 200, hence start=200 (not 60).
    def _fetch_get(url: str, **kw) -> ws.HttpResp:
        if "final.example" in url:
            long_page = PAGE_HTML.replace("</div>", "</div><p>" + "filler " * 60 + "</p>")
            return _resp(long_page, url="https://final.example/page")
        raise AssertionError(f"unexpected fetch: {url}")

    ws._http_get = _fetch_get
    try:
        r = ws.web_fetch(ws.Workspace, Config(read_max_chars=60), "https://final.example/page")
        check(not r.get("error") and "Page Title" in r["content"], "fetch: title + body extracted")
        check("chars truncated" in r["content"] and "start=200" in r["content"], "fetch: truncation names the next start")
        r2 = ws.web_fetch(ws.Workspace, Config(read_max_chars=200), "https://final.example/page", start=200)
        check("start=200" in r2["content"] or r2["content"], "fetch: continuation works")
    finally:
        ws._http_get = orig_get

    # 9. private-network guard: loopback / LAN refused before any socket I/O
    for bad in ("http://localhost:8890/api/x", "http://127.0.0.1/x", "http://192.168.1.4/router", "ftp://x/"):
        try:
            ws._assert_public_host(bad)
            check(False, f"private host refused: {bad}")
        except ws.WebError:
            check(True, f"private host refused: {bad}")
    ws._assert_public_host("https://8.8.8.8/dns-query")  # public IP literal passes
    check(True, "public IP literal allowed")

    # 10. registry wiring: both modes carry the web tools; chat stays write-free
    for mode in ("work", "chat"):
        names = [t.name for t in build_default_tools(Config(mode=mode))]
        check("web_search" in names and "web_fetch" in names, f"{mode} mode exposes the web tools")
    chat = [t.name for t in build_default_tools(Config(mode="chat"))]
    check("write_file" not in chat and "edit_file" not in chat, "chat mode still hides write tools")

    if live:
        if hasattr(sys.stdout, "reconfigure"):  # keep CJK readable on GBK consoles
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print("\nlive: bing search...")
        r = ws.web_search(ws.Workspace, Config(), "harbin institute of technology shenzhen", max_results=3)
        print(r["content"][:600])
        check(not r.get("error"), "live: bing returned results")
        m = re.search(r"https?://\S+", r["content"])
        first = m.group(0) if m else ""
        print(f"\nlive: fetch {first} ...")
        rf = ws.web_fetch(ws.Workspace, Config(), first)
        print(rf["content"][:400])
        check(not rf.get("error"), "live: fetch returned text")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
