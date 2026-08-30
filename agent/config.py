"""Centralized configuration.

All tunables live here (or in CLI args) instead of being scattered across modules.
Prompts stay in agent/prompts/ so wording can be tuned without touching logic.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Known LLM providers: name -> (default base_url, default model). Every preset
# here speaks the OpenAI chat-completions protocol, so one client SDK serves
# them all (DeepSeek, Zhipu, Moonshot, Ollama, ...); users may override both
# the base_url and the model per deployment. "custom" is the escape hatch for
# any other OpenAI-compatible endpoint (self-hosted gateways, vLLM, etc.).
PROVIDER_PRESETS: dict[str, tuple[str, str]] = {
    "deepseek": ("https://api.deepseek.com", "deepseek-v4-flash"),
    "zhipu": ("https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"),
    "openai": ("https://api.openai.com/v1", "gpt-4o-mini"),
    "moonshot": ("https://api.moonshot.cn/v1", "moonshot-v1-8k"),
    "ollama": ("http://127.0.0.1:11434/v1", "llama3.1"),
    "custom": ("", ""),  # base_url + model supplied explicitly
}


def provider_preset(provider: str) -> tuple[str, str]:
    """(base_url, model) defaults for a provider name; ("", "") when unknown."""
    return PROVIDER_PRESETS.get(provider, ("", ""))


# ---------------------------------------------------------------------------
# Multi-API profiles. settings.json may hold several named LLM endpoints
# ("profiles": {"deepseek": {...}, "zhipu-53": {...}}) with one "active" name,
# so switching providers no longer overwrites the previous one. Older files
# holding a single flat {provider, base_url, model, api_key} are migrated to a
# single "default" profile on read — every reader (server bootstrap, /api/
# settings, the client-side LLM proxy) goes through these helpers.
# ---------------------------------------------------------------------------

_PROFILE_FIELDS = ("provider", "base_url", "model", "api_key", "reasoning_effort")

# GLM-5.3 thinking depth (extra_body thinking.reasoning_effort). Only zhipu's
# thinking models read it; other providers ignore the knob entirely.
REASONING_EFFORT_LEVELS = ("low", "medium", "max")


def normalize_settings(saved: dict) -> dict:
    """Migrate legacy flat settings into the profiles map + active name.

    ``saved`` is the raw settings dict; returns ``{"profiles": {name: {...}},
    "active": name}``. A legacy file becomes the single "default" profile and
    stays active; an empty file yields empty profiles and no active name."""
    if isinstance(saved, dict) and isinstance(saved.get("profiles"), dict):
        return saved
    entry = {k: saved.get(k) for k in _PROFILE_FIELDS if saved.get(k)}
    profiles = {"default": entry} if entry else {}
    return {"profiles": profiles, "active": "default" if entry else ""}


def active_profile(saved: dict) -> dict:
    """The currently active profile's config (empty dict when none)."""
    norm = normalize_settings(saved)
    profs = norm.get("profiles") or {}
    return profs.get(norm.get("active") or "") or {}


def resolve_llm_endpoint(
    *,
    cli: dict[str, str | None],
    env: dict[str, str | None],
    saved: dict,
    defaults: Config,
) -> tuple[str, str, str]:
    """Resolve (provider, base_url, model) for a server start.

    Precedence: CLI args > environment (CLUTCH_PROVIDER / CLUTCH_BASE_URL /
    CLUTCH_MODEL) > GUI-saved settings > defaults. base_url/model the user did
    not set are filled from the provider preset, so switching provider moves
    the whole endpoint (DeepSeek -> Zhipu etc.). Raises ValueError for an
    unknown provider name (the caller turns that into a friendly startup
    error)."""
    provider = cli.get("provider") or env.get("CLUTCH_PROVIDER") or saved.get("provider") or defaults.provider
    if provider not in PROVIDER_PRESETS:
        raise ValueError(f"unknown provider: {provider} (choose from {', '.join(sorted(PROVIDER_PRESETS))})")
    base_url = cli.get("base_url") or env.get("CLUTCH_BASE_URL") or (saved.get("base_url") or "").strip() or ""
    model = cli.get("model") or env.get("CLUTCH_MODEL") or (saved.get("model") or "").strip() or ""
    p_base, p_model = provider_preset(provider)
    return provider, (base_url or p_base or defaults.base_url), (model or p_model or defaults.model)


