"""clutch-websearch behavior: extraction, parsers, the chain, the guards.

Offline by design — every HTTP hop is either an injected `get` or the local
stub server. Run: python3 -m pytest (or, from the repo root, pytest).
"""

from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

import websearch as ws
from tests.stub_server import start_stub

MODULE = Path(__file__).resolve().parent.parent / "websearch.py"

# ---- fixtures ---------------------------------------------------------------

BING_RSS = """<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<title>bing: q</title><item><title>Alpha result</title><link>https://a.example/x</link>
<description>First &amp;lt;tag&amp;gt; snippet</description></item>
<item><title>Beta</title><link>https://b.example/</link><description>Second snippet</description></item>
</channel></rss>"""

# the postmortem's silent failure: a real RSS, real items, wrong market
BING_UNRELATED = """<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<title>bing: q</title><item><title>在粉笔工作是一种什么体验？ - 知乎</title>
<link>https://www.zhihu.com/question/1</link><description>粉笔申论和小马哥申论该听哪个</description></item>
<item><title>求一份2025下小学教资资料</title><link>https://www.fenbi.com/x</link>
<description>教资备考</description></item></channel></rss>"""

DDG_HTML = """
<html><body>
<div class="result">
<h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fleggedrobotics%2Fsru-navigation-learning">sru-navigation-learning</a></h2>
<a class="result__snippet">The <b>official</b> sru-navigation-learning repository</a>
</div>
<div class="result">
<h2><a class="result__a" href="https://b.example/two">leggedrobotics sru</a></h2>
<a class="result__snippet">sru-navigation-learning mirror</a>
</div>
</body></html>"""

TAVILY_JSON = json.dumps(
    {"results": [{"title": "Tavily hit", "url": "https://t.example/1", "content": "<b>bold</b> &amp; clean"}]}
).encode()

SEARXNG_JSON = json.dumps(
    {"results": [{"title": "Searxng hit", "url": "https://s.example/1", "content": "a snippet"}]}
).encode()


def resp(url="https://example.com/", body: bytes = b"", ctype: str = "text/plain") -> ws.HttpResp:
    return ws.HttpResp(url=url, content_type=ctype, body=body)


# ---- extraction: the P0 fix -------------------------------------------------


def test_extraction_keeps_links_as_markdown():
    page = '<html><body><p>Code:</p><a href="https://github.com/leggedrobotics/sru">GitHub</a></body></html>'
    _, text = ws.html_to_text(page)
    assert "[GitHub](https://github.com/leggedrobotics/sru)" in text


def test_extraction_resolves_relative_and_uses_image_alt():
    html = '<a href="/orgs/leggedrobotics/repos"><img alt="GitHub" src="x.png"></a>'
    _, text = ws.html_to_text(html, "https://michaelfyang.github.io/sru-project-website/")
    assert "[GitHub](https://michaelfyang.github.io/orgs/leggedrobotics/repos)" in text


def test_extraction_drops_dead_hrefs_but_keeps_the_label():
    html = '<a href="javascript:void(0)">Menu</a><a href="#top">Top</a><a href="mailto:a@b.c">Mail</a>'
    _, text = ws.html_to_text(html, "https://example.com/p")
    assert "Menu" in text and "javascript" not in text and "mailto" not in text
    assert "(#" not in text


def test_extraction_drops_chrome_and_reads_title():
    html = "<html><head><title>SRU</title><style>x{}</style></head><body><nav>skip me</nav><p>Body text</p></body></html>"
    title, text = ws.html_to_text(html)
    assert title == "SRU"
    assert "Body text" in text
    assert "skip me" not in text and "x{}" not in text


def test_bare_url_link_is_not_duplicated():
    html = '<a href="https://example.com/a">https://example.com/a</a>'
    _, text = ws.html_to_text(html)
    assert text.count("https://example.com/a") == 1


def test_snippet_cleaning_strips_tags_and_collapses_space():
    assert ws._clean_snippet("a <b>bold</b>  &amp;\n tail") == "a bold & tail"


# ---- parsers ----------------------------------------------------------------


