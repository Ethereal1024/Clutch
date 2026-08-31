"""Centralized configuration.

All tunables live here (or in CLI args); prompts stay in agent/prompts/.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Reasoning effort knob (extra_body thinking.reasoning_effort); ignored by models without thinking
REASONING_EFFORT_LEVELS = ("low", "medium", "max")

# Persisted settings fields: flat, no provider presets
_SETTING_FIELDS = ("base_url", "model", "api_key", "reasoning_effort")


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
    # LLM request tuning
    llm_request_timeout: float = 60.0
    llm_max_retries: int = 3
    llm_retryable_status: frozenset[int] = frozenset({429, 500, 502, 503, 504})
    # None = leave the request unset (server default); otherwise one of REASONING_EFFORT_LEVELS
    llm_reasoning_effort: str | None = None
    # model context window in BYTES (compaction compares against it)
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

    # Compaction: old turns roll into a summary as the window fills
    compaction_enabled: bool = True
    compaction_model: str | None = None  # None = the main model

    # Tool execution
    command_timeout: float = 30.0
    output_limit: int = 6000
    output_head: int = 2500
    output_tail: int = 2500
    read_max_chars: int = 20000

    # Agent mode: "work" = full toolset, "chat" = read-only (whitelist + memory + skills)
    mode: str = "work"

    # Verification gate: a command the agent must pass before the task counts as
    # done; empty = the agent's own "done" reply is trusted.
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
    # Skills: catalog in the system prompt; loaded on demand via load_skill
    enable_skills: bool = True
    skills_dir: Path = Path(__file__).resolve().parent / "skills"
    # Permission: confirm risky actions with the user, not a sandbox
    non_interactive: bool = False  # auto-allow (used by eval harness / unattended runs)

    def truncate(self, text: str) -> str:
        """Head/tail trim oversized output; the middle is replaced with an omitted note."""
        if len(text) <= self.output_limit:
            return text
        omitted = len(text) - self.output_head - self.output_tail
        return f"{text[: self.output_head]}\n... [{omitted} chars omitted] ...\n{text[-self.output_tail :]}"
