#!/usr/bin/env python3
"""Generate the Clutch app icon (pure stdlib) for every platform it ships on:
the red "▣" brand glyph on a #0F0F10 tile.

Desktop — ui/build/, what electron-builder packages:
  icon.png   512x512, 4x supersampled
  icon.svg   the same geometry as vectors
  icon.ico   256px PNG in an .ico container (Windows NSIS)

Android — android/app/src/main/res/, what the launcher draws:
  mipmap-anydpi-v26/ic_launcher.xml        adaptive icon (API 26+): the tile
                                            color under the foreground vector
  mipmap-{mdpi..xxxhdpi}/ic_launcher.png  raster icon for API 24-25, which have
                                            no adaptive icons and mask nothing
  drawable/ic_launcher_foreground.xml      the mark alone
  values/colors.xml                        the tile color the background reads

One set of constants feeds all of them, so the phone's icon cannot drift from the
desktop's.

Usage:
  python3 scripts/make-icon.py            # write every platform's icon
  python3 scripts/make-icon.py --ascii    # print a coarse preview instead
"""

from __future__ import annotations

import argparse
import math
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

# --- Android geometry ------------------------------------------------------
# The launcher's raster buckets (mdpi..xxxhdpi). The adaptive icon is one vector
# for every screen; these are the only per-density files.
LAUNCHER_DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# An adaptive icon is a 108dp canvas the LAUNCHER masks: the outer 18dp on every
# side may be cut away by whatever shape the device draws, so the mark has to live
# in the 72dp that is always visible. Drawing it at the desktop's share of the
# canvas (2*RING_OUTER/W) inside that 72dp is what keeps the two platforms looking
# like one app — and it lands the frame's corners just inside the 66dp a circular
# mask leaves, so a ▣ (unlike a solid square) survives every mask unshaved.
ADAPTIVE_DP = 108
ADAPTIVE_VISIBLE_DP = 72

# The raster icon brings its own shape, as a fraction of the side: API 24-25
# launchers mask nothing, and a rounded tile reads as an app icon where a hard
# square reads as a screenshot.
TILE_CORNER = 0.22


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


def inside_tile(x: float, y: float, radius: float) -> bool:
    """Is sample (x, y) inside the rounded tile of `radius`?

    Signed distance to a rounded rectangle: measure from the four corner-circle
    centers (radius in from each edge), so the straight edges are a plain max()
    and only the corners pay for the hypotenuse. radius <= 0 is the desktop's
    full-bleed tile, where every sample is inside."""
    if radius <= 0:
        return True
    half = W / 2
    qx = abs(x - half) - (half - radius)
    qy = abs(y - half) - (half - radius)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) <= radius


