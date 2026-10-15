"""Launcher icon wiring: the APK's icon must exist, be shaped right, and be the
generator's output.

User report (Chinese): "移动端目前还没有图标" — the phone installed Clutch and the
app drawer showed the default Android head. `aapt2 dump badging` on 0.1.44 said
`application: label='Clutch' icon=''`: AndroidManifest.xml's <application> never
declared android:icon, and res/ held no mipmap at all, so the platform fell back
to its own placeholder. Nothing failed — the build, the install and the CI were
all green.

Checks (stdlib only, on purpose: the android-apk CI job has no .venv, so this
cannot import tests.testsupport, which pulls repo deps):
  1. AndroidManifest.xml declares android:icon=@mipmap/ic_launcher and no
     android:roundIcon (android/README.md: the launcher masks the adaptive icon
     itself, so a second raster set has nothing to do on API 26+)
  2. every resource XML under res/ parses — an XML comment may not contain a
     double hyphen, which is exactly how the first version of the generated
     colors.xml came out
  3. mipmap-anydpi-v26/ic_launcher.xml is an <adaptive-icon> whose background and
     foreground references RESOLVE, whose background is the generator's tile
     color, and whose foreground is a 108dp vector carrying the mark at the
     generator's scale, with the frame's corners clear of the edge any mask may
     crop to — the numbers the launcher will actually draw with. User report
     (Chinese): "考虑到安卓图标有圆角，应该适当缩小icon中的红色主体，不然主体四角正好顶
     住圆角边缘" — the corners of the ▣ reached within 2.6dp of the inscribed circle.
  4. the API 24-25 rasters exist at all five launcher densities, are RGBA of the
     right size, have transparent rounded corners and the tile's color, carry the
     red mark at the adaptive icon's inset (so the icon is the same size on API
     24-25 as on 26+), and contain no pixel darker than the tile (a halo along the
     corner arc is what bad alpha/coverage handling leaves behind)
  5. every committed icon file — desktop raster/SVG/ICO and all five Android
     rasters — is byte-identical to a fresh in-process render of
     scripts/make-icon.py, so the phone cannot drift from the desktop and a
     hand-edited resource cannot survive a release

Run: python3 -m tests.android_icon_check
"""

from __future__ import annotations

import importlib.util
import math
import struct
import tempfile
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "android" / "app" / "src" / "main"
RES = MAIN / "res"
MANIFEST = MAIN / "AndroidManifest.xml"
GENERATOR = ROOT / "scripts" / "make-icon.py"
DESKTOP = ROOT / "ui" / "build"
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"

# tests/testsupport.py's collecting_check(), inlined: importing it would drag the
# repo's dependencies into a job that deliberately installs none of them.
failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(f"  {'ok:  ' if cond else 'FAIL: '}{label}")
    if not cond:
        failures.append(label)


def load_generator():
    """scripts/make-icon.py as a module: it is a script with a hyphen in its name,
    so it needs spec_from_file_location rather than a plain import."""
    spec = importlib.util.spec_from_file_location("make_icon", GENERATOR)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def png_rgba(path: Path) -> tuple[int, int, list[bytes]]:
    """Decode the RGBA scanlines of the PNGs scripts/make-icon.py writes.

    Deliberately a decoder and not Pillow: this runs in the android-apk CI job,
    which installs no Python packages. The generator writes 8-bit RGBA,
    non-interlaced, filter 0 on every row, which keeps the decoder this short."""
    label = f"{path.parent.name}/{path.name}"
    data = path.read_bytes()
    check(data[:8] == b"\x89PNG\r\n\x1a\n", f"{label}: is a PNG")
    pos, idat, ihdr = 8, b"", None
    while pos + 12 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        typ, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        if typ == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif typ == b"IDAT":
            idat += body
        pos += 12 + length
    check(ihdr is not None, f"{label}: has an IHDR")
    if ihdr is None:
        return 0, 0, []
    width, height, depth, ctype, comp, filt, interlace = ihdr
    check((depth, ctype, comp, filt, interlace) == (8, 6, 0, 0, 0),
          f"{label}: 8-bit RGBA, non-interlaced (IHDR {ihdr})")
    raw = zlib.decompress(idat)
    stride = width * 4
    if height:
        check(raw[0] == 0, f"{label}: rows use filter 0")
    rows = [raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)] for y in range(height)]
    return width, height, rows


def pixel(rows: list[bytes], x: int, y: int) -> tuple[int, int, int, int]:
    o = x * 4
    r, g, b, a = rows[y][o:o + 4]
    return r, g, b, a


