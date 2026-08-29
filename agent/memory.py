"""Project memory: durable facts stored in a `[memories]` section of the .clc.

Each memory is a short title (a one-line summary) + full content, kept as one
JSONL line per memory inside the project's single .clc file (so the project
stays one file, and the remote/exec persistence path is reused). The model can
save/load/search memories through tools; the system prompt carries the resident
title list so the model can pick what to load.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

SECTION = "[memories]"
MAX_TITLE_CHARS = 80
MAX_CONTENT_CHARS = 4000


@dataclass
class Memory:
    title: str
    content: str
    updated: float = field(default_factory=time.time)


def _to_line(m: Memory) -> str:
    return json.dumps({"title": m.title, "content": m.content, "updated": m.updated}, ensure_ascii=False)


class MemoryStore:
    """In-memory view of the project's memories + persistence to the .clc section.

    ``writer(path, line)`` appends one line (local open or the remote exec
    bridge); None = local append. Same-shaped persistence as EventLog.
    """

    def __init__(
        self,
        path: str,
        writer: Callable[[str, str], None] | None = None,
        items: dict[str, Memory] | None = None,
    ) -> None:
        self._path = path
        self._writer = writer
        self._items: dict[str, Memory] = items or {}
        self._section_written = bool(items)  # a loaded section already exists

    def items(self) -> dict[str, Memory]:
        return dict(self._items)

    def get(self, title: str) -> Memory | None:
        return self._items.get(title)

    def search(self, query: str) -> list[Memory]:
        q = query.lower()
        return [m for m in self._items.values() if q in m.title.lower() or q in m.content.lower()]

    def save(self, title: str, content: str) -> Memory:
        m = Memory(title=title, content=content)
        self._items[title] = m
        if not self._section_written:
            self._append(SECTION)
            self._section_written = True
        self._append(_to_line(m))
        return m

    def serialize(self) -> str:
        """The [memories] section text (marker + lines) for a compact rewrite."""
        if not self._items:
            return ""
        return SECTION + "\n" + "\n".join(_to_line(m) for m in self._items.values()) + "\n"

    def _append(self, line: str) -> None:
        if self._writer:
            self._writer(self._path, line)
        else:
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(line + "\n")

    @classmethod
    def parse(cls, raw_lines: list[str], path: str, writer: Callable[[str, str], None] | None = None) -> "MemoryStore":
        items: dict[str, Memory] = {}
        for line in raw_lines:
            line = line.strip()
            if not line:
                continue
            try:
                d: dict[str, Any] = json.loads(line)
                items[d["title"]] = Memory(d["title"], d.get("content", ""), d.get("updated", 0))
            except (ValueError, KeyError, TypeError):
                continue
        return cls(path, writer=writer, items=items)