@dataclass
class Config:
    # LLM. Defaults may come from the environment (CLUTCH_*); the server main()
    # layers CLI args and the GUI-saved settings on top with explicit precedence
    # (CLI > env > saved settings > defaults).
    provider: str = field(default_factory=lambda: os.environ.get("CLUTCH_PROVIDER", "deepseek"))
    model: str = field(default_factory=lambda: os.environ.get("CLUTCH_MODEL", "deepseek-v4-flash"))
    base_url: str = field(default_factory=lambda: os.environ.get("CLUTCH_BASE_URL", "https://api.deepseek.com"))
    # API key from the GUI settings (persisted outside the repo); env still applies
    api_key: str | None = field(default_factory=lambda: os.environ.get("CLUTCH_API_KEY"))
    # LLM request tuning
    llm_request_timeout: float = 60.0
    llm_max_retries: int = 3
    llm_retryable_status: frozenset[int] = frozenset({429, 500, 502, 503, 504})
    # GLM-5.3 thinking depth: None = leave the request unset (provider default);
    # otherwise one of REASONING_EFFORT_LEVELS, sent as
    # extra_body.thinking.reasoning_effort. Ignored by non-thinking models.
    llm_reasoning_effort: str | None = None
    # model context window (used for compaction overflow detection); tune per model
    llm_context_window: int = 128_000

    # Loop budget
    max_turns: int = 0  # 0 = no turn limit (compaction keeps long runs going); >0 caps turns
    doom_loop_limit: int = 4
    abort_on_doom_loop: bool = True

    # Context management (token-threshold + compaction driven; no turn-count
    # windowing, no incremental tool-output folding — reads accumulate until
    # compaction rolls the older turns into a summary, so the model's working set
    # is not silently starved)

    # Compaction: when the conversation approaches the context window, the old turns
    # are rolled into a summary and the run continues (opencode-style), instead of
    # dropping them or aborting. This is the ONLY turn-level budget guard — disable
    # it and a long run overflows the window (the API errors out gracefully).
    compaction_enabled: bool = True
    compaction_reserved: int = 10_000  # headroom for the completion output (DeepSeek caps output ~8k; 20k wasted 12k → later trigger, fewer compactions)
    compaction_tail_tokens: int | None = None  # recent tail to preserve; None = auto (~25% usable, cap 15k)
    compaction_model: str | None = None  # model used to write summaries; None = the main model

    # Tool execution
    command_timeout: float = 30.0
    output_limit: int = 6000
    output_head: int = 2500
    output_tail: int = 2500
    read_max_chars: int = 20000

    # Agent mode: "work" (full toolset) or "chat" (read-only: read_file/grep/
    # run_command restricted to a provably-read-only whitelist, memory tools, and
    # load_skill). Default work keeps existing behavior; the UI sets mode per run.
    mode: str = "work"

    # Verification gate: an explicit command (e.g. a test suite) that the agent
    # must pass before the task counts as done. Empty = no verification (the
    # agent's own "done" reply is trusted, per the open-source norm that a
    # verification command is part of the task spec, never a built-in default).
    verify_command: str = ""

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
    # Skills: catalog in the system prompt; model loads one on demand via load_skill
    enable_skills: bool = True
    skills_dir: Path = Path(__file__).resolve().parent / "skills"
    # Permission: confirm risky actions with the user (opencode-style), not a sandbox
    non_interactive: bool = False  # auto-allow (used by eval harness / unattended runs)

    def truncate(self, text: str) -> str:
        """Head/tail trim oversized output; the middle is replaced with an omitted note."""
        if len(text) <= self.output_limit:
            return text
        omitted = len(text) - self.output_head - self.output_tail
        return f"{text[: self.output_head]}\n... [{omitted} chars omitted] ...\n{text[-self.output_tail :]}"