def darker_than(p: tuple[int, int, int, int], floor_rgb: tuple[int, int, int]) -> bool:
    """Is this visible pixel darker than the tile? Averaging the transparent
    samples into the mean as black is what leaves exactly that along the arc."""
    return p[3] > 0 and any(p[i] < floor_rgb[i] for i in range(3))


def red_extent(row: bytes, px: int) -> int:
    """Width in pixels of the red mark across one scanline.

    A pixel counts as red when it is predominantly the accent rather than the
    tile; pixel spans are a little fuzzier than geometry because the edge pixels
    are averaged over their covered samples, which is why callers allow ±2px."""
    reds = [x for x in range(px) if row[x * 4] > 150 and row[x * 4 + 1] < 120]
    return reds[-1] - reds[0] + 1 if reds else 0


def check_manifest() -> None:
    root = ET.parse(MANIFEST).getroot()
    app = root.find("application")
    check(app is not None, "AndroidManifest.xml has an <application>")
    if app is None:
        return
    icon = app.get(ANDROID_NS + "icon")
    check(icon == "@mipmap/ic_launcher",
          f"android:icon is @mipmap/ic_launcher (found {icon!r}) — without it the "
          "launcher draws its own placeholder and nothing else notices")
    check(app.get(ANDROID_NS + "roundIcon") is None,
          "no android:roundIcon (the launcher masks the adaptive icon on API 26+, "
          "so only a second raster set would come of it)")


def check_resource_xml() -> dict[str, ET.Element]:
    """Parse every resource XML and index it by the reference the manifest and the
    adaptive icon use (@color/name, @drawable/name, @mipmap/name)."""
    roots: dict[str, ET.Element] = {}
    for path in sorted(RES.rglob("*.xml")):
        rel = path.relative_to(RES)
        try:
            tree = ET.parse(path)
        except ET.ParseError as exc:
            check(False, f"{rel}: parses as XML ({exc}) — a double hyphen inside a "
                         "comment is not legal XML")
            continue
        check(True, f"{rel}: parses as XML")
        if path.parent.name == "values":
            for child in tree.getroot():
                tag = child.tag.lower()
                name = child.get("name")
                if name is not None:
                    roots[f"@{tag}/{name}"] = child
                    check(True, f"{rel}: defines @{tag}/{name}")
        elif "mipmap" in path.parent.name or path.parent.name == "drawable":
            kind = "mipmap" if "mipmap" in path.parent.name else "drawable"
            roots[f"@{kind}/{path.stem}"] = tree.getroot()
    return roots


