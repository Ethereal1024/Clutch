"""RemoteWorkspace must never touch the LOCAL filesystem for remote paths.

Regression for the macOS test client: Path('/home/u/p').resolve() on the app
host spelled /home through the local autofs layout (/System/Volumes/Data/home),
so create-project sent `mkdir -p '/System/...'` to the Linux remote and failed
with `mkdir: cannot create directory '/System': permission denied`. Remote
paths are normalized lexically now. The macOS rewrite is simulated by patching
Path.resolve, which makes every assertion platform-independent: the test says
nothing about the box it runs on (Linux dev machine included) and would catch
the same bug on any app host.

Run: uv run python -m tests.remote_path_test
"""

from __future__ import annotations

import re
import unittest.mock as mock
from pathlib import Path, PosixPath, PurePosixPath

from agent.project import create_project
from agent.tools.transport import CommandResult
from agent.tools.workspace import RemoteWorkspace
from tests.testsupport import check

# what the macOS app host does to a /home path (its autofs spelling of it)
_MAC_DATA_HOME = "/System/Volumes/Data/home"


def _mac_resolve(self: Path, *, strict: bool = False) -> Path:
    """Path.resolve stand-in that rewrites /home the way the macOS client's
    filesystem does during symlink/autofs traversal; other paths resolve to
    themselves. LocalWorkspace is expected to follow this rewrite (it means
    the OS), RemoteWorkspace to ignore it."""
    s = str(self)
    if s == "/home" or s.startswith("/home/"):
        s = _MAC_DATA_HOME + s[len("/home"):]
    return PosixPath(s)


def _unshq(s: str) -> str:
    """Inverse of workspace.shq for the fake's simple parsing."""
    if len(s) >= 2 and s.startswith("'") and s.endswith("'"):
        s = s[1:-1]
    return s.replace("'\\''", "'")


class FakeBridge:
    """A tiny remote sh: records every exec, stores printf-written files, and
    answers wc -c / cat / echo $HOME — just enough for create_project."""

    def __init__(self) -> None:
        self.commands: list[str] = []
        self.files: dict[str, str] = {}

    def run(
        self, command: str, timeout: float, cancel=None, *, binary: bool = False
    ) -> CommandResult:
        """`cancel` accepted for parity with the real transports (Stop kills the
        in-flight command locally; a remote exec just finishes on its own)."""
        """Exec the command, splitting sh `&&` groups like the real remote sh
        would sequence them; stop at the first failing group."""
        result = CommandResult(0, "", "")
        for frag in command.split(" && "):
            result = self._exec(frag)
            if result.code != 0:
                return result
        return result

    def _exec(self, command: str) -> CommandResult:
        self.commands.append(command)
        if command == "echo $HOME":
            return CommandResult(0, "/home/u\n", "")
        if command.startswith("mkdir -p "):
            return CommandResult(0, "", "")
        if command.startswith("wc -c < "):
            path = _unshq(command[len("wc -c < "):])
            if path not in self.files:
                return CommandResult(1, "", "no such file")
            return CommandResult(0, str(len(self.files[path])), "")
        if command.startswith("cat "):
            path = _unshq(command[len("cat "):])
            return CommandResult(0, "", "") if path not in self.files else CommandResult(0, self.files[path], "")
        m = re.fullmatch(r"printf '(%sn|%s)' '(.*)' (>|>>) '(.*)'", command, re.DOTALL)
        if m:
            chunk, op, path = _unshq(m.group(2)), m.group(3), _unshq(m.group(4))
            self.files[path] = chunk if op == ">" else self.files.get(path, "") + chunk
            return CommandResult(0, "", "")
        if "-print0 | xargs -0 grep -HnE" in command:
            # find|xargs|grep pipeline: one canned hit inside the workspace
            return CommandResult(0, "/home/u/proj/src/main.py:7:needle\n", "")
        return CommandResult(0, "", "")


def _remote_ws(root: str = "/home/u/proj") -> tuple[RemoteWorkspace, FakeBridge]:
    ws = RemoteWorkspace(root, "http://127.0.0.1:1/exec")
    bridge = FakeBridge()
    ws._transport = bridge
    return ws, bridge


def test_remote_paths_ignore_the_local_filesystem() -> None:
    """With the macOS rewrite active, remote ops still send /home paths."""
    with mock.patch.object(Path, "resolve", _mac_resolve):
        ws, bridge = _remote_ws()
        ws.write("sub/f.txt", "hello")
        check(bridge.commands[0].startswith("mkdir -p '/home/u/proj/sub'"), "write mkdirs the REMOTE spelling")
        check(all("/System" not in c for c in bridge.commands), "no /System reaches the remote")
        check(str(ws.resolve("a/../b.txt")) == "/home/u/proj/b.txt", "resolve normalizes lexically")
        check(str(ws.realpath(ws.root)) == "/home/u/proj", "root normalization is lexical")
        try:
            ws.resolve("../../etc/passwd")
            check(False, "lexical escape is still rejected")
        except ValueError:
            check(True, "lexical escape is still rejected")
        ws.run("ls", 5)
        check(
            "cd '/home/u/proj'" in bridge.commands and bridge.commands[-1] == "ls",
            "run() cds into the un-rewritten root",
        )
        ws.protect("/home/u/proj/x.clc")
        check(ws.is_protected("/home/u/proj/x.clc"), "protect round-trips without the local resolve")


