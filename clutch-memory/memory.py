#!/usr/bin/env python3
"""clutch-memory: project memories as a standalone one-shot CLI.

The model's durable per-project memories live inside the project's single
.clc file. This module reads and writes them by talking to the agent
server's GENERIC .clc content endpoints — no host code is imported:

  GET  /api/clc?lo=N&hi=N          -> {"size", "b64"}      (raw bytes [lo, hi))
  POST /api/clc/append  {"line"}   -> {"offset", "size"}   (append one line)
  POST /api/clc/patch   {offset, b64} -> {"size"}          (in-place bytes)

The wire contract is the .clc FILE FORMAT, shared with the host:

  header   # comment / name / model / cpr_start / memory_index / ---
  index    one fixed-width line "memory_index=,CC,HH,<16-digit offset>x10"
           (comma right after '=' — the host's join artifact, now frozen):
           a FIFO ring of the last MEMORY_INDEX_SLOTS memory-line byte
           offsets, patched IN PLACE on every save (never appended, so the
           event region's offsets never shift)
  lines    one JSON object per memory {"title","content","updated"},
           appended at the file tail, scattered among the event lines

Every invocation is one process: read the index, do the work, exit. The
append endpoint hands back the WRITE OFFSET, so pointing the index at the
new line is race-free — no re-stat of the file, no guesswork.

Output is one JSON object on stdout; exit codes: 0 ok, 1 not found,
2 transport/protocol error (argparse usage errors also exit 2).
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request

# --- the .clc memory format (mirrors the host's agent/memory.py; the file
# --- format IS the shared contract — duplicated on purpose, never imported)
SECTION = "[memories]"  # diagnostic marker + legacy-scan anchor (written once)

MEMORY_INDEX_SLOTS = 10
_PREFIX = "memory_index="
_FIELD_W = 16  # decimal byte offset, zero-padded
INDEX_LINE_W = (
    len(_PREFIX)  # 13
    + 2           # count field
    + 2           # head field
    + MEMORY_INDEX_SLOTS * _FIELD_W
    + (3 + MEMORY_INDEX_SLOTS - 1)  # commas between the 3 + SLOTS fields
)  # = 189 bytes, fixed

# one memory line is read by offset with this chunk (a memory is a short
# note; 32 KB always covers a full line)
READ_CHUNK = 32 * 1024
# the header (where the index line lives) is always within the first 64 KB
HEADER_SCAN = 64 * 1024
HTTP_TIMEOUT = 30


class ClcError(Exception):
    """Transport, protocol, or format failure (exit 2)."""


class NotFound(Exception):
    """A requested memory title is not in the index (exit 1)."""


# ---------------------------------------------------------------- index codec

def index_line(count: int, head: int, offsets: list[int]) -> str:
    """Serialize the index line (offsets: one value per ring slot)."""
    parts = [_PREFIX, f"{count:02d}", f"{head:02d}"]
    parts += [f"{o:0{_FIELD_W}d}" for o in offsets]
    return ",".join(parts)


def parse_index_line(line: str) -> tuple[int, int, list[int]]:
    """Parse an index line -> (count, head, offsets); raises ClcError."""
    fields = line.strip().split(",")
    if len(fields) != 3 + MEMORY_INDEX_SLOTS or fields[0] != _PREFIX:
        raise ClcError(f"corrupt memory_index line: {line[:40]!r}")
    try:
        count = int(fields[1])
        head = int(fields[2])
        offsets = [int(x) for x in fields[3:]]
    except ValueError:
        raise ClcError(f"corrupt memory_index line: {line[:40]!r}") from None
    if not (0 <= count <= MEMORY_INDEX_SLOTS and 0 <= head < MEMORY_INDEX_SLOTS):
        raise ClcError(f"out-of-range ring fields: count={count} head={head}")
    return count, head, offsets


def ring_add(count: int, head: int, offsets: list[int], off: int) -> tuple[int, int]:
    """Push a new offset into the ring (FIFO: evict the oldest when full).
    Mutates ``offsets`` in place; returns the new (count, head)."""
    if count < MEMORY_INDEX_SLOTS:
        offsets[(head + count) % MEMORY_INDEX_SLOTS] = off
        return count + 1, head
    offsets[head] = off
    return count, (head + 1) % MEMORY_INDEX_SLOTS


def ring_items(count: int, head: int, offsets: list[int]) -> list[int]:
    """Valid offsets in FIFO order (oldest first)."""
    return [offsets[(head + i) % MEMORY_INDEX_SLOTS] for i in range(count)]


# ---------------------------------------------------------------- the client

class ClcClient:
    """Byte-level .clc access over the agent server's /api/clc* endpoints."""

    def __init__(self, base_url: str) -> None:
        self.base = base_url.rstrip("/")

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8")).get("error") or ""
            except (ValueError, OSError):
                msg = ""
            raise ClcError(f"{method} {path}: HTTP {e.code}: {msg}".rstrip(": ")) from None
        except urllib.error.URLError as e:
            raise ClcError(f"{method} {path}: {e.reason}") from None
        except ValueError as e:
            raise ClcError(f"{method} {path}: bad response: {e}") from None

    def size(self) -> int:
        return int(self._request("GET", "/api/clc?lo=0&hi=0")["size"])

    def read_range(self, lo: int, hi: int) -> bytes:
        d = self._request("GET", f"/api/clc?lo={lo}&hi={hi}")
        return base64.b64decode(d["b64"])

    def append_line(self, line: str) -> tuple[int, int]:
        """Append one line; returns (write offset, new file size)."""
        d = self._request("POST", "/api/clc/append", {"line": line})
        return int(d["offset"]), int(d["size"])

    def patch(self, offset: int, data: bytes) -> None:
        self._request("POST", "/api/clc/patch", {"offset": offset, "b64": base64.b64encode(data).decode("ascii")})


