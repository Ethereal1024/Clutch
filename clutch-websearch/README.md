# clutch-websearch

Web search + page fetch as a standalone CLI. Stdlib only, one process, no host
code imported: it takes argv, talks HTTP, prints text (or JSON) and exits.

## CLI

```
python3 websearch.py search "query" [--max-results N] [--backend NAME] [--json]
python3 websearch.py fetch URL [--max-chars N] [--start N] [--json]
python3 websearch.py backends [--json]
```

Exit codes: `0` ok, `1` the command failed (reason on stdout), `2` usage/protocol
error (argparse). `--json` always emits one JSON object; `backends` names the
unconfigured backends on **stderr**, so a caller reading stdout for the list is
unaffected.

## Backends

Tried in order, first success wins:

| backend | activated by | notes |
|---|---|---|
| tavily | `CLUTCH_TAVILY_API_KEY` / `TAVILY_API_KEY` | LLM-first search API, best quality |
| searxng | `CLUTCH_SEARXNG_URL` / `SEARXNG_URL` | self-hosted metasearch, JSON API |
| bing | nothing (keyless) | undocumented RSS endpoint of `www.bing.com` |
| ddg | nothing (keyless) | duckduckgo html endpoint |

Other environment: `CLUTCH_WEBSEARCH_TIMEOUT` (15.0 s),
`CLUTCH_WEBSEARCH_MAX_RESULTS` (8), `CLUTCH_WEBSEARCH_MAX_CHARS` (20000),
`CLUTCH_WEBSEARCH_MAX_BYTES` (2000000), `CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS`.

## The contract callers can rely on

- **bounded I/O** — every request has a timeout; a heavy page is retried once
  (GET only, never a POST), and responses over `max_bytes` are rejected;
- **private-network guard** — `fetch` refuses loopback/LAN/link-local hosts, and
  a redirect is re-checked against the same rule. A literal address is judged
  locally (`ipaddress`), never through the resolver: asking DNS about `127.0.0.1`
  would both hang when the resolver is dead and let a lying resolver through.
  Search endpoints are operator-configured, so a self-hosted searxng on the LAN
  still works;
- **error-as-data** — a failure is a reason string, and a failed chain carries the
  per-backend reasons, so degradation is visible instead of silent;
- **truncation hints** — an oversized page reports `next_start`, mirroring
  `read_file`'s offset hints.

## Postmortem fixes carried over

`WEBSEARCH_POSTMORTEM.md` (the SRU 404 event) drives four of these:

- **P0 link-preserving extraction**: `_TextExtractor` renders anchors as
  `[text](url)`, so a caller never invents a URL from a button label — losing
  hrefs is what made a model guess an owner and report four honest 404s as
  "never published";
- **P0 the chain announces its own degradation**: `backends` prints the usable
  list and names the unconfigured ones;
- **P1 relevance guard**: a scraped backend whose results share no term with the
  query raises `BackendError` and falls through, instead of answering an English
  niche query with unrelated Chinese pages;
- **P1 bing market/language follows the query's script** instead of a hardcoded
  `zh-CN` preference; **P2** one timeout retry and the docstring names the
  endpoint really used (`www.bing.com`, not `cn.bing.com`).

## Tests

```
cd clutch-websearch && python3 -m pytest
```

Run from inside the directory: `tests/` is imported as a package root there.
`tests/stub_server.py` serves real pages over a loopback socket, so the CLI tests
exercise the module over real HTTP rather than through mocks.
