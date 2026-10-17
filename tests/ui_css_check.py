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
  8. every name the two sheets read is one either sheet declares, and so is every
     name js reads out of the cascade with cssValue() — `var(--fg)` sat in a hover
     rule with no declaration anywhere, which is not an error a browser reports:
     the declaration is dropped and the colour simply inherits, i.e. a rule that
     looks deliberate and means nothing
  9. the js side of the motion is the css side's tokens: ARRIVE_EASE in
     js/stream-text.js is --arrival and LEAVE_EASE is --departure (a fold that
     opens arrives, one that closes leaves — so both names have to be the pair
     one easing picks between, not two constants one of which moves nothing),
     the duration a row-sized fold runs is FOLD_MS and that constant is --move,
     the region fold's far end is FOLD_SIZE_MS and that is --size, and
     settings.js's MODAL_CLOSE_MS is --move in milliseconds. The folds are
     animated in js and the tokens live in css, so nothing in either language
     can see the other: without a pin, editing one half is a silent change to
     the rhythm

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

# one `--name: value`, and the two ways a name is read: a `var(--name)` (the char
# that follows says whether a fallback makes a missing declaration legal) and a
# `cssValue("--name")` read in js. A duration in js is always a WAAPI option.
DECLARATION = re.compile(r"(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]*)")
VAR_USE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])")
JS_TOKEN_READ = re.compile(r'cssValue\(\s*"(--[A-Za-z0-9_-]+)"\s*\)')
JS_DURATION = re.compile(r"duration:\s*(\d+)\s*[,}]")

# The region fold's duration is not a constant: ONE measurement paces the box and
# the body inside it on the same clock, so the pin is that the measurement IS
# foldMoveMs(fold) and that an animation runs for what it returned.
RAMP_WIRED = re.compile(
    r"const\s+ms\s*=\s*foldMoveMs\(\s*fold\s*\)\s*;[\s\S]{0,260}?duration:\s*ms\s*[,}]"
)

# A curve is a pair only while a DIRECTION picks between the two: the diff fold grows
# into place and shrinks out of it, and a region fold (one with rows to slide) is a
# box arriving at its new size in both directions. One curve wired into both
# directions leaves every value above still matching the sheet.
EASING_PICKS = (
    re.compile(r"easing:\s*to\s*>=\s*from\s*\?\s*ARRIVE_EASE\s*:\s*LEAVE_EASE"),
    re.compile(r"easing\s*=\s*open\s*\|\|\s*body\s*\?\s*ARRIVE_EASE\s*:\s*LEAVE_EASE"),
)

FOLD_JS = UI / "js" / "stream-text.js"
MODAL_JS = UI / "js" / "settings.js"

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


def code_only(text: str, *, js: bool = False) -> str:
    """`text` with every comment's words replaced by the newlines that were in them.

    Both scans below look for names, and the sheets name their own tokens and
    curves constantly in prose (the motion note spells --arrival twice): reading a
    comment as code invents declarations that do not exist. Dropping the comments
    would shift every line number a failure reports, so the newlines are kept.
    """
    def blank(match: re.Match[str]) -> str:
        return "\n" * match.group(0).count("\n")

    without_blocks = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    if not js:
        return without_blocks
    return re.sub(r"//[^\n]*", "", without_blocks)


def declared_tokens(*codes: str) -> dict[str, str]:
    """Every custom property the given sheets declare, name -> value as written.

    The value of a name declared twice is the last one written, which is what the
    cascade would do for rules of equal specificity; the checks only read names
    here and --arrival/--move are declared once, in :root.
    """
    out: dict[str, str] = {}
    for code in codes:
        for match in DECLARATION.finditer(code):
            out[match.group(1)] = match.group(2).strip()
    return out


def undeclared_sheet_reads(label: str, code: str, declared: dict[str, str]) -> list[str]:
    """`var(--x)` uses in one sheet whose name no sheet declares.

    A `var()` WITH a fallback is exempt and stays exempt: `var(--accent, #EF4444)`
    is the statement "this may be missing, and here is what that means", so it is
    the one form that needs no declaration to be correct.
    """
    out: list[str] = []
    for match in VAR_USE.finditer(code):
        if match.group(2) == ",":
            continue
        if match.group(1) not in declared:
            out.append(
                f"{label}:{_line_of(code, match.start())}: var({match.group(1)}) — "
                f"neither sheet declares {match.group(1)}, so the declaration is dropped "
                f"and the value is inherited"
            )
    return out


