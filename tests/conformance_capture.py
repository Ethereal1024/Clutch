"""M0 of docs/ssh-scheme-plan.md: capture the /api/* seam as golden fixtures.

A, C and B render the SAME renderer. A and C answer it over HTTP from the Python
host; B (after the plan) answers the same routes in-process from the JS host. The
only thing the two bodies must agree on is therefore the payload contract, and a
contract nobody wrote down drifts. This script writes it down.

What it does, in one sentence: boot the real Python `local` host (the same
`build()` tests/server_test.py boots), drive the §5 endpoints over real HTTP
against a fixed fixture tree, and record every status code and body into
tests/fixtures/conformance/*.json — deterministically, so the same run twice is
byte-identical.

Determinism is the whole value. A capture that depends on the temp directory, the
user's name or the host's home listing cannot be compared against anything, so:
  * the fixture tree is built from literal strings below (no repo content),
  * the temporary root, the home dir and the temp dir are replaced by <ROOT>,
    <HOME>, <TMP> before anything is written,
  * the one case whose body is a machine-dependent listing (/api/fs/list with no
    path) records its SHAPE and masks the entries,
  * every case is dumped with sorted keys, so a dict-order change is not a diff.
  * the SSE frames are produced by the real encoder (`EventsMixin._write_sse`)
    from events built with a fixed timestamp and id (the defaults are time() and
    uuid4 — the one place a frame would otherwise never repeat).

What it does NOT cover, on purpose: a run's own event stream (that needs an LLM
and is M2's exit), the four tools' frozen text (tests/conform.test.js drives them
against the component), and symlink marking (tests/server_test.py
_check_symlink_marking; a symlink target is an absolute path that Windows cannot
create, so it cannot be a cross-host golden).

M0 exit (plan §6): every row of §5 has a golden, two captures are byte-identical,
and every endpoint carries its `pending` marker — `pending` means the JS host has
not implemented it yet, and the set shrinking to empty is a M4 exit criterion.

Run:
    python -m tests.conformance_capture            # (re)write the goldens
    python -m tests.conformance_capture --check    # verify they reproduce
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

from agent.api.events import EventsMixin
from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.events import StateUpdateEvent, UserMessageEvent
from agent.server import build

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "conformance"

# ---- the wire tokens that replace machine-specific text --------------------

ROOT_TOKEN = "<ROOT>"
HOME_TOKEN = "<HOME>"
TMP_TOKEN = "<TMP>"

# ---- the fixture tree ------------------------------------------------------
# Literal, small, and ordered so the tree walk's sort rule is visible: dirs
# before files, case-insensitive by name. `.hidden.txt` exists to pin the hidden
# filter, `gamma.txt` is the file the journal rollback DELETES (a creation).

FIXTURE_FILES = {
    "alpha.txt": "alpha\nbeta\ngamma\n",
    "gamma.txt": "created by task two\n",
    "sub/beta.md": "# beta\n\nfixed\n",
    "sub/deep/leaf.txt": "leaf\n",
    ".hidden.txt": "hidden\n",
}
PROJECT_NAME = "demo"

# ---- the two journal anchors ----------------------------------------------
# Log offsets, not line numbers: any integer would do, but two distinct values
# pin `rollback_anchors` returning them ASCENDING (a set, ordered).
ANCHOR_A = 1024
ANCHOR_B = 4096

_UNSET = object()


# ---- endpoint table -------------------------------------------------------
# One row per §5 entry (plus the lifecycle routes api.js needs in M4). The
# `status` is the JS-side enforcement state, NOT the Python side's: Python is
# the reference, so every row starts `pending` and each milestone flips its own.

ENDPOINTS = [
    ("workspace.tree", "GET /api/workspace/tree", "workspace_tree.json", "M1"),
    ("workspace.revert", "POST /api/workspace/revert", "workspace_revert.json", "M1"),
    ("workspace.checkpoints", "GET /api/workspace/checkpoints", "workspace_checkpoints.json", "M1"),
    ("workspace.rollback", "POST /api/workspace/rollback", "workspace_rollback.json", "M1"),
    ("fs.list", "GET /api/fs/list", "fs_list.json", "M1"),
    ("sse.frames", "(SSE encoder, in-process)", "sse_frames.json", "M2"),
    ("project.lifecycle", "POST /api/project/{new,open}", "project_lifecycle.json", "M4"),
    ("history", "GET /api/history", "history.json", "M4"),
    ("routing", "GET|POST <unknown route>", "routing.json", "M1"),
]


class Normalizer:
    """Replace the machine-specific prefixes of every string in a payload.

    Longest prefix first: on POSIX the temp dir contains the workspace root, so
    <TMP> must not be applied before <ROOT>. Both the path as created and its
    realpath are registered (macOS: `mkdtemp` says /var/folders/... while
    `resolve()` says /private/var/folders/...).
    """

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs = sorted(((p, t) for p, t in pairs if p), key=lambda pt: -len(pt[0]))

    def text(self, value: str) -> str:
        for prefix, token in self.pairs:
            if prefix in value:
                value = value.replace(prefix, token)
        return value

    def value(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(v) for v in value]
        if isinstance(value, dict):
            return {k: self.value(v) for k, v in value.items()}
        return value


def _mask(obj: dict, keys: tuple[str, ...]) -> dict:
    """Replace machine-dependent fields with their TYPE (never their length: a
    home listing differs between runs, and a length would too)."""
    for key in keys:
        if key in obj:
            v = obj[key]
            kind = "list" if isinstance(v, list) else type(v).__name__
            obj[key] = {"__masked__": kind}
    return obj


def _http(base: str, method: str, path: str, data: bytes | None) -> tuple[int, str]:
    req = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"}, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


class Capture:
    """Drive one endpoint and append the case to its list."""

    def __init__(self, base: str, norm: Normalizer, tokens: dict[str, str]) -> None:
        self.base = base
        self.norm = norm
        self.tokens = tokens  # {"root": "<ROOT>", ...} for the stored route
        self.real = tokens  # replaced below with the real values for the request
        self.cases: dict[str, list[dict]] = {}

    def bind(self, **kw: str) -> None:
        """The real values behind the placeholders in a route template."""
        self.real = dict(self.real, **{k: str(v) for k, v in kw.items()})

    def route(self, template: str) -> str:
        return template.format(**{k: quote(v) for k, v in self.real.items()})

    def call(
        self,
        endpoint: str,
        cid: str,
        method: str,
        template: str,
        *,
        body=_UNSET,
        raw: bytes | None = None,
        ndjson: bool = False,
        mask: tuple[str, ...] = (),
        note: str = "",
    ) -> None:
        data = raw if raw is not None else (None if body is _UNSET else json.dumps(body).encode())
        status, text = _http(self.base, method, self.route(template), data)
        # the stored route carries the tokens, not the machine's paths
        stored = template
        for key in self.tokens:
            stored = stored.replace("{" + key + "}", self.tokens[key])
        case: dict = {"id": cid, "method": method, "path": stored}
        if raw is not None:
            case["request"] = {"raw": raw.decode("utf-8", errors="replace")}
        elif body is not _UNSET:
            case["request"] = self.norm.value(body)
        case["status"] = status
        if ndjson:
            lines = [json.loads(line) for line in text.splitlines() if line.strip()]
            case["ndjson"] = self.norm.value(lines)
        else:
            try:
                payload = json.loads(text)
            except ValueError:  # a frame or a non-JSON body: keep the text
                case["body"] = self.norm.text(text)
            else:
                case["body"] = _mask(self.norm.value(payload), mask) if mask else self.norm.value(payload)
        if mask:
            case["masked"] = list(mask)
        if note:
            case["note"] = note
        self.cases.setdefault(endpoint, []).append(case)


# ---- scenarios ------------------------------------------------------------


def _no_project(cap: Capture) -> None:
    """Before anything is open: the three answers a fresh window gets."""
    cap.call("workspace.tree", "tree.no-workspace", "GET", "/api/workspace/tree")
    cap.call("workspace.checkpoints", "checkpoints.no-workspace", "GET", "/api/workspace/checkpoints")
    cap.call("workspace.revert", "revert.no-workspace", "POST", "/api/workspace/revert", body={"path": "alpha.txt"})
    cap.call("workspace.rollback", "rollback.no-workspace", "POST", "/api/workspace/rollback", body={"offset": 0})
    cap.call("history", "history.no-project", "GET", "/api/history")


def _write_fixture(root: Path) -> None:
    for rel, text in FIXTURE_FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        # newline="\n": the workspace's byte-addressed files must not be
        # rewritten by the platform's newline translation
        with p.open("w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)


def _fresh_project(cap: Capture, state: RunState, root: Path) -> Path:
    """Create + open the project over the real endpoints, and return its .clc."""
    _write_fixture(root)
    cap.bind(root=root)
    cap.call("project.lifecycle", "project.new.ok", "POST", "/api/project/new",
             body={"dir": str(root), "name": PROJECT_NAME})
    clc = root / f"{PROJECT_NAME}.clc"
    cap.call("project.lifecycle", "project.new.missing-name", "POST", "/api/project/new",
             body={"dir": str(root)}, note="dir and name are required")
    cap.bind(root=root, clc=clc)
    cap.call("project.lifecycle", "project.open.ok", "POST", "/api/project/open",
             body={"path": str(clc)}, ndjson=True,
             note="NDJSON: meta, then {count, older}, then one {offset, event} per"
                  " resident record (none in a fresh project), then {done}")
    assert state.workspace is not None and state.project is not None, "project did not open"
    return clc


def _fixture_cases(cap: Capture, state: RunState, root: Path, clc: Path) -> None:
    """The tree, the browser and the guards, on a project that has not run yet."""
    cap.call("workspace.tree", "tree.root", "GET", "/api/workspace/tree",
             note="dirs before files, case-insensitive; .hidden.txt filtered; the"
                  " .clc is NOT yet protected (protection is set at run start)")
    cap.call("workspace.tree", "tree.hidden", "GET", "/api/workspace/tree?hidden=1")
    cap.call("workspace.tree", "tree.expanded", "GET", "/api/workspace/tree?expanded=sub",
             note="an OPEN dir lists its children; an unopened one stays a leaf row"
                  " (no lookahead: a refresh reads only the root and the open dirs)")

    cap.call("fs.list", "fs.list.dir", "GET", "/api/fs/list?path={root}")
    cap.call("fs.list", "fs.list.not-a-directory", "GET", "/api/fs/list?path={root}/alpha.txt",
             note="HTTP 200 with a non-null error, not a 4xx")
    cap.call("fs.list", "fs.list.unknown-path", "GET", "/api/fs/list?path=/nonexistent_clutch_xyz")
    cap.call("fs.list", "fs.list.home", "GET", "/api/fs/list", mask=("entries", "parent"),
             note="default root is the server user's home; the listing itself is"
                  " machine-dependent, so only its shape is frozen")

    cap.call("workspace.checkpoints", "checkpoints.fresh", "GET", "/api/workspace/checkpoints",
             note="a project with no recorded mutation has no anchor to offer")

    cap.call("workspace.revert", "revert.no-snapshot", "POST", "/api/workspace/revert",
             body={"path": "alpha.txt"})
    cap.call("workspace.revert", "revert.escape", "POST", "/api/workspace/revert",
             body={"path": "../escape"})
    cap.call("workspace.revert", "revert.no-path", "POST", "/api/workspace/revert",
             body={}, note="no path and no workspace share one answer")
    cap.call("workspace.revert", "revert.bad-json", "POST", "/api/workspace/revert", raw=b"{")

    cap.call("workspace.rollback", "rollback.no-record", "POST", "/api/workspace/rollback",
             body={"offset": 1})
    for cid, bad in (("missing", _UNSET), ("negative", -1), ("boolean", True), ("string", "12")):
        cap.call("workspace.rollback", f"rollback.bad-offset-{cid}", "POST", "/api/workspace/rollback",
                 body={} if bad is _UNSET else {"offset": bad})
    cap.call("workspace.rollback", "rollback.bad-json", "POST", "/api/workspace/rollback", raw=b"null",
             note="`null` parses but is not an object -> the same 400 as malformed JSON")

    cap.call("routing", "routing.unknown-get", "GET", "/api/nope")
    cap.call("routing", "routing.unknown-post", "POST", "/api/nope", body={})


def _protected_cases(cap: Capture, state: RunState, clc: Path) -> None:
    """After a run has claimed the project: the .clc leaves the tree."""
    ws = state.workspace
    assert ws is not None
    ws.protect(clc)  # exactly what BaseServer.start_task does for every run
    cap.call("workspace.tree", "tree.protected", "GET", "/api/workspace/tree")
    cap.call("workspace.revert", "revert.protected", "POST", "/api/workspace/revert",
             body={"path": clc.name})


def _journal_cases(cap: Capture, state: RunState, root: Path, clc: Path) -> None:
    """The journal: what undo and whole-task rollback answer once it has content."""
    ws = state.workspace
    assert ws is not None
    alpha, beta, gamma = root / "alpha.txt", root / "sub" / "beta.md", root / "gamma.txt"

    # the per-file undo stack is seeded through the public API — the same call
    # the write_file/edit_file tools make before an overwrite
    ws.snapshot(alpha, "alpha\n")
    cap.call("workspace.revert", "revert.ok", "POST", "/api/workspace/revert",
             body={"path": "alpha.txt"})

    ws.begin_turn(ANCHOR_A)
    ws.record_mutation(alpha, True, FIXTURE_FILES["alpha.txt"])
    ws.begin_turn(ANCHOR_B)
    ws.record_mutation(gamma, False)
    ws.record_mutation(beta, True, FIXTURE_FILES["sub/beta.md"])
    cap.call("workspace.checkpoints", "checkpoints.anchors", "GET", "/api/workspace/checkpoints")

    cap.call("workspace.rollback", "rollback.ok", "POST", "/api/workspace/rollback",
             body={"offset": ANCHOR_A},
             note="restored newest-first; a creation the journal recorded is DELETED")

    # guards: the journal is left untouched by both refusals
    ws.begin_turn(ANCHOR_B)
    ws.record_mutation(alpha, True, "x")
    # a run in flight: the slot is a LEASE, claimed through the call the host's
    # own POST /api/run/state uses (there is no settable flag to fake it with)
    claimed = state.claim_run(str(state.project.path))
    assert claimed == "", f"the run slot is free here, not {claimed}"
    try:
        cap.call("workspace.rollback", "rollback.run-active", "POST", "/api/workspace/rollback",
                 body={"offset": ANCHOR_B})
    finally:
        state.release_run(str(state.project.path))

    cap.bind(root=root, clc=clc)
    cap.call("project.lifecycle", "project.open.read-only", "POST", "/api/project/open",
             body={"path": str(clc), "read_only": True}, ndjson=True)
    cap.call("workspace.rollback", "rollback.read-only", "POST", "/api/workspace/rollback",
             body={"offset": ANCHOR_B},
             note="the read-only refusal is checked BEFORE the journal, so it needs no anchor")


def _sse_frames() -> list[dict]:
    """The two frame shapes, through the real encoder.

    Durable records are wrapped `{offset, event}` (the offset is the .clc byte
    offset the replay sends and the renderer keeps as its watermark); deltas and
    host-made announcements are the bare event JSON. Both are `data: ...\\n\\n`.
    """

    class Sink:
        def __init__(self) -> None:
            self.wfile = io.BytesIO()

    def grab(cid: str, fn, note: str = "") -> dict:
        sink = Sink()
        fn(sink)
        case = {"id": cid, "frame": sink.wfile.getvalue().decode("utf-8")}
        if note:
            case["note"] = note
        return case

    fixed = {"timestamp": 1700000000.0, "id": "000000000000"}
    return [
        grab(
            "sse.transient.state-update",
            lambda s: EventsMixin._write_sse(
                s, StateUpdateEvent(key="execution_status", value="idle", **fixed)
            ),
            "transient: no log offset -> the bare event JSON",
        ),
        grab(
            "sse.durable.user-message",
            lambda s: EventsMixin._write_sse(
                s, UserMessageEvent(content="fixed task", **fixed), offset=ANCHOR_B
            ),
            "durable: an explicit offset -> {offset, event}",
        ),
        grab("sse.raw.history", lambda s: EventsMixin._write_sse_raw(s, {"type": "history", "older": ANCHOR_A})),
        grab("sse.raw.replayed", lambda s: EventsMixin._write_sse_raw(s, {"type": "replayed", "count": 3})),
        grab(
            "sse.raw.resync",
            lambda s: EventsMixin._write_sse_raw(s, {"type": "resync"}),
            "the window's offset is past this log: start the pane over",
        ),
    ]


# ---- assembly -------------------------------------------------------------


def capture() -> dict[str, list[dict]]:
    """Run every scenario and return {endpoint id: [case, ...]}."""
    with tempfile.TemporaryDirectory(prefix="conform-") as sdir:
        root = Path(sdir) / "work"
        root.mkdir()
        home = Path.home()
        tmp = Path(tempfile.gettempdir())
        pairs = [
            (str(root), ROOT_TOKEN),
            (str(root.resolve()), ROOT_TOKEN),
            (str(sdir), TMP_TOKEN),
            (str(Path(sdir).resolve()), TMP_TOKEN),
            (str(home), HOME_TOKEN),
            (str(home.resolve()), HOME_TOKEN),
            (str(tmp), TMP_TOKEN),
            (str(tmp.resolve()), TMP_TOKEN),
        ]
        norm = Normalizer(pairs)
        tokens = {"root": ROOT_TOKEN, "home": HOME_TOKEN, "clc": ROOT_TOKEN + "/" + PROJECT_NAME + ".clc"}

        config = Config(port=0)  # 0 = the OS picks; build() publishes the real port
        broadcaster, state = Broadcaster(), RunState()
        srv = build(config, broadcaster, state)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{config.port}"
        cap = Capture(base, norm, tokens)
        cap.bind(root=root, home=home)
        try:
            _no_project(cap)
            clc = _fresh_project(cap, state, root)
            _fixture_cases(cap, state, root, clc)
            _protected_cases(cap, state, clc)
            _journal_cases(cap, state, root, clc)
        finally:
            srv.shutdown()
            srv.server_close()

    cap.cases["sse.frames"] = _sse_frames()
    return cap.cases


def documents(cases: dict[str, list[dict]]) -> dict[str, str]:
    """The files to write: one per endpoint + the manifest. Returns {name: text}."""
    # The `status` is a JS-SIDE fact (`ui/host/api.js` answers this route or it
    # does not), so a capture must not reset it: re-running this script after M1
    # flipped five endpoints must not quietly turn them back to `pending`. Only
    # the marker is preserved; everything captured from the Python host (cases,
    # routes, files) is regenerated from scratch.
    existing: dict[str, str] = {}
    previous = OUT / "manifest.json"
    if previous.exists():
        try:
            for row in json.loads(previous.read_text(encoding="utf-8")).get("endpoints", []):
                existing[str(row.get("id"))] = str(row.get("status", "pending"))
        except (ValueError, OSError, TypeError):
            existing = {}
    manifest_endpoints = []
    files: dict[str, str] = {}
    for eid, route, filename, owner in ENDPOINTS:
        rows = cases.get(eid) or []
        if not rows:
            raise SystemExit(f"capture produced no cases for {eid}")
        files[filename] = _dump({"endpoint": eid, "route": route, "cases": rows})
        manifest_endpoints.append(
            {
                "id": eid,
                "route": route,
                "file": filename,
                "status": existing.get(eid, "pending"),
                "owner": owner,
                "cases": [row["id"] for row in rows],
            }
        )
    files["manifest.json"] = _dump(
        {
            "format": 1,
            "source": "the Python `local` host (agent/server.py build()), deployment A/C",
            "generated_by": "tests/conformance_capture.py",
            "version": (HERE.parent / "VERSION").read_text(encoding="utf-8").strip(),
            "normalizations": [TMP_TOKEN, ROOT_TOKEN, HOME_TOKEN],
            "comparison": (
                "status equals and the body's canonical JSON (sorted keys) is equal; "
                "`masked` fields are compared by type only; `pending` endpoints are "
                "not compared until the JS host answers them"
            ),
            "endpoints": manifest_endpoints,
        }
    )
    return files


def _dump(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write(files: dict[str, str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")


def verify(files: dict[str, str]) -> int:
    """Two-capture determinism, without writing: every file must already match."""
    bad = 0
    for name, text in sorted(files.items()):
        p = OUT / name
        if not p.exists():
            print(f"missing: {name}")
            bad += 1
            continue
        if p.read_text(encoding="utf-8") != text:
            print(f"differs: {name}")
            bad += 1
    extra = sorted(set(p.name for p in OUT.glob("*.json")) - set(files)) if OUT.exists() else []
    for name in extra:
        print(f"stale:   {name}")
        bad += 1
    if bad:
        return 1
    print(f"conformance goldens reproduce: {len(files)} files byte-identical")
    return 0


def main(argv: list[str]) -> int:
    files = documents(capture())
    if "--check" in argv:
        return verify(files)
    write(files)
    total = sum(text.count('"id": "') for text in files.values())
    print(f"wrote {OUT.relative_to(HERE.parent)}: {len(files)} files, {total} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
