"""Centralized configuration.

All tunables live here (or in CLI args) instead of being scattered across modules.
Prompts stay in agent/prompts/ so wording can be tuned without touching logic.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Reasoning effort knob (extra_body thinking.reasoning_effort). Thinking
# models read it; models without a thinking mode ignore it entirely.
REASONING_EFFORT_LEVELS = ("low", "medium", "max")

# The persisted settings surface: base_url + model + api_key + reasoning_effort.
# Any OpenAI-compatible endpoint works; there are no provider presets and no
# named profiles — one flat config, edited in the settings modal.
_SETTING_FIELDS = ("base_url", "model", "api_key", "reasoning_effort")


def flatten_settings(saved: dict) -> dict:
    """Normalize a settings file into the flat field map (known fields only).

    Legacy shapes are migrated on read: a {profiles: {...}, active: name} map
    collapses to its active profile's values; unknown keys are dropped."""
    if isinstance(saved, dict) and isinstance(saved.get("profiles"), dict):
        saved = saved.get("profiles", {}).get(saved.get("active") or "", {}) or {}
    return {k: saved[k] for k in _SETTING_FIELDS if isinstance(saved, dict) and saved.get(k)}


@dataclass
class Config:
    # LLM. No provider presets: base_url/model/api_key come from the settings
    # modal (persisted flat in ~/.clutch/settings.json), env (CLUTCH_*) or CLI.
    # Empty defaults mean "not configured yet" — the server refuses to run an
    # LLM call until the user fills the settings form.
    model: str = field(default_factory=lambda: os.environ.get("CLUTCH_MODEL", ""))
    base_url: str = field(default_factory=lambda: os.environ.get("CLUTCH_BASE_URL", ""))
    # API key from the GUI settings (persisted outside the repo); env still applies
    api_key: str | None = field(default_factory=lambda: os.environ.get("CLUTCH_API_KEY"))
    # LLM request tuning
    llm_request_timeout: float = 60.0
    llm_max_retries: int = 3
    llm_retryable_status: frozenset[int] = frozenset({429, 500, 502, 503, 504})
    # Reasoning effort: None = leave the request unset (server default);
    # otherwise one of REASONING_EFFORT_LEVELS, sent as
    # extra_body.thinking.reasoning_effort. Ignored by models without thinking.
    llm_reasoning_effort: str | None = None
    # model context window in BYTES (compaction compares against it): ≈128K
    # tokens × 1.5 中文/token × 3 字节/汉字 ≈ 500K. Conservative — the real
    # window is larger, so no output-reserved headroom is subtracted anywhere.
    llm_context_window_bytes: int = 500_000

    # Loop budget
    max_turns: int = 0  # 0 = no turn limit (compaction keeps long runs going); >0 caps turns
    doom_loop_limit: int = 4
    abort_on_doom_loop: bool = True

    # Context management (byte-threshold + compaction driven; no turn-count
    # windowing, no incremental tool-output folding — reads accumulate until
    # compaction rolls the older turns into a summary, so the model's working set
    # is not silently starved)

    # Compaction: when the conversation approaches the context window, the old turns
    # are rolled into a summary and the run continues (opencode-style), instead of
    # dropping them or aborting. This is the ONLY turn-level budget guard — disable
    # it and a long run overflows the window (the API errors out gracefully).
    compaction_enabled: bool = True
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
