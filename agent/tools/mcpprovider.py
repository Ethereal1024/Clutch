"""Registry of external MCP tool servers that extend web search.

One entry here turns a generic HTTP MCP server into a web_search backend: the
provider names its config key, the tool to call, and how to map its results
onto the uniform {title, url, snippet} shape. Adding a platform means adding
one McpProvider to MCP_PROVIDERS — the search chain, the rendered prompt and
the settings UI all pick it up without further changes.

Hosts without a given service configured simply leave the URL empty: the
backend is then absent from the chain, and nothing in the prompts, the error
texts or the UI mentions it (no "please install X" advice, ever).

Import-safe from anywhere: stdlib only, no agent-package imports.
"""

from __future__ import annotations

import os
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class McpProvider:
    """Declarative spec for one MCP-backed search source."""

    name: str                                # backend name (web_search backend=<name>)
    label: str                               # human label for the settings modal
    search_tool: str                         # MCP tool invoked for searches
    search_args: Callable[[str, int], dict]  # (query, limit) -> tool arguments
    map_results: Callable[[Any], list[dict]]  # parsed tool result -> [{title,url,snippet}]
    placeholder: str = ""                    # example URL shown in the settings modal
    status_tool: str = ""                    # optional MCP tool reporting login state

    def url_for(self, config: Any) -> str:
        """Configured endpoint ('' = not configured on this machine).

        Settings-modal values land in Config.mcp_urls under the provider name;
        CLUTCH_MCP_<NAME>_URL is the env-only equivalent.
        """
        urls = getattr(config, "mcp_urls", None) or {}
        value = urls.get(self.name) or os.environ.get(
            f"CLUTCH_MCP_{self.name.upper()}_URL", ""
        )
        return str(value).strip().rstrip("/")


def _first_list(data: Any) -> list:
    """Pull the first list value out of a tool result (bare list or wrapped)."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "items", "feeds", "results", "notes"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


# ---- concrete providers ------------------------------------------------------


def _xhs_args(query: str, limit: int) -> dict:
    return {"keyword": query, "limit": limit}


def _xhs_map(data: Any) -> list[dict]:
    """search_feeds rows -> uniform rows. Keeps xsec_token in the URL:
    follow-up detail calls (and the site itself) require it."""
    rows: list[dict] = []
    for it in _first_list(data):
        if not isinstance(it, dict):
            continue
        note_id = str(it.get("id") or it.get("note_id") or "").strip()
        if not note_id:
            continue
        url = f"https://www.xiaohongshu.com/explore/{note_id}"
        token = str(it.get("xsec_token") or "").strip()
        if token:
            url += "?" + urllib.parse.urlencode({"xsec_token": token})
        rows.append(
            {
                "title": str(it.get("title") or "").strip(),
                "url": url,
                "snippet": str(it.get("desc") or it.get("description") or "").strip(),
            }
        )
    return rows


XIAOHONGSHU = McpProvider(
    name="xiaohongshu",
    label="Xiaohongshu MCP",
    search_tool="search_feeds",
    search_args=_xhs_args,
    map_results=_xhs_map,
    placeholder="http://localhost:18060/mcp",
    status_tool="check_login_status",
)

# The registry. Extension point: add one entry, everything else follows
# (search chain, rendered prompt, settings modal rows).
MCP_PROVIDERS: dict[str, McpProvider] = {
    "xiaohongshu": XIAOHONGSHU,
}
