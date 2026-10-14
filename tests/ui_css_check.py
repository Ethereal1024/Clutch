"""UI stylesheet wiring: a comment must end where its own `*/` says.

v0.1.34 reworded ui/mobile.css's header comment to mention the token names the
plugin tab's rules are written against, and wrote them as `--ctl-*/--fs-*`. CSS
comments do not nest, so that `*/` closed the comment on line 7 instead of line
26: the prose after it became "code", and the `@media (max-width: 640px) {` that
follows it — the whole reason this file exists — became the PRELUDE of one
qualified rule whose selector can never match. By the spec's error recovery a
browser drops such a rule WITH its block, so from v0.1.34 to v0.1.42 every phone
rule in this file (38 of them: the picker's wrapping host row and its 560px box,
the right panel's slide-over and its close button, the input bar's re-flow) was
dead. index.html links this sheet under `media="(max-width: 640px)"`, so no
desktop window ever showed it: the phone looked like a different app.

Nothing caught it, and nothing could have: the file's braces still balance, the
swallow is LEGAL recovery (a stylesheet-level parse reports no error at all),
the js side has tests/ui-load-order-test.js and `node --check` behind it while
the css side had no gate, and `git diff` shows the change as one harmless
comment line. What is checkable is the SHAPE of each sheet, which is what this
module asserts (all offline, no browser, no deps — the scan below is ~60 lines
of comments/strings/braces, the exact part of the grammar this bug lives in):

  1. every block and comment is closed (a `{` or a `/*` left open)
  2. no top-level rule whose prelude reads as prose — a bad string (a quote that
     a newline ends) or an at-keyword after the first token is the signature of
     a comment that ended early, and it is the thing to name in the failure
  3. ui/style.css is the desktop sheet: a rule count in the hundreds, plus the
     two @media blocks and the @font-face set that are its furniture
  4. ui/mobile.css is a phone sheet by construction: NO top-level style rule at
     all (every rule it ships is inside its one @media block), and that block is
     `(max-width: 640px)` with the phone's rule count behind it
  5. index.html links style.css unconditionally and mobile.css only under
     `(max-width: 640px)` — the audience split that makes a phone-only failure
     invisible on the desktop, so it must not drift
  6. when this tree has synced android assets, the copy of each sheet is
     byte-for-byte the source (the APK ships the copy, not the source; a fix
     that forgets scripts/sync-android-host.sh is a fix the phone never gets)
  7. the detector itself is exercised on the v0.1.34 shape, in miniature — so a
     future edit that blinds the scan fails HERE instead of passing quietly

Run: uv run python3 -m tests.ui_css_check
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

from tests.testsupport import collecting_check

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
HTML = UI / "index.html"
ANDROID_UI = ROOT / "android" / "app" / "src" / "main" / "assets" / "ui"

DESKTOP = UI / "style.css"
PHONE = UI / "mobile.css"

PHONE_QUERY = "(max-width: 640px)"

check, failures = collecting_check()


class Block(NamedTuple):
    """One `{` the sheet opens, with everything the checks judge it on."""

    depth: int  # nesting: 0 is the sheet's top level
    line: int  # line of the prelude's first significant character
    prelude: str  # text between the previous statement end and this `{`
    at_keyword: str  # "" for a qualified rule, else the keyword after `@`
    prose: tuple[str, ...]  # what in the prelude reads as prose, if anything
    inner: int  # blocks opened directly inside it


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _read_prelude(prelude: str, base_line: int) -> tuple[str, int, tuple[str, ...]]:
    """(at-keyword, line of the first significant character, prose notes).

    The first significant token decides the kind of statement (an `@` opens an
    at-rule). Everything AFTER it is scanned for the two prose signatures, since
    that is where a comment that ended early dumps the text it swallowed: an
    apostrophe in a word ends as a bad string, and the `@media` that should have
    opened a block turns up as an at-keyword in the middle of a selector list.
    """
    notes: list[str] = []
    at_keyword = ""
    line = base_line
    i, n = 0, len(prelude)

    while i < n:  # leading whitespace/comments, then the first significant token
        if prelude.startswith("/*", i):
            end = prelude.find("*/", i + 2)
            if end == -1:
                return at_keyword, line, tuple(notes)
            i = end + 2
        elif prelude[i] in " \t\n\r\f":
            i += 1
        else:
            break
    if i < n:
        line = base_line + prelude.count("\n", 0, i)
        if prelude[i] == "@":
            j = i + 1
            while j < n and (prelude[j].isalnum() or prelude[j] in "-_"):
                j += 1
            at_keyword = prelude[i + 1:j].lower()
            i = j

    while i < n:
        c = prelude[i]
        if prelude.startswith("/*", i):
            end = prelude.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif c in "\"'":
            j = i + 1
            while j < n and prelude[j] not in "\"'\\\n\r\f":
                j += 1
            if j >= n or prelude[j] in "\n\r\f":  # a bad string
                notes.append(
                    f"line {base_line + prelude.count(chr(10), 0, i)}: "
                    f"a quote opens here and a newline ends it, so {prelude[i:i + 34]!r} reads as prose"
                )
                i = j
            else:
                i = j + 1
        elif c == "\\":
            i += 2
        elif c == "@":
            j = i + 1
            while j < n and (prelude[j].isalnum() or prelude[j] in "-_"):
                j += 1
            notes.append(
                f"line {base_line + prelude.count(chr(10), 0, i)}: "
                f"@{prelude[i + 1:j]} sits in a selector list, not at a statement start"
            )
            i = j
        else:
            i += 1
    return at_keyword, line, tuple(notes)


def _walk(text: str) -> tuple[list[Block], list[str]]:
    """Every block the sheet opens, in source order, plus what is structurally broken.

    Comments and strings are stepped over, so a `{` inside either is text and not
    a block; a top-level `;` ends a statement (`@import`). This is deliberately
    not a CSS parser: it reads the braces and the comment/string boundaries, which
    is the whole of what a comment that ends early can corrupt.
    """
    blocks: list[Block] = []
    errors: list[str] = []
    stack: list[int] = []  # indices into blocks, the open blocks
    start = 0  # where the prelude of the next block begins
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end == -1:
                errors.append(f"line {_line_of(text, i)}: a comment opens here and is never closed")
                break
            i = end + 2
        elif c in "\"'":
            quote, i = c, i + 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                elif text[i] == quote:
                    i += 1
                    break
                elif text[i] in "\n\r\f":
                    break  # bad string: a newline is not allowed inside one
                else:
                    i += 1
        elif c == "\\":
            i += 2
        elif c == "{":
            if stack:
                parent = blocks[stack[-1]]
                blocks[stack[-1]] = parent._replace(inner=parent.inner + 1)
            prelude = text[start:i]
            keyword, line, prose = _read_prelude(prelude, _line_of(text, start))
            blocks.append(Block(len(stack), line, prelude, keyword, prose, 0))
            stack.append(len(blocks) - 1)
            i += 1
            start = i
        elif c == "}":
            if stack:
                stack.pop()
            else:
                errors.append(f"line {_line_of(text, i)}: a `}}` closes a block that never opened")
            i += 1
            start = i
        elif c == ";" and not stack:
            i += 1
            start = i
        else:
            i += 1
    if stack:
        errors.append(f"line {blocks[stack[0]].line}: a block opens here and is never closed")
    return blocks, errors


def audit(text: str) -> tuple[list[str], list[str], list[tuple[str, str, int]], int]:
    """(errors, prose-preludes, top-level [(at-keyword, prelude, rules inside)], top-level rules)."""
    blocks, errors = _walk(text)
    prose: list[str] = []
    ats: list[tuple[str, str, int]] = []
    top_rules = 0
    for block in blocks:
        prose.extend(block.prose)
        if block.depth != 0:
            continue
        if block.at_keyword:
            ats.append((block.at_keyword, _clean(block.prelude).lstrip("@" + block.at_keyword).strip(), block.inner))
        else:
            top_rules += 1
    return errors, prose, ats, top_rules


def _clean(text: str) -> str:
    """The prelude as a reader sees it: comments and runs of whitespace gone."""
    without_comments = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"\s+", " ", without_comments).strip()


def at_rules(ats: list[tuple[str, str, int]], keyword: str, prelude: str = "") -> list[tuple[str, str, int]]:
    return [a for a in ats if a[0] == keyword and a[1] == prelude]


def stylesheet_links(html: str) -> dict[str, str | None]:
    """href -> media attribute (None when the link is unconditional)."""
    out: dict[str, str | None] = {}
    for tag in re.findall(r"<link\b[^>]*>", html):
        if 'rel="stylesheet"' not in tag:
            continue
        href = re.search(r'href="([^"]+)"', tag)
        media = re.search(r'media="([^"]+)"', tag)
        if href:
            out[href.group(1)] = media.group(1) if media else None
    return out


def check_sheet(path: Path, name: str, *, phone: bool) -> None:
    errors, prose, ats, rules = audit(path.read_text(encoding="utf-8"))
    check(not errors, f"{name} closes every block and comment it opens"
          + (f" — {errors[0]}" if errors else ""))
    check(not prose, f"{name} has no rule whose prelude reads as prose (a comment that ended early)"
          + (f" — {prose[0]}" if prose else ""))
    check(bool(at_rules(ats, "media", PHONE_QUERY)) == phone,
          f"{name} {'holds' if phone else 'does not hold'} a top-level @media {PHONE_QUERY}")
    if phone:
        # every rule in this sheet is inside that block, so a block that stops
        # being an at-rule is every phone rule gone at once
        block = at_rules(ats, "media", PHONE_QUERY)
        inside = block[0][2] if block else 0
        check(rules == 0, f"{name} has no top-level style rule ({rules} found: its rules belong in the media block)")
        check(inside >= 30, f"@media {PHONE_QUERY} holds the phone's rules ({inside} inside)")
    else:
        check(rules >= 300, f"{name} is the desktop sheet ({rules} top-level style rules)")
        check(len(at_rules(ats, "font-face")) >= 1,
              f"{name} keeps its @font-face set ({len(at_rules(ats, 'font-face'))})")
        check(bool(at_rules(ats, "media", "(prefers-reduced-motion: reduce)")),
              f"{name} keeps @media (prefers-reduced-motion: reduce)")
        hover = at_rules(ats, "media", "(hover: none)")
        check(bool(hover) and hover[0][2] >= 5, f"{name} keeps @media (hover: none) with its touch rules")


def check_android_copy(name: str) -> None:
    src = UI / name
    dst = ANDROID_UI / name
    if not dst.exists():
        check(True, f"android assets are not synced on this tree — ui/{name} parity not checked")
        return
    check(dst.read_bytes() == src.read_bytes(),
          f"android/app/src/main/assets/ui/{name} is the byte-for-byte copy of ui/{name}")


# The v0.1.34 shape in miniature: the header comment names the tokens the plugin
# tab's rules are written against, and writes them `--ctl-*/--fs-*` — the `*/`
# closes the comment mid-line, the prose becomes a selector, and the `@media`
# below it becomes part of that selector. This is what the shipped phone sheet
# looked like for nine releases, so the scan is built on it, not trusted.
REGRESSION_SHEET = """\
/* N7 (M3): narrow-screen overrides written against the --ctl-*/--fs-* names the
   plugin tab's rules use; those two spaces are load-bearing
   #1 the conn modal grew a horizontal scrollbar
   #2 the workspace panel became a drawer */
