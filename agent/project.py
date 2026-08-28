"""Project file (.clc) handling.

A clutch project is a single .clc file that holds the conversation
history. The working directory is the directory containing the .clc file.

Format:
    # clutch project v1
    name: my-app
    model: deepseek-v4-flash
    ---
    <JSONL events follow>

The header is a few key: value lines before the `---` separator; everything
after is one JSON event per line.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .events import DURABLE_TYPES, EventLog, event_from_dict, event_to_json

HEADER_PREFIX = "# clutch project v1"
SEPARATOR = "---"


@dataclass
class ProjectMeta:
    name: str = ""
    model: str = ""


@dataclass
class Project:
    path: Path
    meta: ProjectMeta = field(default_factory=ProjectMeta)
    log: EventLog = field(default_factory=EventLog)

    @property
    def workdir(self) -> Path:
        return self.path.parent

    def events(self):
        return self.log.events()


def create_project(path: Path, name: str, model: str = "") -> Project:
    """Create a new .clc file and return the Project."""
    path = path.with_suffix(".clc")
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = ProjectMeta(name=name, model=model)
    _write_header(path, meta)
    # EventLog(path=...) persists every append to the .clc file after the header
    return Project(path=path, meta=meta, log=EventLog(path=str(path)))


def open_project(path: Path, on_progress=None) -> Project:
    """Load an existing .clc file. on_progress(done, total) is called as the
    file is parsed (byte-based, single pass)."""
    path = path.with_suffix(".clc")
    meta, loaded = _read_file(path, on_progress)
    # older files stored streaming deltas (text/reasoning) that are redundant for
    # replay and context — assistant_message carries the final text + reasoning.
    # Compact them away so the .clc stays small and future loads stay fast.
    durable = [e for e in loaded.events() if e.type in DURABLE_TYPES]
    if len(durable) != len(loaded.events()):
        _rewrite_durable(path, meta, durable)
    log = EventLog(path=str(path))
    log._events.extend(durable)
    return Project(path=path, meta=meta, log=log)


def read_header(path: Path) -> ProjectMeta:
    """Read only the header of a .clc file (up to the --- separator), fast."""
    path = path.with_suffix(".clc")
    meta = ProjectMeta()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.strip() == SEPARATOR:
                break
            _apply_meta(meta, line)
    return meta


def _header_text(meta: ProjectMeta) -> str:
    return "\n".join(
        [
            HEADER_PREFIX,
            f"name: {meta.name}",
            f"model: {meta.model or ''}",
            SEPARATOR,
        ]
    ) + "\n"


def _write_header(path: Path, meta: ProjectMeta) -> None:
    path.write_text(_header_text(meta), encoding="utf-8")


def _rewrite_durable(path: Path, meta: ProjectMeta, events: list) -> None:
    """Atomically rewrite the .clc keeping only durable block events. A crash
    mid-write must not leave a truncated file, so write a tmp then swap it in."""
    tmp = path.with_suffix(".clc.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(_header_text(meta))
        for ev in events:
            f.write(event_to_json(ev) + "\n")
    os.replace(tmp, path)


def _apply_meta(meta: ProjectMeta, line: str) -> None:
    """Apply one header line to meta; ignore comments and malformed lines."""
    if line.startswith("#") or ":" not in line:
        return
    k, v = line.split(":", 1)
    k = k.strip()
    v = v.strip()
    if k == "name":
        meta.name = v
    elif k == "model":
        meta.model = v


def _read_file(path: Path, on_progress=None) -> tuple[ProjectMeta, EventLog]:
    meta = ProjectMeta()
    log = EventLog()
    in_events = False
    total = path.stat().st_size or 1
    consumed = 0
    last_pct = -1
    with open(path, encoding="utf-8") as f:
        for line in f:
            consumed += len(line)
            # throttle: at most one progress line per whole percent — a per-line
            # callback on a 10k-line log would flood the UI with setPct updates
            pct = consumed * 100 // total
            if on_progress and pct != last_pct:
                last_pct = pct
                on_progress(consumed, total)
            line = line.rstrip("\n")
            if not in_events:
                if line.strip() == SEPARATOR:
                    in_events = True
                    continue
                _apply_meta(meta, line)
                continue
            if line.strip():
                try:
                    log._events.append(event_from_dict(json.loads(line)))
                except ValueError:
                    # skip corrupt lines; keep the rest of the history
                    continue
    return meta, log
