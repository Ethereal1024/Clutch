"""Golden capture for the permission engine (M3: `ui/host/permission.js`).

The permission engine decides whether a tool call may run, and the answer is
contract: the model reads the refusal sentence, the UI reads the ask's reason,
and the escape list is what the user is being asked to approve. `agent/core/
permission.py` is that contract on deployment A/C; `tests/host-permission.test.js`
replays the same calls against `ui/host/permission.js`.

    .venv/bin/python -m tests.permission_capture            # write the fixture
    .venv/bin/python -m tests.permission_capture --check    # regenerate+compare

The workspace here is a STUB, and deliberately so: the judge reads the root and
the workspace's own path hooks, never the disk, so the only workspace facts the
engine reads are the root, the user's home, and the POSIX scratch trio. The stub
keeps those in PurePosixPath flavor, and the JS replay builds the same thing out
of `ui/host/fs.js` (whose `escapePath`/`normJoin`/`home` are the port of the
Python methods the engine calls).

A case is (args_repr, access, arg). `evaluate` records the verdict and the sorted
escape list; `auto_allow` records what the gate does with the same call when no
user can be asked (the eval-harness mode: a rule's ask passes, an escape does
not). The sentences are compared literally, so a reworded refusal fails here.
"""

from __future__ import annotations

import json
import posixpath
from pathlib import Path, PurePosixPath

from agent.core.permission import PermissionEvaluator, PermissionGate, PermissionRequired
from agent.tools.localshell import LocalShell
from agent.tools.workspace import POSIX_SCRATCH_DIRS, Workspace

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "permission" / "expected.json"

ROOT = "/home/u/proj"
HOME = "/home/u"

POSIX = LocalShell(argv=None, posix=True, name="posix-sh")


