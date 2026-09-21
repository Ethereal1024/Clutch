"""Web access tools: web_search (multi-backend search) + web_fetch (page -> text).

Built on the stdlib only (urllib + html.parser + ElementTree) — the LLM loop is
hand-rolled here, and so is web access: no scraping SDK that rots when an
engine tweaks its markup. Backends, tried in order, first success wins:

  tavily   LLM-first search API, best quality   (CLUTCH_TAVILY_API_KEY)
  searxng  self-hosted metasearch, JSON API     (CLUTCH_SEARXNG_URL)
  bing     the undocumented RSS endpoint of cn.bing.com — keyless, CN-friendly
  ddg      duckduckgo html endpoint — keyless

Poka-yoke (make it hard for the model to misuse):
- timeout: every request is bounded (Config.web_search_timeout); Stop is
  honored between chunks so a hung fetch never outlives the user's patience
- size cap: responses larger than max_bytes are rejected, not swallowed
- private-network guard: web_fetch refuses loopback/LAN hosts (and follows
  redirects only to public hosts) — a GET into the agent's own API or the
  LAN stays impossible even when the model is talked into trying
- error-as-data: backend failures list each reason; a truncating fetch says
  how to fetch the next slice, mirroring read_file's offset hints
"""

from __future__ import annotations

import functools
import gzip
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any, Callable

from ..config import Config
from .workspace import Workspace

# browser-shaped but honest about the product; several CDNs 403 blank UAs
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 ClutchAgent/0.1"
)

_MAX_BYTES = 2_000_000  # hard cap per response: pages are for reading, not hoarding


class WebError(Exception):
    """A request-level failure (DNS, timeout, size cap, private host)."""


class BackendError(Exception):
    """A backend responded but yielded nothing usable (blocked, layout changed)."""


@dataclass
class HttpResp:
    url: str  # final URL after redirects
    content_type: str
    body: bytes


# ---- HTTP core -------------------------------------------------------------


def _assert_public_host(url: str) -> None:
    """Refuse non-public destinations: loopback, LAN, link-local, reserved.

    Guards web_fetch against being pointed at the agent's own HTTP API or the
    surrounding network. Resolve-then-connect leaves a (narrow) DNS-rebinding
    race; this is a guard against honest mistakes, not a sandbox — work mode
    already has full shell access.
    """
    host = urllib.parse.urlsplit(url).hostname
    if not host:
        raise WebError(f"URL has no host: {url!r}")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise WebError(f"non-public host refused: {host}")
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

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _assert_public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _drain(resp: Any, cancel: Any, max_bytes: int) -> bytes:
    """Read the body in chunks, honoring Stop between chunks."""
    chunks: list[bytes] = []
    total = 0
    while True:
        if cancel is not None and cancel.is_set():
            raise WebError("aborted by user")
        block = resp.read(65_536)
        if not block:
            break
        total += len(block)
        if total > max_bytes:
            raise WebError(f"response exceeds {max_bytes} bytes")
        chunks.append(block)
    return b"".join(chunks)


def _http_get(
    url: str,
    timeout: float = 15.0,
    cancel: Any = None,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    max_bytes: int = _MAX_BYTES,
) -> HttpResp:
    """One bounded HTTP request. Raises WebError with a short, model-readable
    reason; every caller turns that into error-as-data."""
    if cancel is not None and cancel.is_set():
        raise WebError("aborted by user")
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise WebError(f"unsupported URL scheme {scheme!r} (http/https only)")
    _assert_public_host(url)
    req_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip",
    }
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        resp = urllib.request.build_opener(_SafeRedirects()).open(request, timeout=timeout)
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
        raw = _drain(resp, cancel, max_bytes)
    if resp.headers.get("Content-Encoding", "").lower() == "gzip":
        try:
            raw = gzip.decompress(raw)
        except OSError as e:
            raise WebError(f"malformed gzip body from {url}") from e
    elif resp.headers.get("Content-Encoding", "").lower() == "deflate":
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)  # raw-deflate variant
    return HttpResp(url=resp.geturl(), content_type=resp.headers.get("Content-Type", ""), body=raw)


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


class _TextExtractor(HTMLParser):
    """Page HTML to title + readable text: script/style/nav chrome dropped,
    block boundaries become newlines, runs of blank lines collapse."""

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

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._chunks: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
            return
        if tag in self._SKIP:
            self._skip_depth += 1
        elif not self._skip_depth and tag in self._BLOCK:
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif not self._skip_depth and tag in self._BLOCK:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data.strip()
        elif not self._skip_depth:
            self._chunks.append(data)

    def text(self) -> str:
        raw = "".join(self._chunks).replace("\xa0", " ")
        lines = (re.sub(r"[ \t\r\f]+", " ", ln).strip() for ln in raw.split("\n"))
        return "\n".join(ln for ln in lines if ln)


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


# ---- backends: (query, limit, config, get) -> list[{title,url,snippet}] ------


