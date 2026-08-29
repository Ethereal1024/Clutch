"""Centralized configuration.

All tunables live here (or in CLI args) instead of being scattered across modules.
Prompts stay in agent/prompts/ so wording can be tuned without touching logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    # LLM
    model: str = "deepseek-v4-flash"
    base_url: str = "https://api.deepseek.com"
    # API key from the GUI settings (persisted outside the repo); env still applies
    api_key: str | None = None
    # LLM request tuning
    llm_request_timeout: float = 60.0
    llm_max_retries: int = 3
    llm_retryable_status: frozenset[int] = frozenset({429, 500, 502, 503, 504})
    # model context window (used for compaction overflow detection); tune per model
    llm_context_window: int = 128_000

    # Loop budget
    max_turns: int = 0  # 0 = no turn limit (compaction keeps long runs going); >0 caps turns
    doom_loop_limit: int = 4
    abort_on_doom_loop: bool = True

    # Context management (token-threshold + compaction driven; no turn-count windowing)
    # soft char cap on tool output fed to the model; older results fold below it
    context_char_budget: int = 60000

    # Compaction: when the conversation approaches the context window, the old turns
    # are rolled into a summary and the run continues (opencode-style), instead of
    # dropping them or aborting. This is the ONLY turn-level budget guard — disable
    # it and a long run overflows the window (the API errors out gracefully).
    compaction_enabled: bool = True
    compaction_reserved: int = 20_000  # headroom left for the completion output
    compaction_tail_tokens: int | None = None  # recent tail to preserve; None = auto (~25% usable, cap 15k)
    compaction_model: str | None = None  # model used to write summaries; None = the main model

    # Tool execution
    command_timeout: float = 30.0
    output_limit: int = 6000
    output_head: int = 2500
    output_tail: int = 2500
    read_max_chars: int = 20000

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