@media (max-width: 640px) {
  #right { transform: none }
  #task-input { padding: 8px }
}
"""


def check_regression() -> None:
    errors, prose, ats, rules = audit(REGRESSION_SHEET)
    check(bool(prose), "the scan reports the v0.1.34 header comment as prose (the regression it exists for)")
    check(not at_rules(ats, "media", PHONE_QUERY),
          "the swallowed @media is not read as an at-rule (its rules are gone with it)")
    check(rules == 1, f"the swallowed @media reads as one qualified rule holding them ({rules} top-level style rule)")


def main() -> int:
    print("ui stylesheets:")
    check_sheet(DESKTOP, "ui/style.css", phone=False)
    check_sheet(PHONE, "ui/mobile.css", phone=True)
    print("which sheet reaches which width:")
    links = stylesheet_links(HTML.read_text(encoding="utf-8"))
    check("style.css" in links and links["style.css"] is None,
          "index.html links style.css unconditionally (the desktop sheet)")
    check(links.get("mobile.css") == PHONE_QUERY,
          f'index.html links mobile.css under media="{PHONE_QUERY}" (the phone sheet)')
    print("what the phone is shipped:")
    check_android_copy("style.css")
    check_android_copy("mobile.css")
    print("the scan itself:")
    check_regression()

    if failures:
        print(f"\nui_css_check: {len(failures)} FAILED")
        return 1
    print("\nui_css_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
