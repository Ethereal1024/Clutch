"""Release graph: a tag push publishes every artifact or it publishes nothing.

Why this exists. 0.1.51 and 0.1.52 went out with an APK + 16 pylibs tars and NO
desktop package at all. The desktop job died on the UI font scan; the phone
chain (pylibs-matrix -> pylibs-index -> android-apk) listed no `needs:` on it,
so it ran in parallel, passed, and attached its assets to the same release. The
result is a release that looks complete from the phone's side and is empty from
the desktop's — and the tag is already pushed, so it cannot be withdrawn.

The graph in .github/workflows/release.yml is therefore a contract:
  * `verify` is the single gate — the font / stylesheet / launcher-icon scans —
    and it installs nothing, so it cannot fail for a dependency reason and
    costs seconds;
  * every job that attaches assets (any `softprops/action-gh-release` step)
    transitively needs `verify`, so a rejected tree reaches no release;
  * the phone chain also needs `deb` itself, so a failed desktop BUILD stops the
    tars and the APK too, not just a failed scan.
  * the page a release gets says what changed, from ONE source: the tag's own
    note. `deb` is the job that CREATES the release, so it is the one that hands
    the note over (`body_path`); every other leg attaches files with no body, and
    the action keeps what is already there (`body = workflowBody || existingReleaseBody`).

Checks (offline, stdlib only — a runner executes them with bare python3):
  1. `verify` exists and runs every offline scan (fonts, stylesheets, launcher
     icon, the execution layer, this graph)
  2. `verify` installs no package (no uv sync / npm ci / pip install)
  3. every attaching job transitively needs `verify`
  4. the phone chain (pylibs-index, android-apk) transitively needs `deb`
  5. `deb` reads the release note from the tag and attaches it as `body_path`,
     so a release page cannot go out blank
  6. the parsing itself: the pre-fix graph (phone chain with no `needs:`), a
     missing scan, a package install in `verify`, and a body-less release are all
     reported

Run: python3 -m tests.release_graph_check
"""

from __future__ import annotations

import re
from pathlib import Path

from tests.testsupport import collecting_check

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"

# A job key is a 2-space-indented `name:` line. Steps sit at 6 spaces, `with:`
# keys deeper still, and a `run: |` body deeper again, so nothing else in the
# file can be mistaken for a job.
JOB = re.compile(r"^  ([A-Za-z0-9_-]+):[ \t]*$")
TOP = re.compile(r"^[A-Za-z]")
NEEDS_BLOCK_ITEM = re.compile(r"^      -[ \t]*([A-Za-z0-9_-]+)[ \t]*$")

ATTACH = "softprops/action-gh-release"
SCANS = ("tests.ui_fonts_check", "tests.ui_css_check", "tests.android_icon_check",
         "tests.exec_layer_test")
INSTALLS = ("uv sync", "npm ci", "npm install", "pip install", "yarn install")

VERIFY, DEB = "verify", "deb"
PHONE = ("pylibs-index", "android-apk")

check, failures = collecting_check()


class Job:
    """One job block: its `needs:` list and the raw text of everything under it."""

    def __init__(self, name: str, body: str) -> None:
        self.name = name
        self.body = body
        self.needs = needs_of(body)

    @property
    def attaches(self) -> bool:
        return ATTACH in self.body


def needs_of(body: str) -> list[str]:
    """The `needs:` list, in any of the three spellings the file may use:
    `needs: deb`, `needs: [verify, deb]`, or a block list."""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if not re.match(r"^    needs:[ \t]*", line):
            continue
        inline = line.split("needs:", 1)[1].strip()
        if inline.startswith("["):
            return [w.strip().strip("'\"") for w in inline.strip("[]").split(",") if w.strip()]
        if inline:
            return [inline.strip("'\"")]
        out = []
        for follow in lines[i + 1:]:
            m = NEEDS_BLOCK_ITEM.match(follow)
            if not m:
                break
            out.append(m.group(1))
        return out
    return []


def parse(text: str) -> dict[str, Job]:
    jobs: dict[str, Job] = {}
    current: str | None = None
    buf: list[str] = []
    in_jobs = False
    for line in text.splitlines():
        if TOP.match(line):
            in_jobs = line.startswith("jobs:")
            if current is not None:
                jobs[current] = Job(current, "\n".join(buf))
                current, buf = None, []
            continue
        if not in_jobs:
            continue
        m = JOB.match(line)
        if m:
            if current is not None:
                jobs[current] = Job(current, "\n".join(buf))
            current, buf = m.group(1), []
            continue
        if current is not None:
            buf.append(line)
    if current is not None:
        jobs[current] = Job(current, "\n".join(buf))
    return jobs


def reaches(jobs: dict[str, Job], start: str, target: str) -> bool:
    """True when `target` is a (transitive) `needs:` ancestor of `start`."""
    seen: set[str] = set()
    stack = list(jobs[start].needs) if start in jobs else []
    while stack:
        name = stack.pop()
        if name == target:
            return True
        if name in seen or name not in jobs:
            continue
        seen.add(name)
        stack.extend(jobs[name].needs)
    return False


def installed(body: str) -> list[str]:
    """Which install commands the job actually RUNS.

    A YAML comment is not a command: `verify` explains at length what it must
    not do (that is how a reader learns the rule), and a scan of the raw body
    reported that explanation as the violation — "`verify` installs packages
    (npm install)". Comment lines are dropped first; what is left is the job.
    """
    code = "\n".join(line for line in body.splitlines() if not line.lstrip().startswith("#"))
    return [word for word in INSTALLS if word in code]


