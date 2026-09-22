#!/usr/bin/env python3
"""clutch-websearch: web search + page fetch as a standalone CLI.

Two commands, stdlib only, no host code imported — the module is one process
that takes argv, talks HTTP, prints text (or JSON) and exits:

    python3 websearch.py search "query" [--max-results N] [--backend NAME] [--json]
    python3 websearch.py fetch URL [--max-chars N] [--start N] [--json]
    python3 websearch.py backends [--json]

Backends, tried in order, first success wins:

    tavily   LLM-first search API, best quality   (CLUTCH_TAVILY_API_KEY)
    searxng  self-hosted metasearch, JSON API     (CLUTCH_SEARXNG_URL)
    bing     the undocumented RSS endpoint of www.bing.com — keyless
    ddg      the duckduckgo html endpoint — keyless

Environment (all optional; see load_settings):
    CLUTCH_TAVILY_API_KEY / TAVILY_API_KEY      -> enables tavily
    CLUTCH_SEARXNG_URL / SEARXNG_URL            -> enables searxng
    CLUTCH_WEBSEARCH_TIMEOUT   (15.0 s)
    CLUTCH_WEBSEARCH_MAX_RESULTS (8)
    CLUTCH_WEBSEARCH_MAX_CHARS (20000)
    CLUTCH_WEBSEARCH_MAX_BYTES (2000000)
    CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS (unset) -> fetch may touch loopback/LAN

Poka-yoke — make it hard for the caller to misuse (all four are contract):
- timeout: every request is bounded; a heavy page is retried ONCE (GET only)
- size cap: responses larger than max_bytes are rejected, not swallowed
- private-network guard: fetch refuses loopback/LAN hosts, and redirects are
  re-checked against the same rule (search endpoints are operator-configured —
  see `allow_private` in _http_get — so a self-hosted searxng on the LAN works)
- error-as-data: backend failures list each reason; a truncating fetch says how
  to fetch the next slice, mirroring read_file's offset hints

Fixes carried over from WEBSEARCH_POSTMORTEM.md (the SRU 404 event):
- P0  link-preserving extraction: `_TextExtractor` renders anchors as
      `[text](url)`, so the caller never has to invent a URL from a button
      label. Losing hrefs is what made a model guess an owner and report four
      honest 404s as "never published".
- P0  the backend chain announces its own degradation: `backends` prints the
      usable list and names the unconfigured ones on stderr.
- P1  relevance guard: a scraped backend whose results share no term with the
      query is an ERROR that falls through, not a silent success (bing used to
      answer English niche queries with unrelated Chinese pages).
- P1  bing market/language follows the query's script instead of a hardcoded
      zh-CN preference (`ensearch`/`mkt`/`setlang` + Accept-Language).
- P2  one timeout retry; the docstring names the endpoint that is really used
      (www.bing.com, not cn.bing.com).
"""

from __future__ import annotations

import argparse
import dataclasses
import gzip
import ipaddress
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any, Callable

# browser-shaped but honest about the product; several CDNs 403 blank UAs
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 ClutchAgent/0.1"
)
# English-first: a localized default silently steered every keyless lookup into
# a regional market (postmortem root cause C). Per-request overrides win.
DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9,*;q=0.5"

# exit codes (clutch-memory convention: 0 ok, 1 result-level failure, 2 usage)
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


class WebError(Exception):
    """A request-level failure (DNS, timeout, size cap, private host)."""


class BackendError(Exception):
    """A backend responded but yielded nothing usable (blocked, layout changed)."""


@dataclass
class HttpResp:
    url: str  # final URL after redirects
    content_type: str
    body: bytes


# ---- settings ---------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    """Everything the module reads from the environment, in one place."""

    timeout: float = 15.0
    max_results: int = 8
    max_chars: int = 20000
    max_bytes: int = 2_000_000
    tavily_api_key: str = ""
    searxng_url: str = ""
    allow_private_hosts: bool = False


