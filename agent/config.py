"""Centralized configuration.

All tunables live here (or in CLI args) instead of being scattered across modules.
Prompts stay in agent/prompts/ so wording can be tuned without touching logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


@dataclass
class Config:
    # LLM
    model: str = "deepseek-v4-flash"
    base_url: str = "https://api.deepseek.com"
    max_tokens: int = 4096

    # Loop budget
    max_turns: int = 20
    doom_loop_limit: int = 4
    abort_on_doom_loop: bool = True

    # Context management
    max_history_turns: int = 24
    # soft char budget for tool outputs fed to the model; older results fold below it
    context_char_budget: int = 60000

    # Tool execution
    command_timeout: float = 30.0
    output_limit: int = 6000
    output_head: int = 2500
    output_tail: int = 2500
    read_max_chars: int = 20000

    # Verification gate (acceptance criteria for the demo game)
    verify_command: str = "python3 {file} --test"
    game_file: str = "snake.py"

    # Commands that hang in a non-TTY pipe
    blocked_prefixes: list[str] = field(
        default_factory=lambda: [
            "python", "python3", "vim", "vi", "emacs", "nano",
            "less", "more", "tail -f", "top", "htop", "make",
        ]
    )

    # Runtime
    sandbox_dir: str | None = None
    log_path: str | None = None
    prompts_dir: Path = PROMPTS_DIR