def problems(jobs: dict[str, Job]) -> list[str]:
    """Every way the graph breaks the contract above, as human sentences."""
    out: list[str] = []
    if VERIFY not in jobs:
        out.append(f"no `{VERIFY}` job: nothing gates the release")
    else:
        for module in SCANS:
            if module not in jobs[VERIFY].body:
                out.append(f"`{VERIFY}` does not run {module}")
        installed_words = installed(jobs[VERIFY].body)
        if installed_words:
            out.append(f"`{VERIFY}` installs packages ({', '.join(installed_words)}): "
                       "it must stay dependency-free")
    for job in jobs.values():
        if job.attaches and not reaches(jobs, job.name, VERIFY):
            out.append(f"`{job.name}` attaches assets without needing `{VERIFY}`: "
                       "a rejected tree can still be published")
    for name in PHONE:
        if name in jobs and not reaches(jobs, name, DEB):
            out.append(f"`{name}` does not need `{DEB}`: a broken desktop build "
                       "still publishes the phone chain")
    creator = jobs.get(DEB)
    if creator is not None and creator.attaches:
        if "git tag -l --format='%(contents)'" not in creator.body:
            out.append(f"`{DEB}` does not read the release note from the tag: the "
                       "page would be a second copy of the notes, or blank")
        if "body_path:" not in creator.body:
            out.append(f"`{DEB}` attaches the release with no `body_path`: the page "
                       "goes out saying nothing")
    return out


def check_graph(text: str, label: str) -> None:
    found = problems(parse(text))
    check(not found, f"{label}: " + ("; ".join(found) if found else "graph is atomic"))


def check_scan_runs(jobs: dict[str, Job]) -> None:
    """The gate must actually gate: each scan is a `run:` that the job executes."""
    body = jobs[VERIFY].body
    for module in SCANS:
        check(re.search(r"^\s*run: .*-\s*m\s*" + re.escape(module), body, re.M) is not None,
              f"{VERIFY} executes `python3 -m {module}`")
    check(not installed(body),
          f"{VERIFY} needs no uv/npm/pip step")


def check_regression(text: str) -> None:
    """The checker has to CATCH the incident it exists for — a scan that only
    ever sees a good file proves nothing."""
    fixed = parse(text)
    check(not problems(fixed), "the shipped workflow passes")

    # 1. the pre-fix shape: the phone chain starts in parallel with the desktop
    unlinked = re.sub(r"    needs: \[verify, deb\]\n", "", text)
    check(unlinked != text, "regression fixture: phone chain linking is removable")
    check(any("does not need `deb`" in p for p in problems(parse(unlinked))),
          "a phone chain with no `needs:` on deb is reported")

    # 2. a gate that lost one of its scans
    dropped = re.sub(r"^\s*- name: Verify UI stylesheets\n\s*run: .*\n", "", text, flags=re.M)
    check(dropped != text, "regression fixture: the stylesheet scan is removable")
    check(any("tests.ui_css_check" in p for p in problems(parse(dropped))),
          "a `verify` missing the stylesheet scan is reported")

    # 3. a gate that grew a dependency install (slow, and can fail for reasons
    #    that have nothing to do with the tree being released)
    fattened = text.replace("      - name: Verify UI fonts\n",
                            "      - name: Verify UI fonts\n"
                            "      - run: uv sync\n", 1)
    check(fattened != text, "regression fixture: a step can be added to verify")
    check(any("installs packages" in p for p in problems(parse(fattened))),
          "a `verify` that installs packages is reported")

    # 4. …but prose is not a command: `verify` explains what it must never do,
    #    and that explanation is not a violation. (It was one until the scan
    #    learned to drop comment lines — "npm install" inside a `#` note about
    #    the APK job reported the shipped workflow as installing packages.)
    noted = text.replace("      - name: Verify UI fonts\n",
                         "      # never run npm ci or uv sync here\n"
                         "      - name: Verify UI fonts\n", 1)
    check(noted != text, "regression fixture: a comment can be added to verify")
    check(not problems(parse(noted)), "a comment naming an install is not an install")

    # 6. a release page that says nothing: the body is dropped, and with it the
    #    tag's note the page was supposed to show
    blank = re.sub(r"^ +body_path: .*\n", "", text, flags=re.M)
    check(blank != text, "regression fixture: the release body is removable")
    check(any("body_path" in p for p in problems(parse(blank))),
          "a release that hands over no body is reported")

    # 7. …and a body from somewhere else is still not the tag's note
    paraphrased = text.replace('git tag -l --format=\'%(contents)\' "$GITHUB_REF_NAME"',
                               'git log -1 --format=%B > "$RUNNER_TEMP/release-notes.md"')
    check(paraphrased != text, "regression fixture: the tag read is replaceable")
    check(any("does not read the release note from the tag" in p
              for p in problems(parse(paraphrased))),
          "a release note written a second time is reported")


def main() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    jobs = parse(text)
    print("release job graph:", " ".join(sorted(jobs)))
    print("jobs that attach assets:", " ".join(sorted(j.name for j in jobs.values() if j.attaches)))
    print("what every attach reaches:")
    check_graph(text, "release.yml")
    print("the gate itself:")
    check_scan_runs(jobs)
    print("the scan itself:")
    check_regression(text)

    if failures:
        print(f"\nrelease_graph_check: {len(failures)} FAILED")
        return 1
    print("\nrelease_graph_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