def undeclared_js_reads(label: str, code: str, declared: dict[str, str]) -> list[str]:
    """The same for a token js reads out of the cascade with `cssValue("--x")`."""
    out: list[str] = []
    for match in JS_TOKEN_READ.finditer(code):
        if match.group(1) not in declared:
            out.append(
                f"{label}:{_line_of(code, match.start())}: cssValue(\"{match.group(1)}\") — "
                f"neither sheet declares {match.group(1)}, so the read is always empty"
            )
    return out


def ms_of(value: str) -> int | None:
    """A CSS time as milliseconds (None when the value is not one)."""
    match = re.fullmatch(r"(?:(\d*\.?\d+)s|(\d+)ms)", value.strip())
    if not match:
        return None
    if match.group(1):
        return int(float(match.group(1)) * 1000 + 0.5)
    return int(match.group(2))


def js_ms(js: str, name: str) -> int | None:
    """The integer a `const NAME = 200;` in js holds (None when it is not there)."""
    match = re.search(rf"const\s+{re.escape(name)}\s*=\s*(\d+)\s*;", js)
    return int(match.group(1)) if match else None


def motion_drifts(declared: dict[str, str], fold_js: str, settings_js: str) -> list[str]:
    """Every place the js side has drifted from the sheet's own motion tokens.

    The folds are animated in js (WAAPI, so a height can be interpolated without a
    layout property being transitioned) while their curves and their duration are
    the sheet's --arrival, --departure and --move: nothing in either language can
    see the other, so the pairing is only real while a check holds it — and the
    pair is used by DIRECTION (a fold that opens arrives, one that closes leaves),
    which is why both curves are pinned by name and not just one.
    settings.js's MODAL_CLOSE_MS is --move in milliseconds — the timer that lands
    `.hidden` when the closing slide is over — and drifts the same way, one frame
    at a time.
    The region fold is the one move whose duration is not a constant: it walks
    from --move up to --size with the distance it covers, so --size is pinned too,
    along with the ramp call site that is the only place the far end is reached.
    """
    out: list[str] = []
    move_ms = ms_of(declared.get("--move", ""))

    for name, token in (("ARRIVE_EASE", "--arrival"), ("LEAVE_EASE", "--departure")):
        token_value = declared.get(token)
        curve = re.search(rf'const\s+{name}\s*=\s*"([^"]*)"\s*;', fold_js)
        written = curve.group(1) if curve else f"(no {name})"
        if not token_value or _compact(written) != _compact(token_value):
            out.append(
                f"ui/js/stream-text.js: {name} = {written!r} is not "
                f"ui/style.css's {token} = {token_value!r}"
            )

    # the duration is a constant now (the same one at every call site), so the pin
    # is on the constant's value AND on one animation actually running for it: a
    # renamed or unused constant is the same drift with nothing left to read.
    fold_ms = js_ms(fold_js, "FOLD_MS")
    if move_ms is None or fold_ms != move_ms:
        out.append(
            f"ui/js/stream-text.js: FOLD_MS = {fold_ms} is not --move "
            f"({declared.get('--move')!r}), which every fold here runs for"
        )
    if not re.search(r"duration:\s*FOLD_MS\s*,", fold_js):
        out.append(
            "ui/js/stream-text.js: no animation runs for FOLD_MS — the fold's "
            "duration is not the sheet's --move at all"
        )

    # the region fold (a whole turn, js/auto-fold.js) is ONE move whose length
    # depends on the distance it covers: a row-sized fold rides --move, a
    # screenful leaves on --size, and the two ends are the same constant pair.
    # --size is the sheet's own word for exactly this ("a surface changing its own
    # height"), so the far end of the ramp is pinned here too: a drift back to the
    # flat --move would put a hundred-row turn away at the speed of one row, which
    # is the jump this ramp exists to remove.
    size_ms = ms_of(declared.get("--size", ""))
    fold_size_ms = js_ms(fold_js, "FOLD_SIZE_MS")
    if size_ms is None or fold_size_ms != size_ms:
        out.append(
            f"ui/js/stream-text.js: FOLD_SIZE_MS = {fold_size_ms} is not --size "
            f"({declared.get('--size')!r}), the far end of the region fold's ramp"
        )
    if not RAMP_WIRED.search(fold_js):
        out.append(
            "ui/js/stream-text.js: no animation runs for foldMoveMs(fold) — the "
            "region fold's above---move duration is not wired to the distance ramp"
        )

    # ...and both curves have to be the pair some easing actually PICKS BETWEEN.
    # The decision is a direction (a fold that opens arrives, one that closes
    # leaves), so one curve wired into both directions is the drift the two names
    # exist to make visible — and every value above would still match the sheet.
    if not all(pick.search(fold_js) for pick in EASING_PICKS):
        out.append(
            "ui/js/stream-text.js: no easing picks between ARRIVE_EASE and LEAVE_EASE by "
            "direction (a diff fold grows into place and shrinks out of it; a region fold "
            "has a body, so it arrives in BOTH directions) — both curves are in the file "
            "and neither one moves anything"
        )

    for match in JS_DURATION.finditer(fold_js):
        if move_ms is None or int(match.group(1)) != move_ms:
            out.append(
                f"ui/js/stream-text.js:{_line_of(fold_js, match.start())}: the fold runs "
                f"{match.group(1)}ms while --move is {declared.get('--move')!r}"
            )

    close_ms = js_ms(settings_js, "MODAL_CLOSE_MS")
    if move_ms is None or close_ms != move_ms:
        out.append(
            f"ui/js/settings.js: MODAL_CLOSE_MS = {close_ms} is not --move "
            f"({declared.get('--move')!r}), which `.modal.closing` runs for"
        )
    return out


