"""UI font wiring: the CSS must resolve to the SAME faces on every platform.

The Electron UI is loaded from file:// (`win.loadFile` in ui/main.js), so an
asset URL is only reachable when it is RELATIVE to the stylesheet: a
root-absolute "/vendor/fonts/x.woff2" resolves to file:///vendor/fonts/x.woff2
(filesystem root) and the @font-face quietly ends up status "error". Every
element then falls back to the OS chain, which is a different font per platform
(Microsoft YaHei on Windows, whatever fontconfig hands back on Linux) — the
whole UI silently renders in a platform-specific face.

Checks (all offline, no browser):
  1. every @font-face url() is relative and the file exists next to style.css
  2. the <link rel=preload> font hrefs in index.html ditto
  3. every var(--font-*) actually used is defined in :root (an unknown var()
     voids the declaration, so the element silently inherits instead)
  4. no `font-family: monospace|sans-serif|…` — a bare generic keyword is
     resolved by the platform, not by the app
  5. both stacks name a Linux CJK family, and --font-mono names a MONOSPACED
     one, so CJK glyphs resolve in the same order everywhere
  6. every non-ASCII character ui/ renders is drawn by a face the app ships: the
     bundled webfonts, or clutch-icons.woff2 (and that font is FIRST in both
     stacks). An uncovered glyph silently falls back to the OS symbol font —
     Segoe UI Symbol vs Apple Symbols vs fontconfig = a different icon per OS
  7. the icon font ships its license + a manifest whose sha256 matches the
     shipped woff2 (so the codepoint list above cannot go stale)
  8. mermaid labels do not fall back to the bundle's own "Arial" default: the
     diagram font is read from --font-display (one copy of the stack), with the
     inline /* comments */ flattened before the value is handed over

Run: uv run python3 -m tests.ui_fonts_check
"""

from __future__ import annotations

import ast
import hashlib
import re
from pathlib import Path

from tests.testsupport import collecting_check

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
CSS = UI / "style.css"
HTML = UI / "index.html"
BUILDER = ROOT / "scripts" / "build-icon-font.py"

WEBFONTS = {"archivo", "jetbrains mono", "noto sans sc"}
ICON_FAMILY = "Clutch Icons"
ICON_FONT = UI / "vendor" / "fonts" / "clutch-icons.woff2"
ICON_LICENSE = UI / "vendor" / "fonts" / "clutch-icons.LICENSE.txt"
ICON_MANIFEST = UI / "vendor" / "fonts" / "clutch-icons.manifest.txt"

GENERIC_ONLY = {"monospace", "sans-serif", "serif", "cursive", "fantasy", "system-ui"}

# CJK faces per platform — the stacks must not be mac+windows only.
LINUX_CJK = ("noto sans cjk", "noto sans sc", "source han sans", "wenquanyi")
MONO_CJK = ("sarasa mono", "sarasa fixed", "noto sans mono cjk", "noto sans mono sc", "zen hei mono", "ms gothic")

# Every non-ASCII character ui/ renders must come from a face the app SHIPS,
# because a character no bundled face has is drawn by whatever font the OS
# resolves — Segoe UI Symbol / Apple Symbols / fontconfig — i.e. a different
# icon per platform. Classification, in order:
#   * LATIN_COVERED — punctuation the vendored Archivo / JetBrains Mono subsets
#     do contain (verified against their cmap with fontTools when they were
#     vendored; extend this string together with the fonts).
#   * U+FF0B ＋ is a UI button symbol, not punctuation, so it is required in the
#     bundled icon font even though it sits in the fullwidth block.
#   * CJK_RANGES — drawn by the bundled Noto Sans SC webfont (both stacks name
#     it ahead of the OS faces; the exclusion here only means clutch-icons need
#     not carry Han glyphs, not that the OS may draw them)
#   * everything else (▣ ▦ ⚙ ▶ ▸ ▾ ↓ → ✓ ↶ ✎ ⚠ ⟦ ⟧ ■, and any symbol added
#     later) MUST be baked into clutch-icons.woff2.
LATIN_COVERED = "²·×—…"
CJK_RANGES = (
    (0x1100, 0x11FF),  # hangul jamo
    (0x2E80, 0x303F),  # CJK radicals + CJK punctuation
    (0x3040, 0x30FF),  # kana
    (0x3100, 0x312F),  # bopomofo
    (0x3130, 0x318F),  # hangul compat jamo
    (0x31C0, 0x9FFF),  # CJK strokes → CJK unified ideographs
    (0xA960, 0xA97F),  # hangul jamo extended-A
    (0xAC00, 0xD7FF),  # hangul syllables
    (0xF900, 0xFAFF),  # CJK compat ideographs
    (0xFE10, 0xFE4F),  # vertical forms
    (0xFF01, 0xFF60),  # fullwidth forms (，。（）)
    (0xFFE0, 0xFFE6),  # fullwidth signs
    (0x20000, 0x3FFFF),  # CJK ext B+
)

