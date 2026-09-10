#!/usr/bin/env python3
"""Build ui/vendor/fonts/clutch-icons.woff2 — the UI's cross-platform icon font.

Why this exists: the UI draws its chrome icons with Unicode symbol glyphs
(▣ ▦ ＋ ⚙ ▶ ▸ ▾ ↓ → ✓ ↶ ✎ ⚠ ⟦ ⟧ ■). None of them are in the bundled Archivo /
JetBrains Mono (both are ~230-glyph latin subsets), so each platform resolved
them from ITS OWN symbol font — Segoe UI Symbol on Windows, Apple Symbols on
macOS, whatever fontconfig picks on Linux — which is why buttons and carets
were a different size/shape on every OS. This script bakes those 16 codepoints
into one small font the app ships, so every platform draws identical icons.

Source: Symbola (George Douros), "fonts are free for any use; they may be
opened, edited, modified, regenerated, packaged and redistributed" — vendored
from the Debian package fonts-symbola 2.60-1.1 (checksum pinned below). Survey
(fontTools cmap; table in ui/vendor/fonts/README.md): Symbola 15/16 native and
DejaVu Sans 15/16 native, and BOTH lack U+FF0B, so either needs the ASCII "+"
remap below; the tie went to Symbola for its zero-condition licence and because
it is a symbol-only face (DejaVu Sans is the platforms' own text font, so a
subset of it would be indistinguishable from the OS fallback it replaces).
Others: Noto Sans Symbols 2 9/16, Noto Sans Symbols 3/16, the vendored Archivo /
JetBrains Mono 1/16.

The subset keeps EXACTLY the 16 codepoints used by ui/ and nothing else, so it
can sit first in --font-display / --font-mono without ever shadowing a normal
character. Symbola has no U+FF0B (fullwidth plus), so its ASCII "+" outline is
remapped to U+FF0B — the markup keeps using ＋ and ASCII "+" still comes from
Archivo/JetBrains Mono.

Run (deps are injected, the venv stays clean):
    uv run --with fonttools --with brotli python3 scripts/build-icon-font.py
Checks that read the result: tests/ui_fonts_check.py
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FONT = ROOT / "ui" / "vendor" / "fonts" / "clutch-icons.woff2"
OUT_LICENSE = ROOT / "ui" / "vendor" / "fonts" / "clutch-icons.LICENSE.txt"
# The manifest records which codepoints the built font contains, keyed to its
# sha256. tests/ui_fonts_check.py reads it (it must stay dependency-free, and
# decoding a woff2 cmap would need brotli + fontTools) to prove the shipped
# font still covers every symbol ui/ draws.
OUT_MANIFEST = ROOT / "ui" / "vendor" / "fonts" / "clutch-icons.manifest.txt"

# Debian/Ubuntu ship Symbola inside the source package "ttf-ancient-fonts"
# (hence the t/ pool directory); any mirror of the same version works — the
# download is accepted only when the sha256 matches, so a stale/changed mirror
# fails loudly instead of silently baking a different font.
SOURCE_DEB = "http://mirrors.tuna.tsinghua.edu.cn/ubuntu/pool/universe/t/ttf-ancient-fonts/fonts-symbola_2.60-1.1_all.deb"
SOURCE_DEB_FALLBACKS = (
    "http://archive.ubuntu.com/ubuntu/pool/universe/t/ttf-ancient-fonts/fonts-symbola_2.60-1.1_all.deb",
    "http://mirrors.kernel.org/ubuntu/pool/universe/t/ttf-ancient-fonts/fonts-symbola_2.60-1.1_all.deb",
)
SOURCE_SHA256 = "c0ded2d56a594ff290e0bd9edd8fd7ddf72b2c85af4c8e4833557c19ee414585"
SOURCE_MEMBER = "usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf"

# every symbol glyph the UI draws, and the family name the CSS declares
ICON_FONT_NAME = "Clutch Icons"
ICONS = {
    0x25B8: "▸ stream/tree caret-right",
    0x2193: "↓ scroll/older-pill down arrow",
    0x2713: "✓ check (diff/selected)",
    0xFF0B: "＋ new (from the ASCII plus outline)",
    0x2192: "→ inline arrow",
    0x25BE: "▾ tree caret-down",
    0x25B6: "▶ run button",
    0x21B6: "↶ revert/undo",
    0x25A0: "■ stop button",
    0x26A0: "⚠ warning",
    0x27E6: "⟦ tool-args bracket open",
    0x27E7: "⟧ tool-args bracket close",
    0x25A3: "▣ Clutch logo",
    0x270E: "✎ edit marker",
    0x25A6: "▦ open button",
    0x2699: "⚙ settings button",
}
PLUS_SOURCE = 0x002B  # Symbola's ASCII "+", remapped onto U+FF0B

# fontTools bumps head.modified to "now" on save, which would make every rebuild
# of the same source produce different bytes (and a bogus git diff). Pin it —
# reproducible-builds style: 2025-01-01T00:00:00Z, overridable via SOURCE_DATE_EPOCH.
# head dates are seconds since the 1904 Mac epoch, so add that offset explicitly
# (otherwise fontTools' "timestamp seems very low" heuristic kicks in).
MAC_EPOCH_OFFSET = 2082844800  # 1904-01-01 → 1970-01-01
BUILD_EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH", 1735689600)) + MAC_EPOCH_OFFSET

LICENSE_TEXT = f"""clutch-icons.woff2 — a 16-glyph subset of Symbola

Source: Symbola, Copyright (C) 2007-2015 George Douros <g1951d@teilar.gr>
        (Debian package fonts-symbola 2.60-1.1, {SOURCE_DEB})