def render(size: int, corner: float = 0.0) -> list[bytes]:
    """Supersampled RGBA scanlines at `size`x`size`.

    corner > 0 rounds the tile by that fraction of the side and leaves everything
    outside it TRANSPARENT: an Android raster icon is never masked, so it has to
    bring its own shape. RGB is averaged over the covered samples only — averaging
    in the transparent ones would drag the edge pixels toward black and leave a
    dark halo along the corners."""
    step = W / size
    radius = corner * W
    shaped = corner > 0
    rows: list[bytes] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = covered = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * step
                    y = (py + (sy + 0.5) / SS) * step
                    if shaped and not inside_tile(x, y, radius):
                        continue
                    cr, cg, cb = color_at(x, y)
                    r += cr
                    g += cg
                    b += cb
                    a += 255
                    covered += 1
            n = SS * SS
            if covered:
                row += bytes((r // covered, g // covered, b // covered, a // n))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png_bytes(rows: list[bytes]) -> bytes:
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
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def write_png(path: Path, rows: list[bytes]) -> None:
    path.write_bytes(png_bytes(rows))


def write_ico(path: Path, size: int = 256) -> None:
    """One size-N PNG (N=256 advertised) wrapped in a minimal .ico (Vista+
    container: PNG bytes embedded verbatim). Windows NSIS needs icon.ico;
    embedding the PNG keeps this stdlib-only (no Pillow). The embedded image
    must MATCH the directory entry's declared size, so it is rendered here."""
    png = png_bytes(render(size))
    icondir = struct.pack("<HHH", 0, 1, 1)  # reserved, type=icon, count=1
    entry = struct.pack(
        "<BBBBHHII",
        size % 256,  # 0 encodes 256
        size % 256,
        0,  # palette colors
        0,  # reserved
        1,  # color planes
        32,  # bits per pixel
        len(png),
        6 + 16,  # ICONDIR + one ICONDIRENTRY
    )
    path.write_bytes(icondir + entry + png)


def write_svg(path: Path) -> None:
    # stroke centered on the ring square: band 88..152 / 360..424
    ring = (
        f'<rect x="120" y="120" width="272" height="272" fill="none" '
        f'stroke="#EF4444" stroke-width="{RING_OUTER - RING_INNER}"/>'
    )
    center = (
        f'<rect x="{256 - CENTER_HALF}" y="{256 - CENTER_HALF}" '
        f'width="{2 * CENTER_HALF}" height="{2 * CENTER_HALF}" fill="#EF4444"/>'
    )
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
        f'  <rect x="0" y="0" width="512" height="512" fill="#0F0F10"/>\n'
        f'  {ring}\n'
        f'  {center}\n'
        "</svg>\n"
    )
    path.write_text(svg, encoding="utf-8")


def hex_rgb(rgb: tuple[int, int, int]) -> str:
    """A color constant in the #AARRGGBB form android:fillColor and <color> take.
    Opaque, like the tile: the platform masks the adaptive icon for us."""
    return "#FF%02X%02X%02X" % rgb


def mark_path_data() -> str:
    """The ▣ mark as ONE path in the 512-unit canvas color_at() draws in: the
    frame clockwise, then its hole counterclockwise, then the solid core. Those
    are the same subpaths drawable/ic_stat_clutch.xml uses at 24 units, scaled to
    512, so the nonZero fill rule VectorDrawable defaults to punches the hole and
    paints the core back in."""
    o, i, c = RING_OUTER, RING_INNER, CENTER_HALF
    return (
        f"M{256 - o},{256 - o} h{2 * o} v{2 * o} h{-2 * o} z "
        f"M{256 - i},{256 - i} v{2 * i} h{2 * i} v{-2 * i} z "
        f"M{256 - c},{256 - c} h{2 * c} v{2 * c} h{-2 * c} z"
    )


def adaptive_scale() -> float:
    """How much of the adaptive canvas the mark takes: the desktop's share.

    The mark spans 2*RING_OUTER of W on the desktop, so on the 108dp canvas it
    must span ADAPTIVE_VISIBLE_DP/ADAPTIVE_DP of it — 72/108, exactly 2/3. That
    makes the mark 47.25dp wide inside the 72dp every mask keeps: the square
    inscribed in Android's 66dp content keyline circle, so a ▣ sits in a circular
    mask the way it sits in its own tile."""
    return ADAPTIVE_VISIBLE_DP / ADAPTIVE_DP


def write_adaptive_foreground(path: Path) -> None:
    """res/drawable/ic_launcher_foreground.xml — the mark alone.

    A group's pivot defaults to 0, so its matrix is translate ∘ scale and the
    translate is what recenters the scaled mark on the canvas."""
    scale = adaptive_scale()
    offset = W * (1 - scale) / 2
    path.write_text(
        f'<?xml version="1.0" encoding="utf-8"?>\n'
        f'<!-- Generated by scripts/make-icon.py; do not edit by hand. The same ▣\n'
        f'     as the desktop icon (ui/build/icon.svg: frame 88..424 of 512, ring\n'
        f'     64 wide, core 144 square), drawn at {scale:.6g} of the 108dp canvas\n'
        f'     so it fills the 72dp every mask keeps visible the way it fills the\n'
        f'     desktop tile. Only the mark lives here: a launcher on API 26+ draws\n'
        f'     the tile color behind it and applies its own mask on top. -->\n'
        f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        f'    android:width="{ADAPTIVE_DP}dp"\n'
        f'    android:height="{ADAPTIVE_DP}dp"\n'
        f'    android:viewportWidth="{W}"\n'
        f'    android:viewportHeight="{W}">\n'
        f'    <group\n'
        f'        android:scaleX="{scale:.6f}"\n'
        f'        android:scaleY="{scale:.6f}"\n'
        f'        android:translateX="{offset:.6f}"\n'
        f'        android:translateY="{offset:.6f}">\n'
        f'        <path\n'
        f'            android:fillColor="{hex_rgb(RED)}"\n'
        f'            android:pathData="{mark_path_data()}" />\n'
        f'    </group>\n'
        f'</vector>\n',
        encoding="utf-8",
    )


def write_adaptive_icon(path: Path) -> None:
    """res/mipmap-anydpi-v26/ic_launcher.xml — the adaptive icon.

    API 26+ never reads a raster: it composites this, then masks the result. The
    background is the flat tile color rather than a drawable so the area the mask
    cuts away is the tile, not a transparent hole."""
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Generated by scripts/make-icon.py. Read on API 26+, which masks the\n'
        '     composite itself; mipmap-<density>/ic_launcher.png is the same icon\n'
        '     shaped by us, for API 24-25, which have no adaptive icons. -->\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n',
        encoding="utf-8",
    )