check, failures = collecting_check(indent="  ")


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def rules(css: str) -> list[tuple[str, str]]:
    return [(" ".join(sel.split()), body) for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)]


def var_value(css: str, name: str) -> str:
    m = re.search(re.escape(name) + r"\s*:\s*(.*?);", css, flags=re.S)
    return " ".join(m.group(1).split()).lower() if m else ""


def url_targets(text: str) -> list[str]:
    return re.findall(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", text)


def is_relative(ref: str) -> bool:
    return not (ref.startswith("/") or "://" in ref or ref.startswith("data:"))


def check_font_face_urls(css: str) -> None:
    faces = parse_font_faces(css)
    families = [f.strip('"').lower() for f, _ in faces]
    check(sorted(families) == sorted(WEBFONTS | {ICON_FAMILY.lower()}),
          f"@font-face families: {families} (expected Archivo + JetBrains Mono + Noto Sans SC + {ICON_FAMILY})")
    check(len(faces) == 4, f"@font-face count: {len(faces)} (one per family, no duplicates)")
    refs: list[str] = []
    for _family, body in faces:
        refs += url_targets(body)
    check(bool(refs), "each @font-face carries a url()")
    check(len(refs) == len(faces), f"one url() per @font-face ({len(refs)} urls / {len(faces)} faces)")
    for ref in refs:
        check(is_relative(ref), f"@font-face url is relative (file:// safe): {ref}")
        check((UI / ref).is_file(), f"font file exists: ui/{ref}")


def check_preload_hrefs(html: str, css: str) -> None:
    hrefs = re.findall(r"<link[^>]+as=[\"']font[\"'][^>]*>", html)
    check(bool(hrefs), "index.html preloads the webfonts")
    preloaded: list[str] = []
    for tag in hrefs:
        m = re.search(r"href=[\"']([^\"']+)[\"']", tag)
        if m is None:
            check(False, f"preload tag has an href: {tag}")
            continue
        ref = m.group(1)
        preloaded.append(ref)
        check(is_relative(ref), f"preload href is relative: {ref}")
        check((UI / ref).is_file(), f"preloaded font exists: ui/{ref}")
    declared = [ref for _f, body in parse_font_faces(css) for ref in url_targets(body)]
    check(sorted(preloaded) == sorted(declared),
          f"every @font-face is preloaded (declared {sorted(declared)}, preloaded {sorted(preloaded)}) — "
          "the icon font especially, or the first frame paints icons in the OS face")


def parse_font_faces(css: str) -> list[tuple[str, str]]:
    """[(family, body)] for every @font-face, family unquoted as written."""
    out: list[tuple[str, str]] = []
    for body in re.findall(r"@font-face\s*\{(.*?)\}", css, flags=re.S):
        m = re.search(r"font-family\s*:\s*([^;]+);", body)
        out.append((m.group(1).strip() if m else "", body))
    return out


def icon_face(css: str) -> tuple[str, str] | None:
    for family, body in parse_font_faces(css):
        if family.strip('"').lower() == ICON_FAMILY.lower():
            return family, body
    return None


def codepoint_manifest() -> tuple[str, set[int]]:
    """(font file name, codepoints) as published by scripts/build-icon-font.py."""
    font, points = "", set()
    for line in ICON_MANIFEST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("font:"):
            font = line.split(":", 1)[1].strip()
        elif re.fullmatch(r"U\+[0-9A-Fa-f]{4,6}", line):
            points.add(int(line[2:], 16))
    return font, points


def ui_source_files() -> list[Path]:
    """The UI's own sources — never build output or third-party bundles, whose
    symbol characters we do not control and must not scan for coverage."""
    skip = {"vendor", "dist", "node_modules", ".git", "build", "release", "out"}
    return sorted(
        p for ext in ("*.html", "*.js", "*.css")
        for p in UI.rglob(ext)
        if not skip.intersection(p.parts) and p.stat().st_size < 2_000_000
    )


def in_cjk(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


def used_icon_codepoints() -> dict[int, set[str]]:
    """Every character in ui/ that no bundled face covers — the ones that must be
    in clutch-icons.woff2, mapped to the files that use them."""
    found: dict[int, set[str]] = {}
    for path in ui_source_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for ch in sorted(set(text)):  # set(): dedupe before classifying
            cp = ord(ch)
            if cp < 0x80 or ch in LATIN_COVERED or (in_cjk(cp) and ch != "\uFF0B"):
                continue
            found.setdefault(cp, set()).add(str(path.relative_to(ROOT)))
    return found


def check_mermaid_font(js: str) -> None:
    """Diagram labels are text too: mermaid's bundled default is a bare "Arial",
    which every OS resolves with a different face (Liberation Sans on Linux, the
    real Arial on Windows), so the diagrams drifted exactly like the chrome."""
    check('cssValue("--font-display")' in js,
          "mermaid diagrams read the font stack from --font-display (no second copy of the stack)")
    # --font-display is written with inline /* comments */ and newlines for
    # readability. mermaid re-emits whatever it is handed into a <style> block
    # and into inline style attributes, so the value must be flattened first.
    helper = re.search(r"cssValue\s*=\s*\(name\)\s*=>([\s\S]{0,240}?);\n", js)
    check(helper is not None, "a cssValue() helper sanitises the :root custom properties")
    if helper is not None:
        body = helper.group(1)
        check("getPropertyValue" in body, "cssValue() reads the computed custom property")
        check(r"\*" in body,
              "cssValue() strips /* comment */ runs — a comment is legal in a CSS font list "
              "but mermaid re-emits the raw value")
    block = re.search(r"themeVariables\s*:\s*\{", js)
    check(block is not None, "mermaid.initialize passes themeVariables")
    if block is None:
        return
    m = re.search(r"\bfontFamily\s*:\s*([^,\n]+)", js[block.end():block.end() + 400])
    check(m is not None, "mermaid themeVariables sets fontFamily")
    if m is None:
        return
    value = m.group(1).strip()
    check(not re.fullmatch(r"""["'][^"']*["']""", value),
          f"mermaid fontFamily is derived from the CSS stack, not hardcoded (found {value!r})")


def check_icon_font(css: str) -> None:
    face = icon_face(css)
    check(face is not None, f"@font-face for the icon font '{ICON_FAMILY}' exists")
    if face is None:
        return
    body = face[1]
    refs = url_targets(body)
    check(refs == ["vendor/fonts/clutch-icons.woff2"], f"icon font url points at the vendored woff2: {refs}")
    check("format(\"woff2\")" in body, "icon font is declared as woff2")
    check("font-display: block" in body,
          "icon font uses font-display: block (an icon must not flash in the OS face first)")
    m = re.search(r"font-weight\s*:\s*([^;]+);", body)
    weight = m.group(1).strip() if m else ""
    check(weight == "400 900",
          f"icon font declares one outline for every weight (font-weight: {weight!r}) — "
          "otherwise bold text synthesizes a smeared icon and the icon changes with font-weight")

    for path in (ICON_FONT, ICON_LICENSE, ICON_MANIFEST):
        check(path.is_file(), f"{path.relative_to(ROOT)} exists")
    if not ICON_MANIFEST.is_file() or not ICON_FONT.is_file():
        return

    font_name, baked = codepoint_manifest()
    check(font_name == ICON_FONT.name, f"manifest describes {font_name!r} (expected {ICON_FONT.name!r})")
    digest = hashlib.sha256(ICON_FONT.read_bytes()).hexdigest()
    check(f"sha256: {digest}" in ICON_MANIFEST.read_text(encoding="utf-8"),
          "manifest sha256 matches the shipped woff2 (rebuild with scripts/build-icon-font.py if not)")

    # unicode-range is the "this face can never shadow text" guarantee written in
    # CSS — the browser ignores the face for anything outside it, whatever the
    # font's cmap says. It must be exactly the codepoints the font carries.
    m = re.search(r"unicode-range\s*:\s*([^;}]+)", body)
    declared_range: set[int] = set()
    for item in (m.group(1).split(",") if m else []):
        item = item.strip()
        lo, _, hi = item.partition("-")
        if not re.fullmatch(r"U\+[0-9A-Fa-f]{1,6}", lo):
            continue
        declared_range.update(range(int(lo[2:], 16), int(hi[2:], 16) + 1 if hi else int(lo[2:], 16) + 1))
    check(m is not None, "icon font declares unicode-range (so it cannot shadow a text character)")
    check(declared_range == baked,
          "icon font unicode-range == the font's codepoints (css-only: "
          f"{sorted(hex(c) for c in declared_range - baked)}, "
          f"font-only: {sorted(hex(c) for c in baked - declared_range)})")

    # the builder's own codepoint list must equal the manifest, so editing one
    # without rebuilding the other is caught
    tree = ast.parse(BUILDER.read_text(encoding="utf-8"))
    declared: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "ICONS" for t in node.targets
        ) and isinstance(node.value, ast.Dict):
            declared = {int(k.value) for k in node.value.keys if isinstance(k, ast.Constant)}
    check(declared == baked,
          f"builder ICONS == manifest codepoints (builder-only: {sorted(hex(c) for c in declared - baked)}, "
          f"manifest-only: {sorted(hex(c) for c in baked - declared)})")
    check(len(baked) >= 16, f"icon font covers {len(baked)} codepoints")

    used = used_icon_codepoints()
    uncovered = sorted(set(used) - baked)
    check(not uncovered,
          "every symbol glyph used in ui/ is baked into the font"
          + (
              " — MISSING "
              + "; ".join(f"{chr(cp)} U+{cp:04X} ({', '.join(sorted(used[cp]))})" for cp in uncovered)
              + ": add it to ICONS in scripts/build-icon-font.py and rerun the build, or the OS draws it"
              if uncovered else f" ({len(used)} symbols scanned, none drawn by the OS)"
          ))
    unused = sorted(baked - set(used))
    if unused:
        print(f"  note  icon font also carries {', '.join(f'U+{cp:04X}' for cp in unused)} (not used in ui/ yet)")


def check_icon_family_first(css: str) -> None:
    for name in ("--font-display", "--font-mono"):
        value = var_value(css, name)
        first = value.split(",")[0].strip().strip('"')
        check(first.lower() == ICON_FAMILY.lower(),
              f"{name} lists '{ICON_FAMILY}' first (found {first!r})")


def check_font_vars(css: str) -> None:
    defined = set(re.findall(r"(--font-[a-z0-9-]+)\s*:", css))
    used = set(re.findall(r"var\(\s*(--font-[a-z0-9-]+)", css))
    missing = sorted(used - defined)
    check(not missing, f"every var(--font-*) is defined in :root (missing: {missing})")


def check_no_bare_generic(css: str) -> None:
    bad: list[str] = []
    for sel, body in rules(css):
        for decl in body.split(";"):
            if "font-family" not in decl:
                continue
            value = decl.split(":", 1)[1].strip().strip("'\" ").lower()
            if value in GENERIC_ONLY:
                bad.append(f"{sel} -> font-family: {value}")
    check(not bad, f"no platform-resolved generic font-family ({bad})")


def check_stack_coverage(css: str) -> None:
    display = var_value(css, "--font-display")
    mono = var_value(css, "--font-mono")
    check('"archivo"' in display, "--font-display keeps the bundled webfont (Archivo)")
    check(any(f in display for f in LINUX_CJK), "--font-display names a Linux CJK family (not mac+win only)")
    check('"jetbrains mono"' in mono, "--font-mono keeps the bundled webfont (JetBrains Mono)")
    check(any(f in mono for f in MONO_CJK), "--font-mono names a monospaced CJK family")
    # the bundled CJK face is what makes Han glyphs identical on every OS; it
    # must also come BEFORE the OS faces, or e.g. zh-CN Windows quietly drifts
    # back to Microsoft YaHei / MS Gothic (this regressed once: the Noto face
    # lived only in a stash, and the released app fell back to YaHei)
    check('"noto sans sc"' in display and '"noto sans sc"' in mono,
          "both stacks keep the bundled CJK face (Noto Sans SC)")
    if '"noto sans sc"' in display and '"microsoft yahei"' in display:
        check(display.index('"noto sans sc"') < display.index('"microsoft yahei"'),
              "--font-display resolves CJK from the bundled Noto before Microsoft YaHei")
    if '"noto sans sc"' in mono and '"ms gothic"' in mono:
        check(mono.index('"noto sans sc"') < mono.index('"ms gothic"'),
              "--font-mono resolves CJK from the bundled Noto before MS Gothic (JIS shapes)")


def main() -> int:
    raw = CSS.read_text(encoding="utf-8")
    css = strip_comments(raw)
    html = HTML.read_text(encoding="utf-8")

    print("ui font wiring:")
    check_font_face_urls(css)
    check_preload_hrefs(html, css)
    check_font_vars(css)
    check_no_bare_generic(css)
    check_stack_coverage(css)
    print("bundled icon font:")
    check_icon_font(css)
    check_icon_family_first(css)
    print("diagram labels:")
    check_mermaid_font((UI / "app.js").read_text(encoding="utf-8"))

    if failures:
        print(f"\nui_fonts_check: {len(failures)} FAILED")
        return 1
    print("\nui_fonts_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