def _env(name: str, *fallbacks: str) -> str:
    for key in (name, *fallbacks):
        value = os.environ.get(key)
        if value:
            return value.strip()
    return ""


def load_settings() -> Settings:
    """Environment -> Settings (a fresh read per call: one process, one read)."""
    return Settings(
        timeout=float(_env("CLUTCH_WEBSEARCH_TIMEOUT") or 15.0),
        max_results=int(_env("CLUTCH_WEBSEARCH_MAX_RESULTS") or 8),
        max_chars=int(_env("CLUTCH_WEBSEARCH_MAX_CHARS") or 20000),
        max_bytes=int(_env("CLUTCH_WEBSEARCH_MAX_BYTES") or 2_000_000),
        tavily_api_key=_env("CLUTCH_TAVILY_API_KEY", "TAVILY_API_KEY"),
        searxng_url=_env("CLUTCH_SEARXNG_URL", "SEARXNG_URL").rstrip("/"),
        allow_private_hosts=_env("CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS").lower() in ("1", "true", "yes", "on"),
    )


# ---- HTTP core --------------------------------------------------------------


def _assert_public_host(url: str) -> None:
    """Refuse non-public destinations: loopback, LAN, link-local, reserved.

    Guards a model-supplied URL from being pointed at the agent's own HTTP API
    or the surrounding network. Resolve-then-connect leaves a (narrow)
    DNS-rebinding race; this is a guard against honest mistakes, not a sandbox.
    """
    host = urllib.parse.urlsplit(url).hostname
    if not host:
        raise WebError(f"URL has no host: {url!r}")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise WebError(f"non-public host refused: {host}")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        # Judge a literal address locally: asking the resolver about 127.0.0.1
        # would hand the verdict to DNS. With no working resolver the request
        # then hangs on connect, and a lying resolver lets it through.
        if not literal.is_global:
            raise WebError(f"non-public host refused: {host} ({literal})")
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as e:
        raise WebError(f"cannot resolve host {host!r}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise WebError(f"non-public host refused: {host} ({ip})")


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    """Redirects pass through the same public-host check as the first hop."""

    def __init__(self, allow_private: bool = False) -> None:
        super().__init__()
        self._allow_private = allow_private

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not self._allow_private:
            _assert_public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(request: urllib.request.Request, *, timeout: float, allow_private: bool):
    """One opener (private hosts only when the operator allowed them)."""
    return urllib.request.build_opener(_SafeRedirects(allow_private)).open(request, timeout=timeout)


def _drain(resp: Any, max_bytes: int) -> bytes:
    """Read the body in chunks, refusing anything larger than max_bytes."""
    chunks: list[bytes] = []
    total = 0
    while True:
        block = resp.read(65_536)
        if not block:
            break
        total += len(block)
        if total > max_bytes:
            raise WebError(f"response exceeds {max_bytes} bytes")
        chunks.append(block)
    return b"".join(chunks)


def _http_once(
    url: str,
    *,
    timeout: float,
    method: str,
    body: bytes | None,
    headers: dict[str, str] | None,
    max_bytes: int,
    allow_private: bool,
) -> HttpResp:
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise WebError(f"unsupported URL scheme {scheme!r} (http/https only)")
    if not allow_private:
        _assert_public_host(url)
    req_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
        "Accept-Encoding": "gzip",
    }
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        resp = _open(request, timeout=timeout, allow_private=allow_private)
    except WebError:
        raise
    except urllib.error.HTTPError as e:
        raise WebError(f"HTTP {e.code} from {url}") from e
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            raise WebError(f"timed out after {timeout:.0f}s") from e
        raise WebError(str(reason) or "request failed") from e
    except (ValueError, OSError) as e:
        raise WebError(f"request failed: {e}") from e
    with resp:
        raw = _drain(resp, max_bytes)
    encoding = resp.headers.get("Content-Encoding", "").lower()
    if encoding == "gzip":
        try:
            raw = gzip.decompress(raw)
        except OSError as e:
            raise WebError(f"malformed gzip body from {url}") from e
    elif encoding == "deflate":
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)  # raw-deflate variant
    return HttpResp(url=resp.geturl(), content_type=resp.headers.get("Content-Type", ""), body=raw)


