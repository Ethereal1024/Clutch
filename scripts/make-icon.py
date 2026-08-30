#!/usr/bin/env python3
"""Generate the Clutch app icon — pure stdlib, zero image dependencies.

Renders the brand mark (a red "▣" glyph from the UI, which uses `--accent`
#EF4444 on the swiss-dark tile #0F0F10) into:
  ui/build/icon.png   512x512, 4x supersampled for anti-aliased edges
  ui/build/icon.svg   same geometry, hand-edit free (single source of truth)

Usage:
  python3 scripts/make-icon.py            # write both files
  python3 scripts/make-icon.py --ascii    # print a coarse preview instead

Geometry (canvas 512, origin top-left, glyph centered at 256,256):
  tile   : full-bleed #0F0F10 square (sharp corners — the brand is "swiss dark")
  ring   : square outline, visual band 88..152 and 360..424 (thickness 64)
  center : filled #EF4444 square 184..328 (144x144)
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

W = 512
SS = 4  # supersample factor: SS*SS samples per output pixel

BG = (15, 15, 16)      # #0F0F10 --bg
RED = (239, 68, 68)    # #EF4444 --accent

# glyph geometry in canvas units, centered on 256
RING_OUTER = 168   # |dx| <= 168 -> outer square edges at 88 and 424
RING_INNER = 104   # |dx| <= 104 -> ring hole (ring thickness = 64)
CENTER_HALF = 72   # |dx| <= 72  -> center square 184..328


def color_at(x: float, y: float) -> tuple[int, int, int]:
    """Color of one sample point (all opaque — the tile is full-bleed)."""
    dx, dy = abs(x - 256), abs(y - 256)
    in_outer = dx <= RING_OUTER and dy <= RING_OUTER
    in_ring_hole = dx <= RING_INNER and dy <= RING_INNER
    if in_outer and not in_ring_hole:
        return RED
    if dx <= CENTER_HALF and dy <= CENTER_HALF:
        return RED
    return BG


def render(size: int) -> list[bytes]:
    """Supersampled RGBA scanlines at `size`x`size`."""
    step = W / size
    rows: list[bytes] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * step
                    y = (py + (sy + 0.5) / SS) * step
                    cr, cg, cb = color_at(x, y)
                    r += cr
                    g += cg
                    b += cb
                    a += 255
            n = SS * SS
            row += bytes((r // n, g // n, b // n, a // n))
        rows.append(bytes(row))
    return rows


def write_png(path: Path, rows: list[bytes]) -> None:
    def chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    h = len(rows)
    w = len(rows[0]) // 4
    raw = b"".join(b"\x00" + r for r in rows)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def write_svg(path: Path) -> None:
    # stroke centered on the ring square: visual band 88..152 / 360..424
    # (thickness = RING_OUTER - RING_INNER), so the rect edge sits at
    # 88 + thickness/2 = 120 and the rect spans 120..392 (width 272)
    ring = f'<rect x="120" y="120" width="272" height="272" fill="none" stroke="#EF4444" stroke-width="{RING_OUTER - RING_INNER}"/>'
    center = f'<rect x="{256 - CENTER_HALF}" y="{256 - CENTER_HALF}" width="{2 * CENTER_HALF}" height="{2 * CENTER_HALF}" fill="#EF4444"/>'
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
        f'  <rect x="0" y="0" width="512" height="512" fill="#0F0F10"/>\n'
        f'  {ring}\n'
        f'  {center}\n'
        "</svg>\n"
    )
    path.write_text(svg, encoding="utf-8")


def ascii_preview(size: int = 48) -> None:
    rows = render(size)
    glyphs = " .:-=+*#%@"
    for row in rows:
        line = []
        for i in range(0, len(row), 4):
            r, g, b = row[i], row[i + 1], row[i + 2]
            lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            line.append(glyphs[min(int(lum * len(glyphs)), len(glyphs) - 1)])
        print("".join(line))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ascii", action="store_true", help="print a preview and exit")
    args = ap.parse_args()

    if args.ascii:
        ascii_preview()
        return 0

    root = Path(__file__).resolve().parent.parent
    out_dir = root / "ui" / "build"
    out_dir.mkdir(parents=True, exist_ok=True)
    write_png(out_dir / "icon.png", render(W))
    write_svg(out_dir / "icon.svg")
    print(f"icon written: {out_dir / 'icon.png'} ({W}x{W})")
    print(f"icon written: {out_dir / 'icon.svg'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
