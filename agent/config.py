"""Centralized configuration.

All tunables live here (or in CLI args); the machine's prompt text
(its error answers and tool prose) stays in agent/prompts/.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Reasoning effort knob (extra_body thinking.reasoning_effort); ignored by models without thinking
REASONING_EFFORT_LEVELS = ("low", "medium", "max")

# Wire protocol of the configured endpoint: "chat" = POST /chat/completions (the
# default; nearly every OpenAI-compatible endpoint speaks it), "responses" =
# POST /responses (providers that serve both do so on the SAME base_url).
API_PROTOCOLS = ("chat", "responses")

# Persisted settings fields: flat, no provider presets
_SETTING_FIELDS = ("base_url", "model", "api_key", "reasoning_effort", "api_protocol")


def flatten_settings(saved: dict) -> dict:
    """Normalize a settings file into the flat field map (known fields only);
    legacy {profiles, active} maps collapse to the active profile."""
    if isinstance(saved, dict) and isinstance(saved.get("profiles"), dict):
        saved = saved.get("profiles", {}).get(saved.get("active") or "", {}) or {}
    return {k: saved[k] for k in _SETTING_FIELDS if isinstance(saved, dict) and saved.get(k)}


@dataclass
class Config:
    # LLM endpoint: settings modal / env (CLUTCH_*) / CLI; empty = not configured yet
    model: str = field(default_factory=lambda: os.environ.get("CLUTCH_MODEL", ""))
    base_url: str = field(default_factory=lambda: os.environ.get("CLUTCH_BASE_URL", ""))
    api_key: str | None = field(default_factory=lambda: os.environ.get("CLUTCH_API_KEY"))
    # The knobs below are SETTINGS this host stores and serves, not numbers it
    # spends: nothing in agent/ makes a model request any more (P4 — the loop,
    # its client and its retry ladder live in the window: ui/llm-client.js). The
    # request tuning that used to sit here (request/read timeouts, retry count,
    # retryable statuses) went with them, into the module that acts on them.
    # None = leave the request unset (server default); otherwise one of REASONING_EFFORT_LEVELS
    llm_reasoning_effort: str | None = None
    # Which wire protocol the endpoint speaks; None = "chat" (the default).
    # Like the reasoning knob it is env-less: it describes this endpoint
    # pairing, which the settings surface already owns.
    llm_api_protocol: str | None = None
    # model context window in BYTES, served to the client as `contextWindowBytes`:
    # the client's compactor fires when its window reaches this size.
    llm_context_window_bytes: int = 500_000

    # Loop budget
    max_turns: int = 0  # 0 = no turn limit (compaction keeps long runs going); >0 caps turns
    # Doom-loop guard: N identical calls (same name + arguments + result content)
    # in a row. First detection feeds a warning back as an error; repeating the
    # exact warned call then aborts the run (abort_on_doom_loop=False keeps
    # feeding feedback instead). Identical calls whose results change are
    # progress (polling, flaky tests) and never trigger.
    doom_loop_limit: int = 4
    abort_on_doom_loop: bool = True

    # Compaction: old turns roll into a summary as the window fills. There is
    # deliberately no separate budget for it: the trigger is
    # llm_context_window_bytes above, and the whole window is the summarizer's
    # input (see Compactor._serialize).

    # Tool execution
    command_timeout: float = 30.0
    output_limit: int = 6000
    output_head: int = 2500
    output_tail: int = 2500
    read_max_chars: int = 20000

    # Web access: the tools themselves live on the CLIENT now (the
    # clutch-websearch plugin keeps its own settings in its own environment), so
    # what stays here is only the host fact `$backends` reads — which search
    # providers this machine has configured (catalog.DEFAULT_BACKENDS).
    # Tavily (https://tavily.com, LLM-first search API, free tier)
    tavily_api_key: str | None = field(
        default_factory=lambda: os.environ.get("CLUTCH_TAVILY_API_KEY") or os.environ.get("TAVILY_API_KEY")
    )
    # Self-hosted SearXNG instance exposing format=json (searxng/searxng)
    searxng_url: str = field(
        default_factory=lambda: (
            os.environ.get("CLUTCH_SEARXNG_URL") or os.environ.get("SEARXNG_URL") or ""
        ).rstrip("/")
    )
    # Agent mode: "work" = full toolset, "chat" = read-only (whitelist + memory)
    mode: str = "work"

    # Commands that hang in a non-TTY pipe
    blocked_prefixes: list[str] = field(
        default_factory=lambda: [
            "vim",
            "vi",
            "emacs",
            "nano",
            "less",
            "more",
            "tail -f",
            "top",
            "htop",
            "make",
        ]
    )

    # Runtime
    port: int = 8890
    host: str = "127.0.0.1"  # bind address; 0.0.0.0 exposes the API to other devices
    # Permission: confirm risky actions with the user, not a sandbox
    non_interactive: bool = False  # auto-allow (unattended runs: no one to ask)

    def truncate(self, text: str) -> str:
        """Head/tail trim oversized output; the middle is replaced with an omitted note."""
        if len(text) <= self.output_limit:
            return text
        omitted = len(text) - self.output_head - self.output_tail
        return f"{text[: self.output_head]}\n... [{omitted} chars omitted] ...\n{text[-self.output_tail :]}"
