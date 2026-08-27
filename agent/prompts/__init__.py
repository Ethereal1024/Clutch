"""Prompt templates, kept out of code so wording can be tuned without touching logic.

Uses string.Template placeholders ($name). Loaded lazily at call time.
"""

from __future__ import annotations

from pathlib import Path
from string import Template

_DIR = Path(__file__).resolve().parent


def load(name: str) -> str:
    return (_DIR / name).read_text(encoding="utf-8")


def render(name: str, **kw: object) -> str:
    return Template(load(name)).safe_substitute(**kw)