def test_bing_rss_parses_items():
    out = ws._bing("q", 5, ws.Settings(), lambda url, **kw: resp(body=BING_RSS.encode(), ctype="application/rss+xml"))
    assert [r["url"] for r in out] == ["https://a.example/x", "https://b.example/"]
    assert out[0]["snippet"] == "First <tag> snippet"


def test_bing_market_follows_the_query_script():
    seen: list[tuple[str, dict]] = []

    def get(url, **kw):
        seen.append((url, kw.get("headers") or {}))
        return resp(body=BING_RSS.encode(), ctype="application/rss+xml")

    ws._bing("python release notes", 5, ws.Settings(), get)
    url, headers = seen[0]
    assert "ensearch=1" in url and "mkt=en-US" in url
    assert headers["Accept-Language"].startswith("en-US")

    seen.clear()
    ws._bing("上海 天气", 5, ws.Settings(), get)
    url, headers = seen[0]
    assert "mkt=zh-CN" in url and "setlang=zh-hans" in url and "ensearch" not in url
    assert headers["Accept-Language"].startswith("zh-CN")


def test_ddg_parser_unwraps_the_redirect():
    out = ws._ddg("q", 5, ws.Settings(), lambda url, **kw: resp(body=DDG_HTML.encode(), ctype="text/html"))
    assert out[0]["url"] == "https://github.com/leggedrobotics/sru-navigation-learning"
    assert out[0]["title"] == "sru-navigation-learning"
    assert out[1]["url"] == "https://b.example/two"


def test_tavily_and_searxng_parse_json():
    tv = ws._tavily("q", 5, ws.Settings(tavily_api_key="k"), lambda url, **kw: resp(body=TAVILY_JSON, ctype="application/json"))
    assert tv[0]["snippet"] == "bold & clean"
    sx = ws._searxng("q", 5, ws.Settings(searxng_url="http://sx"), lambda url, **kw: resp(body=SEARXNG_JSON))
    assert sx[0]["title"] == "Searxng hit"


def test_backends_report_empty_as_backend_error():
    empty = lambda url, **kw: resp(body=b"<rss><channel></channel></rss>", ctype="application/rss+xml")
    with pytest.raises(ws.BackendError):
        ws._bing("q", 5, ws.Settings(), empty)


# ---- the relevance guard (P1) ----------------------------------------------


def test_guard_rejects_unrelated_results():
    junk = [{"title": "在粉笔工作是一种什么体验？ - 知乎", "url": "https://www.zhihu.com/question/1", "snippet": "教资备考"}]
    assert not ws.looks_relevant("michaelfyang sru-navigation-learning github", junk)


def test_guard_accepts_overlap_in_url_title_or_snippet():
    hit = [{"title": "whatever", "url": "https://github.com/leggedrobotics/sru-navigation-learning", "snippet": ""}]
    assert ws.looks_relevant("michaelfyang sru-navigation-learning github", hit)
    assert ws.looks_relevant("上海 天气", [{"title": "上海天气预报", "url": "https://t.example/", "snippet": ""}])
    assert not ws.looks_relevant("上海 天气", [{"title": "Beijing forecast", "url": "https://b.example/", "snippet": ""}])


def test_guard_never_judges_a_stopword_only_query():
    assert ws.looks_relevant("the of", [{"title": "anything", "url": "https://x.example/", "snippet": ""}])


def test_unrelated_backend_falls_through_instead_of_succeeding():
    def get(url, **kw):
        if "bing.com" in url:
            return resp(body=BING_UNRELATED.encode(), ctype="application/rss+xml")
        return resp(body=DDG_HTML.encode(), ctype="text/html")

    r = ws.search("michaelfyang sru-navigation-learning github", settings=ws.Settings(), get=get)
    assert r["backend"] == "ddg"  # bing was tried and rejected, not returned
    assert r["results"][0]["url"].startswith("https://github.com/leggedrobotics/")


def test_pinned_unrelated_backend_reports_the_guard():
    get = lambda url, **kw: resp(body=BING_UNRELATED.encode(), ctype="application/rss+xml")  # noqa: E731
    r = ws.search("michaelfyang sru-navigation-learning github", backend="bing", settings=ws.Settings(), get=get)
    assert "share no term" in r["failures"][0]["reason"]


