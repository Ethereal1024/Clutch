"""Filesystem tools: read_file / write_file / list_dir.

Each tool returns a structured dict; the registry formats it for the model.
"""

from __future__ import annotations

from pathlib import Path

from ..config import Config
from .workspace import Workspace


def _result(content: str, error: bool = False) -> dict:
    return {"content": content, "error": error}


def read_file(workspace: Workspace, config: Config, path: str, max_chars: int = 0) -> dict:
    limit = max_chars or config.read_max_chars
    try:
        p: Path = workspace.resolve(path)
        if not p.is_file():
            return _result(f"ERROR: not a file or missing: {path}", error=True)
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text) > limit:
            text = text[:limit] + f"\n... [truncated, file is {p.stat().st_size} bytes]"
        return _result(text)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return _result(f"ERROR: read failed: {e}", error=True)


def write_file(workspace: Workspace, config: Config, path: str, content: str) -> dict:
    try:
        p: Path = workspace.resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return _result(f"OK: wrote {p} ({len(content)} chars)")
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: write failed: {e}", error=True)


def list_dir(workspace: Workspace, config: Config, path: str = ".") -> dict:
    try:
        p: Path = workspace.resolve(path)
        if not p.is_dir():
            return _result(f"ERROR: not a directory: {path}", error=True)
        lines = sorted(f.name + ("/" if f.is_dir() else "") for f in p.iterdir())
        return _result("\n".join(lines) if lines else "(empty directory)")
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: {e}", error=True)