def check_adaptive(gen, roots: dict[str, ET.Element]) -> None:
    icon = roots.get("@mipmap/ic_launcher")
    check(icon is not None, "@mipmap/ic_launcher is defined for API 26+ "
                           "(mipmap-anydpi-v26/ic_launcher.xml)")
    if icon is None:
        return
    check(icon.tag == "adaptive-icon", f"it is an <adaptive-icon> (found <{icon.tag}>)")

    background = icon.find("background")
    foreground = icon.find("foreground")
    check(background is not None and foreground is not None,
          "<adaptive-icon> has a <background> and a <foreground>")
    if background is None or foreground is None:
        return

    bg_ref = background.get(ANDROID_NS + "drawable") or ""
    fg_ref = foreground.get(ANDROID_NS + "drawable") or ""
    check(bg_ref.startswith("@color/") and bg_ref in roots,
          f"the background reference resolves ({bg_ref})")
    check(fg_ref.startswith("@drawable/") and fg_ref in roots,
          f"the foreground reference resolves ({fg_ref})")

    color = roots.get(bg_ref)
    if color is not None:
        check(color.text is not None and color.text.strip() == gen.hex_rgb(gen.BG),
              f"{bg_ref} is the generator's tile color {gen.hex_rgb(gen.BG)} "
              f"(found {color.text and color.text.strip()!r}) — a transparent "
              "background would show through wherever the mask is not full-bleed")

    vector = roots.get(fg_ref)
    if vector is None:
        return
    check(vector.tag == "vector", f"{fg_ref} is a <vector> (found <{vector.tag}>)")
    size = (vector.get(ANDROID_NS + "width"), vector.get(ANDROID_NS + "height"))
    check(size == (f"{gen.ADAPTIVE_DP}dp", f"{gen.ADAPTIVE_DP}dp"),
          f"the foreground canvas is {gen.ADAPTIVE_DP}dp square (found {size}) — the "
          "size the launcher masks; a 72dp one would be zoomed and clipped")
    viewport = (vector.get(ANDROID_NS + "viewportWidth"), vector.get(ANDROID_NS + "viewportHeight"))
    check(viewport == (str(gen.W), str(gen.W)),
          f"it draws in the generator's {gen.W}-unit geometry (viewport {viewport})")

    group = vector.find("group")
    check(group is not None, "the mark is drawn by a <group> (so it can be scaled)")
    if group is None:
        return
    # path is INSIDE the group: ElementTree.find reads direct children only
    path = group.find("path")
    check(path is not None, "the <group> holds one <path>: the mark")
    if path is None:
        return
    scale = gen.adaptive_mark_scale()
    offset = gen.W * (1 - scale) / 2
    got = (group.get(ANDROID_NS + "scaleX"), group.get(ANDROID_NS + "translateX"))
    check(all(v is not None for v in got), "the group scales and translates the mark")
    if all(v is not None for v in got):
        share = 2 * gen.RING_OUTER * scale / gen.W * gen.ADAPTIVE_DP / gen.ADAPTIVE_VISIBLE_DP
        check(abs(float(got[0]) - scale) < 1e-5 and abs(float(got[1]) - offset) < 1e-5,
              f"the group is scale {scale:.6f} / translate {offset:.6f} (found "
              f"{float(got[0]):.6f} / {float(got[1]):.6f}): the desktop's share of the "
              f"canvas inset by ANDROID_MARK_SCALE, {share * 100:.1f}% of the "
              f"{gen.ADAPTIVE_VISIBLE_DP}dp every mask keeps")
        # The reported bug, as arithmetic: a mask may crop anywhere inside the
        # visible box, and the tightest one is the full-bleed circle inscribed in
        # it. The mark's furthest point is a ▣ frame corner, RING_OUTER*sqrt(2)
        # from the center — it has to sit inside the 66dp content keyline with
        # room to spare, not just inside the mask.
        mask_radius = gen.ADAPTIVE_VISIBLE_DP / 2
        keyline_radius = mask_radius - 3
        corner_radius = gen.RING_OUTER * math.sqrt(2) * scale / gen.W * gen.ADAPTIVE_DP
        check(corner_radius <= keyline_radius,
              f"the mark's corners stay inside the {2 * keyline_radius:g}dp content "
              f"keyline ({corner_radius:.1f}dp from the center, was 33.4dp before "
              "ANDROID_MARK_SCALE)")
        check(mask_radius - corner_radius >= 6.0,
              f"{mask_radius - corner_radius:.1f}dp of daylight to the "
              f"{2 * mask_radius:g}dp circular mask (report: 'the four corners of the "
              "red mark sit right on the rounded edge'); was 2.6dp")
    check(path.get(ANDROID_NS + "pathData") == gen.mark_path_data(),
          "the path is the generator's mark, subpath for subpath")
    check(path.get(ANDROID_NS + "fillColor") == gen.hex_rgb(gen.RED),
          f"the mark carries the accent {gen.hex_rgb(gen.RED)}")