class FarWorkspace(Workspace):
    """A far root, lexically: nothing here touches this machine's filesystem."""

    def _root_path(self, root: str):
        return PurePosixPath(root)

    def _scratch_dirs(self):
        return tuple(PurePosixPath(s) for s in POSIX_SCRATCH_DIRS)

    def realpath(self, path):
        return PurePosixPath(posixpath.normpath(str(path).replace("\\", "/")))

    def norm_join(self, base: str, token: str):
        return PurePosixPath(posixpath.normpath(posixpath.join(str(base), str(token))))

    def home(self):
        return PurePosixPath(HOME)

    def exec_shell(self):
        return POSIX

    # the abstract file operations: this stub only answers policy questions
    def read(self, path: str) -> str:  # pragma: no cover
        raise NotImplementedError

    def read_range(self, path: str, lo: int, hi: int) -> bytes:  # pragma: no cover
        raise NotImplementedError

    def size(self, path: str) -> int:  # pragma: no cover
        raise NotImplementedError

    def write(self, path: str, content: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def append_line(self, path: str, line: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def write_at(self, path: str, offset: int, data: bytes) -> None:  # pragma: no cover
        raise NotImplementedError

    def delete(self, path: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def list(self, path: str) -> list[str]:  # pragma: no cover
        raise NotImplementedError

    def grep(
        self, pattern: str, path: str = ".", include: str | None = None
    ) -> list[tuple[str, int, str]]:  # pragma: no cover
        raise NotImplementedError


def _command(name: str, command: str) -> dict:
    return {"name": name, "args": json.dumps({"command": command}), "access": "command", "arg": ""}


def _path(name: str, access: str, value: str, arg: str = "") -> dict:
    key = arg or "path"
    return {"name": name, "args": json.dumps({key: value}), "access": access, "arg": arg}


CASES = [
    # ---- commands: the five rules, in the only order they can be told apart
    _command("plain", "ls -la"),
    _command("rm -rf /", "rm -rf /"),
    _command("rm one file", "rm notes.txt"),
    _command("rm after a semicolon", "true; rm -rf build"),
    _command("sudo", "sudo apt install curl"),
    _command("mkfs", "mkfs.ext4 /dev/sdb1"),
    _command("dd", "dd if=/dev/zero of=/dev/null"),
    _command("mv onto root", "mv a / x"),
    _command("relative escape", "cat ../../etc/passwd"),
    _command("absolute escape", "cat /etc/passwd"),
    _command("absolute INSIDE the root", f"cat {ROOT}/src/a.py"),
    _command("escape after cd", "cd src && cat ../../etc/passwd"),
    _command("cd into home then escape", "cd ~ && cat proj/x"),
    _command("cd into scratch", "cd /tmp && ls"),
    _command("redirect to scratch", "echo hi > /tmp/out.log"),
    _command("redirect in the workspace", "echo hi > out.log"),
    _command("tilde escape", "cat ~/secret"),
    _command("tilde inside home", "cat ~/proj/a.py"),
    _command("dollar HOME is not expanded", "cat $HOME/secret"),
    _command("quoted path with a space", "cat 'a b.txt'"),
    _command("unbalanced quote", "cat 'unclosed"),
    _command("empty", ""),
    _command("find with -delete", "find . -name '*.py' -delete"),
    _command("grep sweep", "grep -rn x ."),
    _command("python module", "python3 -m http.server"),
    _command("printf to a relative file", "printf '%s\\n' hi > notes.md"),
    # ---- paths: read / sweep / write, and a renamed argument
    _path("read a file", "read", "a.py"),
    _path("read upwards", "read", "../a.py"),
    _path("read an absolute path", "read", "/etc/passwd"),
    _path("read inside, absolutely", "read", f"{ROOT}/a.py"),
    _path("read a tilde", "read", "~/x"),
    _path("read scratch", "read", "/tmp/x.log"),
    _path("sweep the root", "sweep", "."),
    _path("sweep upwards", "sweep", "../"),
    _path("write a file", "write", "notes.md"),
    _path("write upwards", "write", "../notes.md"),
    _path("write an absolute path", "write", "/etc/hosts"),
    _path("write scratch", "write", "/tmp/x.log"),
    _path("write a tilde", "write", "~/x"),
    _path("write, renamed argument", "write", "../x", arg="file"),
    # ---- not a guardable access, and payloads that are not JSON
    {"name": "no access word", "args": json.dumps({"path": "../x"}), "access": "", "arg": ""},
    {"name": "unknown access word", "args": json.dumps({"path": "../x"}), "access": "other", "arg": ""},
    _command("garbage args", "{not json"),
]


# The tokenizer is the escape verdict's whole input, so it is compared directly:
# shlex.split's answer for the same text `ui/host/permission.js` splitCommand sees.
SPLIT_CASES = [
    "ls -la",
    "cat 'a b.txt'",
    'echo "quoted \\"inner\\" text"',
    "printf '%s\\n' hi",
    "cat ~/a ~/b",
    "a\\ b",
    "cat 'unclosed",
    'echo "unclosed',
    "",
    "   ",
    "''",
    '"" x',
    "one;two",
    "rm -rf build && ls",
    'echo "a\\nb"',
    'echo "a\\\\b"',
    "a\\\nb",
    "tail -c +1 f | head -c 10",
    "cat \"$HOME/x\"",
]


def _split(token: str) -> list[str] | None:
    import shlex

    try:
        return shlex.split(token)
    except ValueError:
        return None


def capture() -> dict:
    workspace = FarWorkspace(root=ROOT)
    evaluator = PermissionEvaluator()

    evaluated = []
    for case in CASES:
        action = evaluator.evaluate(case["args"], workspace, case["access"], case["arg"])
        escapes = sorted(str(p) for p in evaluator.escaped_paths(case["args"], workspace, case["access"], case["arg"]))
        evaluated.append({**case, "action": action, "escapes": escapes})

    auto = []
    for case in CASES:
        gate = PermissionGate(evaluator, auto_allow=True)
        try:
            gate.require("some_tool", case["args"], workspace, case["access"], case["arg"])
            error = None
        except PermissionRequired as e:
            error = e.reason
        auto.append({**case, "error": error})

    # The sentence the model reads when the gate cannot reach any window. Asked
    # with a plain (non-auto) gate whose on_ask says "nobody is attached" and
    # which has no attachment probe, so the refusal is final rather than timed.
    unattended = {
        "name": "no user interface",
        "args": CASES[1]["args"],
        "access": "command",
        "reason": None,
    }
    gate = PermissionGate(evaluator, on_ask=lambda *a: False)
    try:
        gate.require("run_command", CASES[1]["args"], workspace, "command")
    except PermissionRequired as e:
        unattended["reason"] = e.reason

    return {
        "workspace": {"root": ROOT, "home": HOME},
        "evaluate": evaluated,
        "auto_allow": auto,
        "unattended": unattended,
        "split": [{"command": case, "tokens": _split(case)} for case in SPLIT_CASES],
    }


def verify(fixture: dict) -> int:
    expected = json.loads(OUT.read_text("utf-8"))
    if expected != fixture:
        print("permission goldens DO NOT reproduce:")
        for key in fixture:
            if expected.get(key) != fixture[key]:
                print(f"  {key}: differs")
        return 1
    print(f"permission goldens reproduce: {len(fixture['evaluate'])} cases + "
          f"{len(fixture['auto_allow'])} auto-allow cases")
    return 0


def main(argv: list[str]) -> int:
    fixture = capture()
    if "--check" in argv:
        return verify(fixture)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
