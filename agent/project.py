"""Project file (.clc) handling.

A clutch project is a single .clc file (like a PSD) that holds the conversation
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

from .events import Event, EventLog, event_from_dict, event_to_json

HEADER_PREFIX = "# clutch project v1"
SEPARATOR = "---"


class ProjectLog(EventLog):
    """EventLog whose appends are persisted into the .clc file (after the header).

    The in-memory list is the single source of truth for the running session;
    every append also writes a JSON line to the .clc file for persistence.
    """

    def __init__(self, file_path: Path) -> None:
        super().__init__()
        self._file_path = file_path

    def append(self, event: Event) -> Event:
        self._events.append(event)
        with open(self._file_path, "a", encoding="utf-8") as f:
            f.write(event_to_json(event) + "\n")
        return event


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
    return Project(path=path, meta=meta, log=ProjectLog(path))


def open_project(path: Path) -> Project:
    """Load an existing .clc file."""
    path = path.with_suffix(".clc")
    meta, loaded = _read_file(path)
    log = ProjectLog(path)
    log._events.extend(loaded.events())
    return Project(path=path, meta=meta, log=log)


def _write_header(path: Path, meta: ProjectMeta) -> None:
    lines = [
        HEADER_PREFIX,
        f"name: {meta.name}",
        f"model: {meta.model or ''}",
        SEPARATOR,
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _read_file(path: Path) -> tuple[ProjectMeta, EventLog]:
    meta = ProjectMeta()
    log = EventLog()
    in_events = False
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not in_events:
                if line.strip() == SEPARATOR:
                    in_events = True
                    continue
                if line.startswith("#"):
                    continue
                if ":" in line:
                    k, v = line.split(":", 1)
                    k = k.strip()
                    v = v.strip()
                    if k == "name":
                        meta.name = v
                    elif k == "model":
                        meta.model = v
                continue
            if line.strip():
                try:
                    log._events.append(event_from_dict(json.loads(line)))
                except (ValueError, json.JSONDecodeError):
                    # skip corrupt lines; keep the rest of the history
                    continue
    return meta, log


def project_meta(path: Path) -> ProjectMeta:
    """Read only the header of a .clc file."""
    meta, _ = _read_file(path)
    return meta