def check_rasters(gen) -> None:
    for bucket, px in gen.LAUNCHER_DENSITIES.items():
        path = RES / f"mipmap-{bucket}" / "ic_launcher.png"
        check(path.is_file(), f"mipmap-{bucket}/ic_launcher.png exists (API 24-25 "
                              "has no adaptive icons and needs this raster)")
        if not path.is_file():
            continue
        width, height, rows = png_rgba(path)
        check((width, height) == (px, px),
              f"{bucket}: a {px}x{px} 8-bit RGBA raster (found {width}x{height})")
        if not rows:
            continue
        corners = {pixel(rows, x, y) for x, y in ((0, 0), (px - 1, 0), (0, px - 1), (px - 1, px - 1))}
        check(corners == {(0, 0, 0, 0)},
              f"{bucket}: the rounded tile's corners are transparent (found {sorted(corners)}) "
              "— no launcher masks these, so the tile brings its own shape")
        center = pixel(rows, px // 2, px // 2)
        check(center == (*gen.RED, 255), f"{bucket}: the core is the accent (found {center})")
        edge = pixel(rows, 0, px // 2)
        check(edge == (*gen.BG, 255), f"{bucket}: the tile's sides are the tile color (found {edge})")
        # The middle scanline crosses the mark's widest point (the ▣ frame's side),
        # so the extent of the red on it IS the mark's width — and the report's fix
        # is that this width is the adaptive icon's inset, not the desktop's share.
        width = red_extent(rows[px // 2], px)
        want = 2 * gen.RING_OUTER * gen.ANDROID_MARK_SCALE / gen.W * px
        full = 2 * gen.RING_OUTER / gen.W * px
        check(abs(width - want) <= 2,
              f"{bucket}: the mark is {width}px wide ({want:.1f}px expected) — the inset "
              "the adaptive icon draws, so the icon does not grow between API 24-25 "
              "and 26+")
        check(width < full,
              f"{bucket}: narrower than the desktop's share of the canvas ({width}px < "
              f"{full:.1f}px) — the reported 'the four corners sit right on the "
              "rounded edge'")
        opaque = sum(1 for y in range(px) for x in range(px) if pixel(rows, x, y)[3] == 255)
        check(opaque > px * px // 2,
              f"{bucket}: {opaque} of {px * px} pixels are opaque (a raster that came out "
              "empty or translucent would ship a blank icon)")
        # RGB is averaged over COVERED samples only. Averaging the transparent ones
        # in as black would leave every partially covered corner-arc pixel darker
        # than the tile, i.e. a dark halo around the icon.
        dark = [(x, y) for y in range(px) for x in range(px)
                if darker_than(pixel(rows, x, y), gen.BG)]
        check(not dark, f"{bucket}: no partially covered pixel is darker than the tile "
                        f"(halo at {dark[:3]} of {len(dark)})")


def check_desktop(gen) -> None:
    """The desktop icon keeps the FULL mark: electron-builder masks nothing, so
    ANDROID_MARK_SCALE — which is a reaction to the launcher's mask alone — must
    not leak into ui/build/ (whose bytes additionally must not change)."""
    path = DESKTOP / "icon.png"
    check(path.is_file(), "ui/build/icon.png exists")
    if not path.is_file():
        return
    width, height, rows = png_rgba(path)
    check((width, height) == (gen.W, gen.W),
          f"ui/build/icon.png is {gen.W}x{gen.W} (found {width}x{height})")
    if not rows:
        return
    want = 2 * gen.RING_OUTER
    got = red_extent(rows[height // 2], width)
    check(abs(got - want) <= 2,
          f"ui/build/icon.png: the mark keeps its full {want}px width (found {got}px)")


def check_generated_bytes(gen) -> None:
    """The generator is the only author: everything it writes to disk must equal
    what is committed. This is what makes 'desktop and phone cannot drift' true
    rather than aspirational — a hand-edited icon resource fails here."""
    with tempfile.TemporaryDirectory(prefix="clutch-icon-") as td:
        tmp = Path(td)
        (tmp / "ui" / "build").mkdir(parents=True)
        gen.write_png(tmp / "ui" / "build" / "icon.png", gen.render(gen.W))
        gen.write_svg(tmp / "ui" / "build" / "icon.svg")
        gen.write_ico(tmp / "ui" / "build" / "icon.ico")
        gen.write_android(tmp)

        pairs = [(DESKTOP / f"icon.{ext}", tmp / "ui" / "build" / f"icon.{ext}")
                 for ext in ("png", "svg", "ico")]
        pairs += [(RES / f"mipmap-{b}" / "ic_launcher.png",
                   tmp / "android" / "app" / "src" / "main" / "res" / f"mipmap-{b}" / "ic_launcher.png")
                  for b in gen.LAUNCHER_DENSITIES]
        pairs += [(RES / "drawable" / "ic_launcher_foreground.xml",
                   tmp / "android" / "app" / "src" / "main" / "res" / "drawable" / "ic_launcher_foreground.xml"),
                  (RES / "mipmap-anydpi-v26" / "ic_launcher.xml",
                   tmp / "android" / "app" / "src" / "main" / "res" / "mipmap-anydpi-v26" / "ic_launcher.xml"),
                  (RES / "values" / "colors.xml",
                   tmp / "android" / "app" / "src" / "main" / "res" / "values" / "colors.xml")]
        for committed, fresh in pairs:
            label = committed.relative_to(ROOT)
            if not committed.is_file():
                check(False, f"{label}: missing (rerun python3 scripts/make-icon.py)")
                continue
            check(committed.read_bytes() == fresh.read_bytes(),
                  f"{label}: byte-identical to a fresh scripts/make-icon.py render")


def main() -> int:
    gen = load_generator()
    print("manifest:")
    check_manifest()
    print("resources:")
    roots = check_resource_xml()
    print("adaptive icon (API 26+):")
    check_adaptive(gen, roots)
    print("raster icons (API 24-25):")
    check_rasters(gen)
    print("desktop icon:")
    check_desktop(gen)
    print("generated icons:")
    check_generated_bytes(gen)

    if failures:
        print(f"\nandroid_icon_check: {len(failures)} FAILED")
        return 1
    print("\nandroid_icon_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