def _compact(value: str) -> str:
    """A curve with its whitespace gone: the js spelling and the css one are the
    same curve, and the sheet writes the gaps a reader needs."""
    return re.sub(r"\s+", "", value)


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


def check_tokens() -> None:
    """Every name either sheet reads is a name one of them declares, and so is every
    name js reads out of the cascade."""
    codes = {name: code_only((UI / name).read_text(encoding="utf-8")) for name in ("style.css", "mobile.css")}
    declared = declared_tokens(*codes.values())
    print(f"the tokens the sheets are written against ({len(declared)} declared):")
    for name, code in codes.items():
        missing = undeclared_sheet_reads(f"ui/{name}", code, declared)
        check(not missing, f"ui/{name} reads only tokens the sheets declare"
              + (f" — {missing[0]}" if missing else ""))
    readers = sorted((UI / "js").glob("*.js"))
    print(f"and the ones js reads out of the cascade ({len(readers)} modules scanned):")
    for path in readers:
        code = code_only(path.read_text(encoding="utf-8"), js=True)
        missing = undeclared_js_reads(f"ui/js/{path.name}", code, declared)
        check(not missing, f"ui/js/{path.name} reads only tokens the sheets declare"
              + (f" — {missing[0]}" if missing else ""))


def check_motion() -> None:
    """The js side of the motion is the css side's tokens, in the units each needs."""
    declared = declared_tokens(code_only(DESKTOP.read_text(encoding="utf-8")))
    drifts = motion_drifts(
        declared,
        code_only(FOLD_JS.read_text(encoding="utf-8"), js=True),
        code_only(MODAL_JS.read_text(encoding="utf-8"), js=True),
    )
    print("the js side of the motion:")
    check(not drifts,
          "the js folds and the modal's close timer are the sheet's --arrival, "
          "--departure, --move and --size"
          + (f" — {drifts[0]}" if drifts else ""))


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