# ---- chain plumbing ---------------------------------------------------------


def test_search_rejects_empty_query_and_unavailable_backend():
    assert ws.search("  ", settings=ws.Settings())["error"] == "query is required"
    r = ws.search("x", backend="tavily", settings=ws.Settings())
    assert "not available" in r["error"] and "available: bing, ddg" in r["error"]


def test_configured_backends_lead_the_chain():
    assert ws.available_backends(ws.Settings()) == ("bing", "ddg")
    assert ws.available_backends(ws.Settings(tavily_api_key="k", searxng_url="http://sx")) == (
        "tavily",
        "searxng",
        "bing",
        "ddg",
    )
    assert ws.missing_backends(ws.Settings()) == ("tavily", "searxng")


def test_search_text_renders_results_and_failure_reasons():
    get = lambda url, **kw: resp(body=SEARXNG_JSON)  # noqa: E731
    ok = ws.search_text("q", settings=ws.Settings(searxng_url="http://sx"), get=get)
    assert ok["content"] == "1 results for 'q' (via searxng):\n\n1. Searxng hit\n   https://s.example/1\n   a snippet"

    def dead(url, **kw):
        raise ws.WebError("connection refused")

    bad = ws.search_text("q", settings=ws.Settings(tavily_api_key="k"), get=dead)
    assert bad["error"] and bad["content"].startswith("ERROR: all search backends failed")
    assert "- tavily: connection refused" in bad["content"]


def test_results_are_deduped_by_url():
    dup = json.dumps({"results": [{"title": "a", "url": "https://x/1", "content": "x"}] * 3}).encode()
    r = ws.search("q", settings=ws.Settings(searxng_url="http://sx"), get=lambda url, **kw: resp(body=dup))
    assert len(r["results"]) == 1


# ---- fetch ------------------------------------------------------------------


def test_fetch_windows_and_hints_the_next_start():
    page = b"x" * 300
    r = ws.fetch("https://example.com/p", max_chars=200, get=lambda url: resp(body=page))
    assert r["text"] == "x" * 200 and r["next_start"] == 200 and r["remaining"] == 100
    text = ws.fetch_text("https://example.com/p", max_chars=200, get=lambda url: resp(body=page))["content"]
    assert "fetch again with start=200" in text


def test_fetch_reports_the_redirect_target():
    r = ws.fetch_text("https://start.example/", get=lambda url: resp(url="https://final.example/page", body=b"hi"))
    assert r["content"] == "(redirected to https://final.example/page)\n\nhi"


def test_fetch_extracts_html_with_title_and_links():
    html = b'<html><head><title>T</title></head><body><p>See</p><a href="https://github.com/leggedrobotics/sru">GitHub</a></body></html>'
    r = ws.fetch_text("https://example.com/p", get=lambda url: resp(body=html, ctype="text/html"))
    assert r["content"].startswith("# T")
    assert "[GitHub](https://github.com/leggedrobotics/sru)" in r["content"]


def test_fetch_refuses_binary_and_empty_url():
    r = ws.fetch("https://example.com/i.png", get=lambda url: resp(body=b"\x89PNG", ctype="image/png"))
    assert "unsupported content-type" in r["error"]
    assert ws.fetch("")["error"] == "url is required"


def test_private_host_guard_and_its_escape_hatch(monkeypatch):
    for bad in ("http://127.0.0.1:8080/x", "http://localhost/x", "http://192.168.1.10/x", "http://[::1]/x"):
        with pytest.raises(ws.WebError, match="non-public host refused"):
            ws._assert_public_host(bad)
    # a public host still passes (DNS stubbed: no network in this suite)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("93.184.216.34", 0))])
    ws._assert_public_host("http://example.com/")

    r = ws.fetch("http://127.0.0.1:1/x")  # default: refused before any connection
    assert "non-public host refused" in r["error"]

    class _Fake:
        def read(self, n):
            return b""

        def geturl(self):
            return "http://127.0.0.1:1/x"

        headers: dict = {}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ws, "_open", lambda request, **kw: _Fake())
    r = ws.fetch("http://127.0.0.1:1/x", settings=ws.Settings(allow_private_hosts=True))
    assert "error" not in r


