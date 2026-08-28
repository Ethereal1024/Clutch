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
from dataclasses import dataclass, field
from pathlib import Path

from .events import EventLog, event_from_dict

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
    log = EventLog(path=str(path))
    log._events.extend(loaded.events())
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


def _write_header(path: Path, meta: ProjectMeta) -> None:
    lines = [
        HEADER_PREFIX,
        f"name: {meta.name}",
        f"model: {meta.model or ''}",
        SEPARATOR,
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