def write_colors(path: Path) -> None:
    """res/values/colors.xml — the tile color the adaptive background reads.
    Generated so it cannot drift from the BG the rasters are painted with."""
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Generated by scripts/make-icon.py: the tile color, the same\n'
        '     #0F0F10 the desktop icon paints its background with. -->\n'
        '<resources>\n'
        f'    <color name="ic_launcher_background">{hex_rgb(BG)}</color>\n'
        '</resources>\n',
        encoding="utf-8",
    )


def write_android(root: Path) -> list[tuple[Path, str]]:
    """The launcher icon, under android/app/src/main/res/.

    Two shapes, because the platform changed: the vector adaptive icon (API 26+,
    masked by the launcher) and one rounded-tile raster per density (API 24-25,
    masked by nobody, so the tile in ic_launcher.png brings its own corners).
    Returns [(path, note)] for main() to report."""
    res = root / "android" / "app" / "src" / "main" / "res"
    for sub in ("drawable", "mipmap-anydpi-v26", "values"):
        (res / sub).mkdir(parents=True, exist_ok=True)
    foreground = res / "drawable" / "ic_launcher_foreground.xml"
    adaptive = res / "mipmap-anydpi-v26" / "ic_launcher.xml"
    colors = res / "values" / "colors.xml"
    write_adaptive_foreground(foreground)
    write_adaptive_icon(adaptive)
    write_colors(colors)
    written = [
        (foreground, f"the mark alone, on a {ADAPTIVE_DP}dp canvas"),
        (adaptive, "adaptive icon, API 26+"),
        (colors, f"the tile color {hex_rgb(BG)}"),
    ]
    for bucket, px in LAUNCHER_DENSITIES.items():
        (res / f"mipmap-{bucket}").mkdir(parents=True, exist_ok=True)
        out = res / f"mipmap-{bucket}" / "ic_launcher.png"
        write_png(out, render(px, corner=TILE_CORNER))
        written.append((out, f"{px}px, the API 24-25 fallback"))
    return written


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
    write_ico(out_dir / "icon.ico")
    written: list[tuple[Path, str]] = [
        (out_dir / "icon.png", f"{W}x{W}, {SS}x supersampled"),
        (out_dir / "icon.svg", "the same geometry as vectors"),
        (out_dir / "icon.ico", "256px PNG in an .ico container (Windows NSIS)"),
        *write_android(root),
    ]
    for path, note in written:
        print(f"icon written: {path.relative_to(root)}  ({note})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