License: "Fonts are free for any use; they may be opened, edited, modified,
          regenerated, packaged and redistributed."
Subset: the {len(ICONS)} symbol codepoints listed in scripts/build-icon-font.py; the
        font was renamed to "{ICON_FONT_NAME}" and its ASCII "+" outline remapped
        to U+FF0B. Rebuild with: uv run --with fonttools --with brotli python3 scripts/build-icon-font.py
"""


def fetch_source(local: str | None = None) -> bytes:
    """Return the Symbola ttf bytes: from a local .deb/.ttf when given, else the
    pinned download (checksum verified, mirror fallbacks)."""
    if local:
        blob = Path(local).read_bytes()
        return blob if local.endswith(".ttf") else extract_ttf(blob)
    last: Exception | None = None
    for url in (SOURCE_DEB, *SOURCE_DEB_FALLBACKS):
        print(f"fetching {url}")
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                deb = r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  failed: {type(e).__name__}: {e}")
            continue
        got = hashlib.sha256(deb).hexdigest()
        if got != SOURCE_SHA256:
            last = SystemExit(f"checksum mismatch from {url}: expected {SOURCE_SHA256}, got {got}")
            print(f"  {last}")
            continue
        return extract_ttf(deb)
    sys.exit(f"could not fetch the source font ({last}); pass a local copy with --source")


def extract_ttf(deb: bytes) -> bytes:
    # a .deb is an `ar` archive holding debian-binary + control.tar.* + data.tar.*
    if deb[:8] != b"!<arch>\n":
        sys.exit("not an ar archive")
    off, data = 8, None
    while off + 60 <= len(deb):
        hdr = deb[off : off + 60]
        name = hdr[:16].decode().strip()
        size = int(hdr[48:58].decode().strip())
        body = deb[off + 60 : off + 60 + size]
        if name.startswith("data.tar"):
            data = body
            break
        off += 60 + size + (size % 2)
    if data is None:
        sys.exit("no data.tar in the deb")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
        member = tf.extractfile("./" + SOURCE_MEMBER) or tf.extractfile(SOURCE_MEMBER)
        if member is None:
            sys.exit(f"{SOURCE_MEMBER} not in the deb")
        return member.read()


def build(ttf: bytes) -> tuple[bytes, list[str]]:
    from fontTools.subset import Options, Subsetter
    from fontTools.ttLib import TTFont

    font = TTFont(io.BytesIO(ttf), fontNumber=0)
    src_cmap = font.getBestCmap()
    missing = [cp for cp in ICONS if cp not in src_cmap and cp != 0xFF0B]
    if missing:
        sys.exit(f"source font lacks {[hex(c) for c in missing]}")
    remap_plus = 0xFF0B not in src_cmap
    if remap_plus and PLUS_SOURCE not in src_cmap:
        sys.exit(f"source font lacks U+{PLUS_SOURCE:04X} '+' to stand in for U+FF0B")

    opts = Options()
    opts.layout_features = []  # no GSUB/GPOS needed for single glyphs
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.recalc_bounds = True
    opts.glyph_names = True
    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=[cp for cp in ICONS if cp in src_cmap] + ([PLUS_SOURCE] if remap_plus else []))
    subsetter.subset(font)

    # Symbola has no fullwidth plus: remap its ASCII "+" outline onto U+FF0B and
    # drop U+002B so the icon font never shadows the text "+".
    if remap_plus:
        cmap = font.getBestCmap()
        plus_glyph = cmap[PLUS_SOURCE]
        for table in font["cmap"].tables:
            if not table.isUnicode():
                continue
            table.cmap.pop(PLUS_SOURCE, None)
            table.cmap[0xFF0B] = plus_glyph

    # rename so the CSS family, the font's own name and any OS font picker agree
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16, 17):
            value = ICON_FONT_NAME if rec.nameID in (1, 4, 6, 16) else "Regular"
            name.setName(value, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    font["OS/2"].usWeightClass = 400
    font["OS/2"].fsType = 0  # installable embedding: the subset is redistributable
    font.recalcTimestamp = False  # keep head.modified at BUILD_EPOCH (reproducible)
    font["head"].modified = BUILD_EPOCH

    have = sorted(font.getBestCmap())
    expected = sorted(ICONS)
    if have != expected:
        sys.exit(f"subset cmap mismatch: {[hex(c) for c in have]}")
    print(f"subset: {len(have)} codepoints, {len(font.getGlyphOrder())} glyphs (incl. .notdef)")

    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), [f"U+{cp:04X} {ICONS[cp]}" for cp in expected]


def main() -> int:
    local = None
    if "--source" in sys.argv:
        local = sys.argv[sys.argv.index("--source") + 1]
    ttf = fetch_source(local)
    woff2, table = build(ttf)
    OUT_FONT.parent.mkdir(parents=True, exist_ok=True)
    OUT_FONT.write_bytes(woff2)
    OUT_LICENSE.write_text(LICENSE_TEXT, encoding="utf-8")
    OUT_MANIFEST.write_text(
        "# clutch-icons.woff2 contents — written by scripts/build-icon-font.py, checked by tests/ui_fonts_check.py\n"
        f"font: {OUT_FONT.name}\n"
        f"sha256: {hashlib.sha256(woff2).hexdigest()}\n" + "".join(f"U+{cp:04X}\n" for cp in sorted(ICONS)),
        encoding="utf-8",
    )
    print(
        f"\nwrote {OUT_FONT.relative_to(ROOT)} ({len(woff2):,} B), "
        f"{OUT_MANIFEST.relative_to(ROOT)}, {OUT_LICENSE.relative_to(ROOT)}"
    )
    for line in table:
        print("   ", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