def _tavily(query: str, limit: int, config: Config, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    payload = json.dumps({"query": query, "max_results": limit}).encode("utf-8")
    resp = get(
        "https://api.tavily.com/search",
        method="POST",
        body=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.tavily_api_key}",
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


def _searxng(query: str, limit: int, config: Config, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    url = f"{config.searxng_url}/search?{urllib.parse.urlencode({'q': query, 'format': 'json'})}"
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


def _bing(query: str, limit: int, config: Config, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    url = "https://www.bing.com/search?" + urllib.parse.urlencode(
        {"q": query, "format": "rss", "count": str(min(limit, 30))}
    )
    resp = get(url, headers={"Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"})
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
        out.append({"title": _clean_snippet(title), "url": link, "snippet": _clean_snippet(item.findtext("description") or "")})
        if len(out) >= limit:
            break
    if not out:
        raise BackendError("no items in the RSS (blocked, or genuinely no results)")
    return out


def _ddg(query: str, limit: int, config: Config, get: Callable[..., HttpResp]) -> list[dict[str, str]]:
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    resp = get(url)
    parser = _DdgParser()
    parser.feed(_decode_body(resp.body, resp.content_type))
    parser.close()
    out = [r for r in parser.results if r["url"]][:limit]
    if not out:
        raise BackendError("no results parsed (bot-checked, blocked, or layout changed)")
    return out


# ---- registry ---------------------------------------------------------------
# One protocol for every source: a Backend knows how to search and whether it
# exists on this machine. web_search only ever sees this shape.


@dataclass(frozen=True)
class Backend:
    name: str
    search: Callable[[str, int, Config, Callable[..., HttpResp]], list[dict[str, str]]]
    available: Callable[[Config], bool] = lambda config: True


_BACKENDS: dict[str, Backend] = {
    "tavily": Backend("tavily", _tavily, lambda c: bool(c.tavily_api_key)),
    "searxng": Backend("searxng", _searxng, lambda c: bool(c.searxng_url)),
    "bing": Backend("bing", _bing),
    "ddg": Backend("ddg", _ddg),
}
# Base try order; the live chain is this filtered through Backend.available.
_DEFAULT_CHAIN = tuple(_BACKENDS)


def _all_backends(config: Config) -> dict[str, Backend]:
    """Every registered backend, in chain order."""
    return dict(_BACKENDS)


def _available_backends(config: Config) -> tuple[str, ...]:
    """The usable subset of the chain: registered AND configured on this machine.

    Rendered into prompts and error texts, so an unconfigured service simply
    does not exist here — no name, no install advice.
    """
    return tuple(name for name, backend in _all_backends(config).items() if backend.available(config))


# Public alias: server and registry render UI/prompt text from this too.
available_backends = _available_backends


def _short(reason: object) -> str:
    return re.sub(r"\s+", " ", str(reason)).strip()[:160]


def web_search(
    workspace: Workspace,
    config: Config,
    query: str,
    max_results: int | None = None,
    backend: str = "",
    cancel: Any = None,
) -> dict[str, Any]:
    """Search the web; backends fall through in order until one yields."""
    q = (query or "").strip()
    if not q:
        return {"content": "ERROR: query is required", "error": True}
    limit = max(1, min(int(max_results or config.web_search_max_results), 20))
    backends = _all_backends(config)
    available = tuple(name for name, backend in backends.items() if backend.available(config))
    if backend:
        # one factual gate for every source: not on the available list -> not
        # named in the error either. No install/setup advice, ever.
        if backend not in available:
            return {
                "content": f"ERROR: backend {backend!r} is not available; available: "
                + (", ".join(available) or "none"),
                "error": True,
            }
        chain: tuple[str, ...] = (backend,)
    else:
        chain = available
    get = functools.partial(_http_get, timeout=config.web_search_timeout, cancel=cancel)
    failures: list[str] = []
    for name in chain:
        try:
            results = backends[name].search(q, limit, config, get)
        except (BackendError, WebError) as e:
            failures.append(f"- {name}: {_short(e)}")
            continue
        seen: set[str] = set()
        deduped = []
        for r in results:
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            deduped.append(r)
        body = "\n".join(f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet']}" for i, r in enumerate(deduped, 1))
        return {"content": f"{len(deduped)} results for {q!r} (via {name}):\n\n{body}"}
    return {
        "content": "ERROR: all search backends failed\n" + "\n".join(failures),
        "error": True,
    }


_BINARY_TYPES = ("image/", "video/", "audio/")
_BINARY_EXACT = {"application/pdf", "application/zip", "application/gzip", "application/x-tar", "application/octet-stream"}


def web_fetch(
    workspace: Workspace,
    config: Config,
    url: str,
    max_chars: int | None = None,
    start: int = 0,
    cancel: Any = None,
) -> dict[str, Any]:
    """One page -> readable text; oversized pages continue at `start`."""
    u = (url or "").strip()
    if not u:
        return {"content": "ERROR: url is required", "error": True}
    try:
        resp = _http_get(u, timeout=config.web_search_timeout, cancel=cancel)
    except WebError as e:
        return {"content": f"ERROR: {_short(e)}", "error": True}
    ctype = resp.content_type.split(";")[0].strip().lower()
    if ctype.startswith(_BINARY_TYPES) or ctype in _BINARY_EXACT:
        return {"content": f"ERROR: unsupported content-type {ctype!r} (text pages only)", "error": True}
    text = _decode_body(resp.body, resp.content_type)
    if "html" in ctype or (not ctype and text.lstrip()[:1] == "<"):
        extractor = _TextExtractor()
        extractor.feed(text)
        extractor.close()
        parts = ([f"# {extractor.title}"] if extractor.title else []) + [extractor.text() or "(no extractable text; the page is probably JS-rendered)"]
        page = "\n\n".join(parts)
    else:
        page = text
    limit = max(200, int(max_chars or config.read_max_chars))
    chunk, next_start = _window(page, int(start or 0), limit)
    if next_start is not None:
        remaining = len(page) - next_start
        chunk += f"\n... [{remaining} chars truncated; fetch again with start={next_start} to continue]"
    if resp.url != u:
        chunk = f"(redirected to {resp.url})\n\n{chunk}"
    return {"content": chunk}