# -------------------------------------------------------------------- store

def _find_index_line(head: bytes) -> tuple[int, str]:
    """Locate the header's fixed-width index line -> (byte offset, line)."""
    off = 0
    for raw in head.split(b"\n"):
        if raw.startswith(_PREFIX.encode("ascii")):
            return off, raw.decode("ascii")
        off += len(raw) + 1
    raise ClcError("no memory_index line in the .clc header (legacy file?)")


class MemoryStore:
    """The .clc memory region, as seen through the content endpoints.

    One process per command: every operation re-reads the index from the
    file, so the on-disk ring is the only source of truth.
    """

    def __init__(self, client: ClcClient) -> None:
        self._c = client

    def _load_index(self) -> tuple[int, int, int, list[int]]:
        """-> (index line byte offset, count, head, offsets)."""
        raw = self._c.read_range(0, HEADER_SCAN)
        idx_off, line = _find_index_line(raw)
        count, head, offsets = parse_index_line(line)
        if len(line.encode("ascii")) != INDEX_LINE_W:
            raise ClcError(f"memory_index line is not {INDEX_LINE_W} bytes wide")
        return idx_off, count, head, offsets

    def _read_line_at(self, off: int, total: int) -> str:
        raw = self._c.read_range(off, min(off + READ_CHUNK, total))
        return raw.split(b"\n", 1)[0].decode("utf-8", "replace")

    def load_all(self) -> dict[str, dict]:
        """Every indexed memory, FIFO oldest -> newest, deduped by title
        (the newest line for a title wins)."""
        _, count, head, offsets = self._load_index()
        total = self._c.size()
        items: dict[str, dict] = {}
        for off in ring_items(count, head, offsets):
            if off <= 0:
                continue
            try:
                d = json.loads(self._read_line_at(off, total))
                items[d["title"]] = {"title": d["title"], "content": d.get("content", ""), "updated": d.get("updated", 0)}
            except (ValueError, KeyError, TypeError):
                continue  # a torn/corrupt line: skip it, the rest still load
        return items

    def save(self, title: str, content: str) -> dict:
        """Append one memory line and repoint the header index at it."""
        idx_off, count, head, offsets = self._load_index()
        if count == 0:
            # first memory in this file: the [memories] marker, once
            self._c.append_line(SECTION)
        rec = {"title": title, "content": content, "updated": time.time()}
        line = json.dumps(rec, ensure_ascii=False)  # newlines stay escaped: one JSONL line
        off, size = self._c.append_line(line)
        count, head = ring_add(count, head, offsets, off)
        new_line = index_line(count, head, offsets)
        if len(new_line) != INDEX_LINE_W:  # the ring write must never grow the header
            raise ClcError("internal: rebuilt index line changed width")
        self._c.patch(idx_off, new_line.encode("ascii"))
        return {**rec, "offset": off, "size": size}


# ---------------------------------------------------------------------- CLI

def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="clutch-memory",
        description="Save/load/search project memories via the agent server's .clc endpoints.",
    )
    p.add_argument("--endpoint", required=True, help="agent server base URL, e.g. http://127.0.0.1:8899")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("save", help="save (append + repoint the index)")
    sp.add_argument("--title", required=True, help="one-line summary, <=80 chars")
    sp.add_argument("--content", required=True, help="full detail to remember")

    lp = sub.add_parser("load", help="load one memory by exact title")
    lp.add_argument("--title", required=True)

    qp = sub.add_parser("search", help="search titles + content, case-insensitive")
    qp.add_argument("--query", required=True)

    sub.add_parser("list", help="resident titles (short: no contents)")

    args = p.parse_args(argv)
    store = MemoryStore(ClcClient(args.endpoint))
    try:
        if args.cmd == "save":
            _emit(store.save(args.title, args.content))
        elif args.cmd == "load":
            items = store.load_all()
            m = items.get(args.title)
            if m is None:
                _emit({"error": "memory not found", "title": args.title})
                return 1
            _emit(m)
        elif args.cmd == "search":
            q = args.query.lower()
            matches = [m for m in store.load_all().values() if q in m["title"].lower() or q in m["content"].lower()]
            _emit({"query": args.query, "matches": matches})
        else:  # list
            items = store.load_all()
            _emit({"count": len(items), "memories": [{"title": m["title"], "updated": m["updated"]} for m in items.values()]})
    except NotFound:
        _emit({"error": "not found"})
        return 1
    except ClcError as e:
        _emit({"error": str(e)})
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