# The token scan and the motion pin, exercised on shapes they must and must not
# report: `var(--fg)` is the real defect this check was written after (a name used
# and never declared, so the colour silently inherited), the fallback form beside
# it is legal and must stay quiet, and the js beside it is a fold whose two curves
# have been SWAPPED and whose duration has been edited away from the sheet's
# tokens — the drift no reader of either file can see, which is the whole reason to
# pin it.
REGRESSION_TOKENS = """\
:root { --arrival: cubic-bezier(.23, 1, .32, 1); --departure: cubic-bezier(.4, 0, 1, 1); --move: .2s; --size: .3s; }
/* notes name tokens: var(--not-a-use) and cssValue("--also-not") */
.a { color: var(--fg); }
.b { color: var(--accent, #EF4444); }
"""
REGRESSION_FOLD_JS = """\
const ARRIVE_EASE = "cubic-bezier(.4, 0, 1, 1)"; // --departure, where --arrival belongs
const LEAVE_EASE = "cubic-bezier(.23, 1, .32, 1)"; // and the pair swapped
const FOLD_MS = 150; // --size, not --move
const FOLD_SIZE_MS = 300; // --size
const anim = el.animate([], { duration: FOLD_MS, easing: to >= from ? ARRIVE_EASE : LEAVE_EASE });
const ms = foldMoveMs(fold);
const sized = el.animate([], { duration: ms, easing: open || body ? LEAVE_EASE : ARRIVE_EASE });
"""
REGRESSION_MODAL_JS = "const MODAL_CLOSE_MS = 180;\n"
# the same fold with both curves correct, the durations correct, and one curve
# wired into both directions: nothing but the direction pin can see this one.
REGRESSION_FOLD_ONE_CURVE_JS = """\
const ARRIVE_EASE = "cubic-bezier(.23, 1, .32, 1)"; // --arrival
const LEAVE_EASE = "cubic-bezier(.4, 0, 1, 1)"; // --departure
const FOLD_MS = 200; // --move
const FOLD_SIZE_MS = 300; // --size
const anim = el.animate([], { duration: FOLD_MS, easing: ARRIVE_EASE });
const ms = foldMoveMs(fold);
const sized = el.animate([], { duration: ms, easing: ARRIVE_EASE });
"""


def check_regression_tokens() -> None:
    code = code_only(REGRESSION_TOKENS)
    declared = declared_tokens(code)
    missing = undeclared_sheet_reads("mini.css", code, declared)
    check([m.split("var(")[1].split(")")[0] for m in missing] == ["--fg"],
          f"the token scan reports exactly the undeclared read, not the commented ones and not the "
          f"fallback one ({len(missing)} reported)")
    check(not undeclared_js_reads("mini.css", code, declared),
          "the js read scan skips a cssValue() that is only named in a comment")
    reported = undeclared_js_reads("mini.js", 'const v = cssValue("--fg");', declared)
    check(len(reported) == 1 and "--fg" in reported[0],
          f"the js read scan reports a read that IS code ({len(reported)} reported)")


def check_regression_motion() -> None:
    declared = declared_tokens(code_only(REGRESSION_TOKENS))
    drift = motion_drifts(declared, REGRESSION_FOLD_JS, REGRESSION_MODAL_JS)
    check(len(drift) == 5,
          f"the motion pin reports the two curves a fold arrives/leaves on being swapped, a "
          f"duration that is not --move, a region fold that no longer takes the arrival curve "
          f"in both directions, and a close timer that is not --move either "
          f"({len(drift)} reported)")
    files = [d.split(":")[0] for d in drift]
    check(files == ["ui/js/stream-text.js"] * 4 + ["ui/js/settings.js"],
          f"each drift names the file it is in ({files})")
    one = motion_drifts(declared, REGRESSION_FOLD_ONE_CURVE_JS,
                        f"const MODAL_CLOSE_MS = {ms_of(declared['--move'])};\n")
    check(len(one) == 1 and "picks between ARRIVE_EASE and LEAVE_EASE" in one[0],
          f"the same fold with one curve wired into both directions is reported as that and "
          f"nothing else ({len(one)} reported)")
    # and the ramp is only wired while the ONE measurement is the duration the box and
    # its body both run for: a fold paced by a literal is the drift the ramp exists to
    # remove, and every value above would still match the sheet.
    unramped = REGRESSION_FOLD_ONE_CURVE_JS.replace("duration: ms", "duration: FOLD_MS")
    ramp = motion_drifts(declared, unramped, f"const MODAL_CLOSE_MS = {ms_of(declared['--move'])};\n")
    check(any("foldMoveMs(fold)" in d for d in ramp),
          f"a region fold paced by a constant instead of foldMoveMs(fold) is reported "
          f"({len(ramp)} reported)")


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
    check_tokens()
    check_motion()
    print("the scan itself:")
    check_regression()
    check_regression_tokens()
    check_regression_motion()

    if failures:
        print(f"\nui_css_check: {len(failures)} FAILED")
        return 1
    print("\nui_css_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