def test_remote_home_is_the_remote_user() -> None:
    """`~` expands through the bridge to the REMOTE home, never expanduser's
    (app-host) home."""
    with mock.patch.object(Path, "resolve", _mac_resolve):
        ws, _ = _remote_ws()
        check(str(ws.home()) == "/home/u", "home() asks the remote over the bridge")
        check(
            ws.escape_path("~/.ssh/id_rsa") == PurePosixPath("/home/u/.ssh/id_rsa"),
            "~ expands to the REMOTE home (PurePosixPath: host-flavor independent)",
        )
        ws2, _ = _remote_ws("/home/u")
        check(ws2.escape_path("~/.ssh") is None, "~ inside the workspace root stays inside")


def test_create_project_sends_remote_paths() -> None:
    """The exact user flow that failed: create a project over ssh.

    The input is POSIX-flavored because that is what the ssh path reaches
    create_project with, on every app host: the server normalizes client paths
    through Handler._project_path, which returns PurePosixPath in ssh mode. A
    host Path would be wrong here — Path("/home/u/proj/demo") on a Windows app
    host IS WindowsPath('\\home\\u\\proj\\demo'), whose str() joins under the
    root as '/home/u/proj/\\home\\u\\proj\\demo.clc'."""
    with mock.patch.object(Path, "resolve", _mac_resolve):
        ws, bridge = _remote_ws("/home/u/proj")
        project = create_project(PurePosixPath("/home/u/proj/demo"), "demo", model="m", workspace=ws)
        check(str(project.path) == "/home/u/proj/demo.clc", "project path keeps the remote spelling")
        check(any("'/home/u/proj/demo.clc'" in c for c in bridge.commands), "header written to the remote path")
        check(all("/System" not in c for c in bridge.commands), "create_project sends no /System")


def test_lexical_behavior_needs_no_rewrite_to_kick_in() -> None:
    """No monkeypatch (plain Linux box): same verdicts — the lexical rule is
    unconditional, not a macOS-only special case."""
    ws, bridge = _remote_ws()
    ws.write("sub/f.txt", "hello")
    check(bridge.commands[0].startswith("mkdir -p '/home/u/proj/sub'"), "write mkdirs the remote root")
    check(str(ws.resolve("a/../b.txt")) == "/home/u/proj/b.txt", "resolve normalizes lexically")
    try:
        ws.resolve("../../etc/passwd")
        check(False, "escape is still rejected")
    except ValueError:
        check(True, "escape is still rejected")


def test_remote_paths_stay_in_posix_flavor() -> None:
    """Windows-host readiness: a remote Workspace must never produce a
    host-flavored Path — on Windows, Path is WindowsPath and str() re-separates
    '/' into '\\\\' in every command sent over the bridge. Type checks are exact
    (`type(...) is`), not isinstance, so no host subclass can sneak through, and
    the mixed-flavor containment check (PurePosixPath vs host Path) can no
    longer raise TypeError."""
    ws, _ = _remote_ws()
    check(type(ws.root) is PurePosixPath, "root flavor is PurePosixPath on any host")
    check(all(type(s) is PurePosixPath for s in ws._scratch_dirs()), "scratch dirs are PurePosixPath")
    # outside the root but inside a harmless scratch dir: allowed, no TypeError
    p = ws.resolve("/tmp/clutch-test.log")
    check(type(p) is PurePosixPath, "scratch-escape verdict stays PurePosixPath")
    check(str(p) == "/tmp/clutch-test.log", "scratch-escape keeps the remote spelling")
    check(ws.escape_path("a/../b.txt") is None, "relative token staying inside is not an escape")
    esc = ws.escape_path("../outside.txt")
    check(
        type(esc) is PurePosixPath and str(esc) == "/home/u/outside.txt",
        "escape verdict is lexically normalized in POSIX flavor",
    )
    check(str(ws.norm_join("/home/u/proj", "sub/../x.txt")) == "/home/u/proj/x.txt", "norm_join uses posixpath")
    check(str(ws.realpath("C:\\Users\\x\\y.clc")) == "C:/Users/x/y.clc", "realpath tolerates backslash-mangled input")


def test_remote_grep_keeps_posix_paths() -> None:
    """grep's output paths go through PurePosixPath: a host Path (WindowsPath on
    a Windows client) would re-separate them AND fail relative_to against the
    PurePosixPath root (flavor mismatch), mangling every reported path."""
    ws, _ = _remote_ws()
    hits = ws.grep("needle", "src")
    check(hits == [("src/main.py", 7, "needle")], "grep reports root-relative POSIX paths")
    check(all("\\" not in rel for rel, _, _ in hits), "no backslash reaches the reported paths")


if __name__ == "__main__":
    test_remote_paths_ignore_the_local_filesystem()
    test_remote_home_is_the_remote_user()
    test_create_project_sends_remote_paths()
    test_lexical_behavior_needs_no_rewrite_to_kick_in()
    test_remote_paths_stay_in_posix_flavor()
    test_remote_grep_keeps_posix_paths()
    print("remote_path_test: all checks passed")