# ---- transport: retry, cap, gzip -------------------------------------------


def test_one_retry_on_timeout_only_for_get(monkeypatch):
    calls: list[str] = []

    def timed_out(request, *, timeout, allow_private):
        calls.append(request.get_method())
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr(ws, "_open", timed_out)
    with pytest.raises(ws.WebError, match="timed out"):
        ws._http_get("http://example.com/", allow_private=True)
    assert calls == ["GET", "GET"]

    calls.clear()
    with pytest.raises(ws.WebError):
        ws._http_get("http://example.com/", method="POST", allow_private=True)
    assert calls == ["POST"]

    calls.clear()
    monkeypatch.setattr(
        ws, "_open", lambda request, **kw: (_ for _ in ()).throw(urllib.error.URLError("connection refused"))
    )
    with pytest.raises(ws.WebError, match="connection refused"):
        ws._http_get("http://example.com/", allow_private=True)
    assert calls == []


def test_response_size_cap_and_gzip_decode(monkeypatch):
    class _Fake:
        def __init__(self, body: bytes, headers: dict | None = None):
            self.body, self.headers, self._done = body, headers or {}, False

        def read(self, n):
            if self._done:
                return b""
            self._done = True
            return self.body

        def geturl(self):
            return "http://example.com/"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ws, "_open", lambda request, **kw: _Fake(b"y" * 100))
    with pytest.raises(ws.WebError, match="exceeds 10 bytes"):
        ws._http_get("http://example.com/", max_bytes=10, allow_private=True)

    monkeypatch.setattr(ws, "_open", lambda request, **kw: _Fake(gzip.compress(b"hello"), {"Content-Encoding": "gzip"}))
    assert ws._http_get("http://example.com/", allow_private=True).body == b"hello"


# ---- the CLI over real sockets ---------------------------------------------


def _run(*args: str, **env: str) -> subprocess.CompletedProcess:
    """Run the module CLI as a real subprocess (the contract the model uses)."""
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("CLUTCH_TAVILY", "TAVILY_", "CLUTCH_SEARXNG", "SEARXNG_"))}
    clean.update(env)
    return subprocess.run([sys.executable, str(MODULE), *args], capture_output=True, text=True, env=clean, timeout=60)


def test_cli_backends_lists_usable_and_names_the_unconfigured():
    p = _run("backends")
    assert p.returncode == 0 and p.stdout.split() == ["bing", "ddg"]
    assert "unconfigured: tavily, searxng" in p.stderr
    j = json.loads(_run("backends", "--json").stdout)
    assert j["backends"] == ["bing", "ddg"] and j["unconfigured"] == ["tavily", "searxng"]


def test_cli_search_uses_the_configured_backend():
    with start_stub() as base:
        p = _run("search", "clutch websearch", "--json", CLUTCH_SEARXNG_URL=base)
        assert p.returncode == 0, p.stderr
        out = json.loads(p.stdout)
        assert out["backend"] == "searxng"
        assert out["results"][0]["url"] == "https://example.com/first"
        p = _run("search", "clutch websearch", CLUTCH_SEARXNG_URL=base)
        assert p.stdout.startswith("2 results for 'clutch websearch' (via searxng):")


def test_cli_search_reports_a_pinned_unavailable_backend():
    p = _run("search", "q", "--backend", "tavily")
    assert p.returncode == 1
    assert "not available" in p.stdout and "available: bing, ddg" in p.stdout


def test_cli_fetch_keeps_links_and_needs_the_private_optin():
    with start_stub() as base:
        refused = _run("fetch", f"{base}/page.html")
        assert refused.returncode == 1 and "non-public host refused" in refused.stdout

        p = _run("fetch", f"{base}/page.html", "--allow-private-hosts", "--json")
        assert p.returncode == 0, p.stderr
        out = json.loads(p.stdout)
        assert out["title"] == "SRU project"
        # the P0 fix, end to end: the button's href survives as a real URL
        assert f"[GitHub]({base}/orgs/leggedrobotics/repos)" in out["text"]
        assert "home / code / about" not in out["text"]


def test_cli_usage_error_exits_two():
    p = _run("search")
    assert p.returncode == 2