def _http_get(
    url: str,
    *,
    timeout: float = 15.0,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    max_bytes: int = 2_000_000,
    allow_private: bool = False,
    retries: int = 1,
) -> HttpResp:
    """One bounded HTTP request, with a single retry on timeout (GET only).

    A heavy page (github.com in the postmortem) times out sporadically; a POST
    is not replayed, and neither is a failure that a retry cannot help (size cap,
    private host, HTTP status, DNS). Every caller turns WebError into data.
    """
    attempts = 1 + (retries if method == "GET" else 0)
    for attempt in range(attempts):
        try:
            return _http_once(
                url,
                timeout=timeout,
                method=method,
                body=body,
                headers=headers,
                max_bytes=max_bytes,
                allow_private=allow_private,
            )
        except WebError as e:
            if attempt + 1 >= attempts or "timed out" not in str(e):
                raise
    raise WebError("unreachable")  # pragma: no cover -- the loop always returns or raises


_CHARSET_RE = re.compile(r"charset=[\"']?([\w\-:+.]+)", re.I)
_META_CHARSET_RE = re.compile(r"<meta[^>]+charset=[\"']?([\w\-:+.]+)", re.I)


def _decode_body(raw: bytes, content_type: str) -> str:
    """Bytes -> text: header charset, then a meta sniff, then utf-8, then
    latin-1 (which never fails, so decoding cannot raise)."""
    m = _CHARSET_RE.search(content_type or "")
    charset = m.group(1) if m else None
    if not charset:
        m = _META_CHARSET_RE.search(raw[:4096].decode("ascii", errors="ignore"))
        charset = m.group(1) if m else None
    if charset:
        try:
            return raw.decode(charset, errors="replace")
        except (LookupError, ValueError):
            pass  # unknown charset name: fall through to BOM/utf-8
    for bom, enc in ((b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be")):
        if raw.startswith(bom):
            return raw.decode(enc, errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="replace")


# ---- HTML -> readable text --------------------------------------------------

_SNIPPET_TAG_RE = re.compile(r"<[^>]+>")


def _clean_snippet(text: str) -> str:
    """Feed/blurb HTML to one line of plain text."""
    text = _SNIPPET_TAG_RE.sub(" ", text)
    text = unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()[:300]


# href prefixes that are never a page address: dropping them beats printing
# "javascript:void(0)" into the text the caller reads
_DEAD_SCHEMES = ("javascript:", "mailto:", "tel:", "data:", "about:", "blob:")


class _TextExtractor(HTMLParser):
    """Page HTML to title + readable text.

    script/style/nav chrome is dropped, block boundaries become newlines, runs
    of blank lines collapse — and every anchor survives as `[text](url)` with
    its href resolved against the page URL. That last part is the P0 fix: the
    caller must never have to guess a link from a button label.
    """

    _SKIP = frozenset(
        {"script", "style", "noscript", "template", "svg", "iframe", "object",
         "embed", "canvas", "nav", "aside", "footer", "form", "button",
         "select", "option", "input", "label", "head"}
    )
    _BLOCK = frozenset(
        {"p", "div", "li", "tr", "table", "ul", "ol", "dl", "dt", "dd", "pre",
         "blockquote", "section", "article", "main", "figure", "figcaption",
         "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr"}
    )

    def __init__(self, base_url: str = "") -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._chunks: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self._base = base_url
        self._link: dict[str, list[str]] | None = None  # open <a>: {"href": [..], "text": [..]}

    # -- tag stream
    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "title":
            self._in_title = True
            return
        if tag in self._SKIP:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "a":
            self._close_link()  # malformed nested anchor: flush the outer one
            self._link = {"href": [(attr.get("href") or "").strip()], "text": []}
            return
        if tag == "img" and self._link is not None:
            alt = (attr.get("alt") or "").strip()  # image buttons carry their label here
            if alt:
                self._link["text"].append(f" {alt} ")
            return
        self._boundary("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
            return
        if tag in self._SKIP:
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "a":
            self._close_link()
            return
        self._boundary("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data.strip()
        elif self._skip_depth:
            return
        elif self._link is not None:
            self._link["text"].append(data)
        else:
            self._chunks.append(data)

    # -- helpers
    def _boundary(self, sep: str) -> None:
        """A block edge: a newline in the flow, a space inside a link label."""
        if self._link is not None:
            self._link["text"].append(" ")
        elif sep == "\n":
            self._chunks.append("\n")

    def _close_link(self) -> None:
        link, self._link = self._link, None
        if link is None:
            return
        label = re.sub(r"\s+", " ", "".join(link["text"])).strip()
        url = self._resolve(link["href"][0])
        if url is None:
            if label:  # nothing linkable: keep the words, drop the markup
                self._chunks.append(f" {label} ")
        elif not label or label == url:
            self._chunks.append(f" {url} ")
        else:
            self._chunks.append(f" [{label}]({url}) ")

    def _resolve(self, href: str) -> str | None:
        if not href or href.startswith("#") or href.lower().startswith(_DEAD_SCHEMES):
            return None
        url = urllib.parse.urljoin(self._base, href) if self._base else href
        return url if urllib.parse.urlsplit(url).scheme.lower() in ("http", "https") else None

    # -- result
    def text(self) -> str:
        raw = "".join(self._chunks).replace("\xa0", " ")
        lines = (re.sub(r"[ \t\r\f]+", " ", ln).strip() for ln in raw.split("\n"))
        return "\n".join(ln for ln in lines if ln)


def html_to_text(html: str, base_url: str = "") -> tuple[str, str]:
    """HTML -> (title, readable text with links kept)."""
    extractor = _TextExtractor(base_url)
    extractor.feed(html)
    extractor.close()
    return extractor.title, extractor.text()


def _window(text: str, start: int, limit: int) -> tuple[str, int | None]:
    """One character slice plus the next offset (None when nothing remains)."""
    start = max(0, start)
    chunk = text[start : start + limit]
    rest = len(text) - (start + len(chunk))
    return chunk, (start + len(chunk) if rest > 0 else None)


# ---- result parsers ----------------------------------------------------------


class _DdgParser(HTMLParser):
    """The duckduckgo html endpoint: <a class="result__a">title</a> whose href
    is a /l/?uddg=<encoded> redirect, then <a class="result__snippet">blurb</a>."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._pending: dict[str, str] | None = None
        self._mode = ""  # "" | "title" | "snippet"
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        cls = dict(attrs).get("class", "")
        if "result__a" in cls:
            self._flush()
            href = dict(attrs).get("href", "")
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query).get("uddg")
            self._pending = {"url": urllib.parse.unquote(qs[0]) if qs else href, "title": "", "snippet": ""}
            self._mode, self._buf = "title", []
        elif "result__snippet" in cls and self._pending is not None:
            self._mode, self._buf = "snippet", []

    def handle_data(self, data):
        if self._mode:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag != "a" or not self._pending:
            return
        if self._mode == "title":
            self._pending["title"] = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            self._mode = ""
        elif self._mode == "snippet":
            self._pending["snippet"] = _clean_snippet("".join(self._buf))
            self.results.append(self._pending)
            self._pending, self._mode = None, ""

    def _flush(self):
        """A result__a without a trailing snippet still counts."""
        if self._pending and self._pending["title"]:
            self.results.append(self._pending)
        self._pending, self._mode = None, ""


# ---- relevance guard (P1) ---------------------------------------------------

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")
_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_+.\-]*")
_STOPWORDS = frozenset(
    """a an and are as at be by do does for from has have how in into is it its of on or that the this
    to was were what when where which who why with site""".split()
)


def _query_terms(query: str) -> tuple[set[str], set[str]]:
    """(ASCII tokens, CJK bigrams) — what a relevant result should echo back."""
    low = query.lower()
    words = {w for w in _WORD_RE.findall(low) if len(w) >= 2 and w not in _STOPWORDS}
    grams: set[str] = set()
    for run in _CJK_RE.findall(low):
        grams.update({run} if len(run) == 1 else {run[i : i + 2] for i in range(len(run) - 1)})
    return words, grams


def looks_relevant(query: str, results: list[dict[str, str]], *, top: int = 5) -> bool:
    """True when at least one of the top results shares a term with the query.

    The bar is deliberately low (any shared token, not a score): it exists to
    turn "the engine answered in the wrong market / the layout drifted" from a
    silent success into an error the chain can fall through. A query whose only
    terms are stopwords is never judged.
    """
    words, grams = _query_terms(query)
    if not words and not grams:
        return True
    for r in results[:top]:
        hay = f"{r.get('title', '')} {r.get('url', '')} {r.get('snippet', '')}".lower()
        if words & set(_WORD_RE.findall(hay)) or any(g in hay for g in grams):
            return True
    return False


# ---- backends: (query, limit, settings, get) -> list[{title,url,snippet}] ----


def _tavily(query: str, limit: int, settings: Settings, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    payload = json.dumps({"query": query, "max_results": limit}).encode("utf-8")
    resp = get(
        "https://api.tavily.com/search",
        method="POST",
        body=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.tavily_api_key}",
            "Accept": "application/json",
        },
    )
    try:
        data = json.loads(resp.body)
        raw = data.get("results") or []
    except ValueError as e:
        raise BackendError(f"tavily returned non-JSON body: {e}") from e
    out = [
        {
            "title": str(r.get("title") or "").strip(),
            "url": str(r.get("url") or "").strip(),
            "snippet": _clean_snippet(str(r.get("content") or "")),
        }
        for r in raw
        if isinstance(r, dict) and r.get("url")
    ]
    if not out:
        raise BackendError("response had no usable results")
    return out[:limit]


def _searxng(query: str, limit: int, settings: Settings, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    url = f"{settings.searxng_url}/search?{urllib.parse.urlencode({'q': query, 'format': 'json'})}"
    resp = get(url, headers={"Accept": "application/json"})
    try:
        data = json.loads(resp.body)
        raw = data.get("results") or []
    except ValueError as e:
        raise BackendError(f"searxng returned non-JSON body (format=json enabled?): {e}") from e
    out = [
        {
            "title": str(r.get("title") or "").strip(),
            "url": str(r.get("url") or "").strip(),
            "snippet": _clean_snippet(str(r.get("content") or "")),
        }
        for r in raw
        if isinstance(r, dict) and r.get("url")
    ]
    if not out:
        raise BackendError("response had no usable results")
    return out[:limit]


def _bing_market(query: str) -> dict[str, str]:
    """Market/language params following the query's script (P1).

    The endpoint used to hardcode a zh-CN preference, which made bing answer
    English niche queries with unrelated Chinese pages. Now an ASCII query asks
    for the English market (ensearch=1) and a CJK one for the Chinese market.
    """
    if _CJK_RE.search(query):
        return {"mkt": "zh-CN", "setlang": "zh-hans", "accept_language": "zh-CN,zh;q=0.9,en;q=0.8"}
    return {"mkt": "en-US", "setlang": "en", "ensearch": "1", "accept_language": "en-US,en;q=0.9"}


def _bing(query: str, limit: int, settings: Settings, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    market = _bing_market(query)
    params = {"q": query, "format": "rss", "count": str(min(limit, 30))}
    params.update({k: v for k, v in market.items() if k != "accept_language"})
    url = "https://www.bing.com/search?" + urllib.parse.urlencode(params)
    resp = get(
        url,
        headers={
            "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
            "Accept-Language": market["accept_language"],
        },
    )
    try:
        root = ET.fromstring(resp.body)
    except ET.ParseError as e:
        raise BackendError(f"bing RSS is not parseable XML: {e}") from e
    out = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not (title and link):
            continue
        out.append(
            {"title": _clean_snippet(title), "url": link, "snippet": _clean_snippet(item.findtext("description") or "")}
        )
        if len(out) >= limit:
            break
    if not out:
        raise BackendError("no items in the RSS (blocked, or genuinely no results)")
    return out


def _ddg(query: str, limit: int, settings: Settings, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    resp = get(url)
    parser = _DdgParser()
    parser.feed(_decode_body(resp.body, resp.content_type))
    parser.close()
    out = [r for r in parser.results if r["url"]][:limit]
    if not out:
        raise BackendError("no results parsed (bot-checked, blocked, or layout changed)")
    return out


@dataclass(frozen=True)
class Backend:
    """One source: how to search it, whether it exists here, and whether its
    results must pass the relevance guard (scraped endpoints yes — they can
    answer from the wrong market without failing; ranked APIs no)."""

    name: str
    search: Callable[[str, int, Settings, Callable[..., HttpResp]], list[dict[str, str]]]
    available: Callable[[Settings], bool] = lambda settings: True
    relevance_guard: bool = False


_BACKENDS: dict[str, Backend] = {
    "tavily": Backend("tavily", _tavily, lambda s: bool(s.tavily_api_key)),
    "searxng": Backend("searxng", _searxng, lambda s: bool(s.searxng_url)),
    "bing": Backend("bing", _bing, relevance_guard=True),
    "ddg": Backend("ddg", _ddg, relevance_guard=True),
}

# Named so `backends` can say what is merely unconfigured, not installed.
_UNCONFIGURED = ("tavily", "searxng")


def all_backends() -> dict[str, Backend]:
    """Every registered backend, in chain order."""
    return dict(_BACKENDS)


def available_backends(settings: Settings | None = None) -> tuple[str, ...]:
    """The usable subset of the chain: registered AND configured on this machine."""
    s = settings or load_settings()
    return tuple(name for name, backend in _BACKENDS.items() if backend.available(s))


def missing_backends(settings: Settings | None = None) -> tuple[str, ...]:
    """Keyless backends are always there; a missing name is an unset env var.

    Kept out of every model-facing text (an unconfigured service does not exist
    here), and printed by `backends` on stderr for the operator.
    """
    s = settings or load_settings()
    return tuple(name for name in _UNCONFIGURED if name in _BACKENDS and not _BACKENDS[name].available(s))


def _short(reason: object) -> str:
    return re.sub(r"\s+", " ", str(reason)).strip()[:160]


# ---- search ------------------------------------------------------------------


def _dedupe(results: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for r in results:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        out.append(r)
    return out


def search(
    query: str,
    *,
    max_results: int | None = None,
    backend: str = "",
    settings: Settings | None = None,
    get: Callable[..., HttpResp] | None = None,
) -> dict[str, Any]:
    """Search the web; backends fall through in order until one yields.

    Returns {"query", "backend", "results"} or {"error", "failures"} — never
    raises for a source-level problem (error-as-data).
    """
    s = settings or load_settings()
    q = (query or "").strip()
    if not q:
        return {"error": "query is required"}
    limit = max(1, min(int(max_results or s.max_results), 20))
    backends = all_backends()
    available = available_backends(s)
    if backend:
        # one factual gate for every source: not on the available list -> not
        # named in the error either. No install/setup advice, ever.
        if backend not in available:
            return {"error": f"backend {backend!r} is not available; available: " + (", ".join(available) or "none")}
        chain: tuple[str, ...] = (backend,)
    else:
        chain = available
    if get is None:
        # default transport: the endpoints are operator-configured, so a
        # self-hosted searxng on the LAN is a legitimate destination
        get = lambda url, **kw: _http_get(  # noqa: E731
            url, timeout=s.timeout, max_bytes=s.max_bytes, allow_private=True, **kw
        )

    failures: list[dict[str, str]] = []
    for name in chain:
        try:
            results = backends[name].search(q, limit, s, get)
        except (BackendError, WebError) as e:
            failures.append({"backend": name, "reason": _short(e)})
            continue
        if backends[name].relevance_guard and not looks_relevant(q, results):
            failures.append({"backend": name, "reason": "results share no term with the query (wrong market, or layout drift)"})
            continue
        return {"query": q, "backend": name, "results": _dedupe(results)}
    return {"error": "all search backends failed", "failures": failures, "query": q}


def search_text(query: str, **kwargs: Any) -> dict[str, Any]:
    """search() rendered as the model-facing shape: {content, error?}."""
    r = search(query, **kwargs)
    if "error" in r:
        body = r["error"]
        if r.get("failures"):
            body += "\n" + "\n".join(f"- {f['backend']}: {f['reason']}" for f in r["failures"])
        return {"content": f"ERROR: {body}", "error": True}
    q, name, results = r["query"], r["backend"], r["results"]
    body = "\n".join(f"{i}. {x['title']}\n   {x['url']}\n   {x['snippet']}" for i, x in enumerate(results, 1))
    return {"content": f"{len(results)} results for {q!r} (via {name}):\n\n{body}"}


# ---- fetch -------------------------------------------------------------------

_BINARY_TYPES = ("image/", "video/", "audio/")
_BINARY_EXACT = {"application/pdf", "application/zip", "application/gzip", "application/x-tar", "application/octet-stream"}


def fetch(
    url: str,
    *,
    max_chars: int | None = None,
    start: int = 0,
    settings: Settings | None = None,
    get: Callable[..., HttpResp] | None = None,
) -> dict[str, Any]:
    """One page -> readable text; oversized pages continue at `start`."""
    s = settings or load_settings()
    u = (url or "").strip()
    if not u:
        return {"error": "url is required"}
    if get is None:
        # default transport: the URL comes from the model, so loopback/LAN stays
        # refused unless the operator opened the escape hatch
        get = lambda url, **kw: _http_get(  # noqa: E731
            url, timeout=s.timeout, max_bytes=s.max_bytes, allow_private=s.allow_private_hosts, **kw
        )

    try:
        resp = get(u)
    except WebError as e:
        return {"error": _short(e)}
    ctype = resp.content_type.split(";")[0].strip().lower()
    if ctype.startswith(_BINARY_TYPES) or ctype in _BINARY_EXACT:
        return {"error": f"unsupported content-type {ctype!r} (text pages only)"}
    text = _decode_body(resp.body, resp.content_type)
    title = ""
    if "html" in ctype or (not ctype and text.lstrip()[:1] == "<"):
        title, page = html_to_text(text, resp.url)
        page = page or "(no extractable text; the page is probably JS-rendered)"
    else:
        page = text
    limit = max(200, int(max_chars or s.max_chars))
    chunk, next_start = _window(page, int(start or 0), limit)
    return {
        "url": resp.url,
        "requested_url": u,
        "title": title,
        "text": chunk,
        "next_start": next_start,
        "remaining": len(page) - next_start if next_start is not None else 0,
    }


def fetch_text(url: str, **kwargs: Any) -> dict[str, Any]:
    """fetch() rendered as the model-facing shape: {content, error?}."""
    r = fetch(url, **kwargs)
    if "error" in r:
        return {"content": f"ERROR: {r['error']}", "error": True}
    chunk = r["text"]
    if r["next_start"] is not None:
        chunk += f"\n... [{r['remaining']} chars truncated; fetch again with start={r['next_start']} to continue]"
    if r["url"] != r["requested_url"]:
        chunk = f"(redirected to {r['url']})\n\n{chunk}"
    if r["title"]:
        chunk = f"# {r['title']}\n\n{chunk}"
    return {"content": chunk}


# ---- CLI ---------------------------------------------------------------------


def _emit(obj: Any, as_json: bool, text: str) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2) if as_json else text)


def _cmd_search(args: argparse.Namespace) -> int:
    r = search(args.query, max_results=args.max_results, backend=args.backend or "", settings=args.settings)
    if "error" in r:
        text = f"ERROR: {r['error']}"
        if r.get("failures"):
            text += "\n" + "\n".join(f"- {f['backend']}: {f['reason']}" for f in r["failures"])
        _emit(r, args.json, text)
        return EXIT_FAILED
    body = "\n".join(f"{i}. {x['title']}\n   {x['url']}\n   {x['snippet']}" for i, x in enumerate(r["results"], 1))
    text = f"{len(r['results'])} results for {r['query']!r} (via {r['backend']}):\n\n{body}"
    _emit(r, args.json, text)
    return EXIT_OK


def _cmd_fetch(args: argparse.Namespace) -> int:
    r = fetch(args.url, max_chars=args.max_chars, start=args.start, settings=args.settings)
    if "error" in r:
        _emit(r, args.json, f"ERROR: {r['error']}")
        return EXIT_FAILED
    chunk = r["text"]
    if r["next_start"] is not None:
        chunk += f"\n... [{r['remaining']} chars truncated; fetch again with start={r['next_start']} to continue]"
    if r["url"] != r["requested_url"]:
        chunk = f"(redirected to {r['url']})\n\n{chunk}"
    if r["title"]:
        chunk = f"# {r['title']}\n\n{chunk}"
    _emit(r, args.json, chunk)
    return EXIT_OK


def _cmd_backends(args: argparse.Namespace) -> int:
    names = available_backends(args.settings)
    missing = missing_backends(args.settings)
    _emit({"backends": list(names), "unconfigured": list(missing)}, args.json, "\n".join(names) if names else "(none)")
    if missing:
        # stderr, so a caller that reads stdout for the list is unaffected
        hint = "CLUTCH_TAVILY_API_KEY" if "tavily" in missing else "CLUTCH_SEARXNG_URL"
        print(f"# unconfigured: {', '.join(missing)} (set {hint} to add them)", file=sys.stderr)
    return EXIT_OK


def _build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="emit one JSON object instead of text")
    common.add_argument("--timeout", type=float, default=None, help="per-request timeout in seconds")
    common.add_argument("--allow-private-hosts", action="store_true", help="fetch: permit loopback/LAN URLs")
    common.add_argument("--tavily-key", default="", help="override CLUTCH_TAVILY_API_KEY")
    common.add_argument("--searxng-url", default="", help="override CLUTCH_SEARXNG_URL")

    p = argparse.ArgumentParser(
        prog="clutch-websearch",
        description="Search the web and fetch pages as readable text (standalone, stdlib only).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("search", parents=[common], help="search the web through the backend chain")
    sp.add_argument("query", help="search string (engine syntax like site: and quoted phrases works)")
    sp.add_argument("--max-results", type=int, default=None, help="cap on returned entries")
    sp.add_argument("--backend", default="", help="pin one backend instead of falling through the chain")
    sp.set_defaults(run=_cmd_search)

    fp = sub.add_parser("fetch", parents=[common], help="fetch one URL as title + readable text")
    fp.add_argument("url", help="http(s) URL to fetch")
    fp.add_argument("--max-chars", type=int, default=None, help="cap on returned characters")
    fp.add_argument("--start", type=int, default=0, help="0-based character offset to continue a truncated fetch")
    fp.set_defaults(run=_cmd_fetch)

    bp = sub.add_parser("backends", parents=[common], help="list the usable backends (one per line)")
    bp.set_defaults(run=_cmd_backends)
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    overrides: dict[str, Any] = {
        "timeout": args.timeout,
        "tavily_api_key": args.tavily_key or None,
        "searxng_url": args.searxng_url.rstrip("/") or None,
        "allow_private_hosts": True if args.allow_private_hosts else None,
        "max_results": getattr(args, "max_results", None),
        "max_chars": getattr(args, "max_chars", None),
    }
    args.settings = dataclasses.replace(load_settings(), **{k: v for k, v in overrides.items() if v is not None})
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
