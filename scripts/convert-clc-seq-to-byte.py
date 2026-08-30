"""Migrate old .clc files to the byte-addressed tail_start format.

Pre-byte-addressing files (before commit 90616dc) store CompactionEvent.
tail_start as a DURABLE EVENT ORDINAL; the byte-addressed reader interprets it
as a byte offset relative to the event region (the raw task's line start). This
tool rewrites every compaction line's tail_start to the byte offset of the
ordinal's durable line in the FINAL file layout.

The ordinal is read ONCE from the original file and held fixed; the layout's
durable offsets are re-measured after each rewrite (a compaction line whose new
value is longer than the old one shifts later lines). Rewrites iterate until the
layout stops changing, then the written values are byte-exact. Lines that shrink
are padded with trailing spaces so most rewrites converge in one pass.

Usage: uv run python scripts/convert-clc-seq-to-byte.py [file.clc ...]
       (default: every *.clc in the workspace root)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from agent.events import DURABLE_TYPES

WORKSPACE = Path(__file__).resolve().parent.parent
MAX_ITER = 12


def scan(path: Path) -> tuple[int, list[int]]:
    """Return (event_region_base, durable_offsets_rel).

    durable_offsets_rel[k] = the k-th durable line's start offset relative to
    the event region (k = the durable ordinal the old tail_start used).
    """
    raw = path.read_bytes()
    base: int | None = None
    durable_offsets: list[int] = []
    pos = 0
    for seg in raw.split(b"\n"):
        abs_start = pos
        pos += len(seg) + 1
        stripped = seg.strip()
        if not stripped:
            continue
        try:
            data = json.loads(seg.decode("utf-8", "replace"))
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict) or data.get("type") not in DURABLE_TYPES:
            continue
        if base is None:
            base = abs_start  # the raw task: event region start (relative 0)
            durable_offsets.append(0)
            continue
        durable_offsets.append(abs_start - base)
    return base or 0, durable_offsets


def rewrite(path: Path, values: list[int]) -> int:
    """Rewrite the compaction lines (in FILE ORDER) with new tail_start values,
    padding each line with trailing spaces to keep its byte length when
    possible. Matching by position — not by absolute offset — stays correct
    even when an earlier line's length change shifts later lines. Returns the
    number of lines whose byte length changed (drives the convergence loop)."""
    raw = path.read_bytes()
    out: list[bytes] = []
    comp_idx = 0
    length_changed = 0
    for seg in raw.split(b"\n"):
        stripped = seg.strip()
        is_comp = False
        if stripped:
            try:
                data = json.loads(seg.decode("utf-8", "replace"))
                is_comp = isinstance(data, dict) and data.get("type") == "compaction"
            except (ValueError, TypeError, json.JSONDecodeError):
                pass
        if is_comp and comp_idx < len(values):
            data["tail_start"] = values[comp_idx]
            comp_idx += 1
            new_line = json.dumps(data, ensure_ascii=False)
            nb = new_line.encode("utf-8")
            if len(nb) <= len(seg):
                new_line += " " * (len(seg) - len(nb))  # pad: keep the line's bytes
                nb = new_line.encode("utf-8")
            else:
                length_changed += 1  # value outgrew the line: iterate to converge
            out.append(nb)
        else:
            out.append(seg)
    path.write_bytes(b"\n".join(out) + b"\n")
    return length_changed


def convert(path: Path) -> dict:
    raw = path.read_bytes()
    base, _offsets0 = scan(path)
    # read each compaction's ORIGINAL ordinal exactly once (fixed through the loop)
    ordinals: list[int] = []
    rels: list[int] = []
    pos = 0
    for seg in raw.split(b"\n"):
        abs_start = pos
        pos += len(seg) + 1
        stripped = seg.strip()
        if not stripped:
            continue
        try:
            data = json.loads(seg.decode("utf-8", "replace"))
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("type") == "compaction":
            ordinals.append(int(data.get("tail_start", 0) or 0))
            rels.append(abs_start - base)
    if not ordinals:
        return {"file": str(path), "compactions": 0, "note": "no compaction events"}

    converged = False
    for _ in range(MAX_ITER):
        _b, offsets = scan(path)
        values = [
            offsets[o] if 0 <= o < len(offsets) else rels[k]
            for k, o in enumerate(ordinals)
        ]
        changed = rewrite(path, values)
        if changed == 0:
            converged = True
            break
    return {
        "file": str(path),
        "compactions": len(ordinals),
        "ordinals": ordinals,
        "converged": converged,
    }


def main() -> None:
    args = sys.argv[1:]
    files = [Path(a) for a in args] if args else sorted(WORKSPACE.glob("*.clc"))
    for f in files:
        if not f.is_file():
            print(f"skip (missing): {f}")
            continue
        print(f"converting {f.name} ...")
        print("  ", convert(f))


if __name__ == "__main__":
    main()
