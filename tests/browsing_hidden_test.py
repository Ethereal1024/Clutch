"""The show-hidden toggle must hide EVERY dot entry — files AND directories —
on every surface (picker /api/fs/list, workspace tree), on both transports.

User report (all platforms): "show hidden 不论开启还是关闭都会显示隐藏文件".
Root cause: the picker's entry_visible deliberately kept dot-DIRECTORIES
visible with the toggle off ("a way into ~/.config"), so the connection
window's file browser looked like the toggle did nothing. The unified policy
is now the file-manager standard: off = no dot entries anywhere; reaching a
hidden directory stays possible through the path input.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.browsing import entry_visible, fs_list, tree, _walk_remote
from agent.tools.workspace import LocalWorkspace, parse_ls_entries


def _make_fixture(root: Path) -> None:
    (root / ".hiddendir").mkdir()
    (root / ".hiddendir" / "inside.txt").write_text("x")
    (root / ".hiddenfile").write_text("x")
    (root / "normaldir").mkdir()
    (root / "normalfile").write_text("x")


def test_entry_visible() -> None:
    # off: nothing dot-prefixed is visible, file or dir
    assert entry_visible(".hiddenfile", False, False) is False
    assert entry_visible(".hiddendir", True, False) is False
    # on: everything is visible
    assert entry_visible(".hiddenfile", False, True) is True
    assert entry_visible(".hiddendir", True, True) is True
    # non-dot entries are always visible
    assert entry_visible("normalfile", False, False) is True
    assert entry_visible("normaldir", True, False) is True


def test_fs_list_local() -> None:
    with tempfile.TemporaryDirectory(prefix="clutch-browse-") as td:
        root = Path(td)
        _make_fixture(root)

        data = _fs_list_local(str(root), show_hidden=False)
        names = {e["name"] for e in data["entries"]}
        assert names == {"normaldir", "normalfile"}, names

        data = _fs_list_local(str(root), show_hidden=True)
        names = {e["name"] for e in data["entries"]}
        assert names == {".hiddendir", ".hiddenfile", "normaldir", "normalfile"}, names


def test_tree_walk_local() -> None:
    with tempfile.TemporaryDirectory(prefix="clutch-tree-") as td:
        root = Path(td)
        _make_fixture(root)
        ws = LocalWorkspace(str(root))

        off = tree(ws, [], show_hidden=False)
        names = {n["name"] for n in off}
        assert names == {"normaldir", "normalfile"}, names
        # opening normaldir must not leak dot entries either
        (root / "normaldir" / ".dot").write_text("x")
        off = tree(ws, ["normaldir"], show_hidden=False)
        nd = next(n for n in off if n["name"] == "normaldir")
        kids = {c["name"] for c in nd.get("children", [])}
        assert kids == set(), kids

        on = tree(ws, [], show_hidden=True)
        names = {n["name"] for n in on}
        assert names == {".hiddendir", ".hiddenfile", "normaldir", "normalfile"}, names


def test_tree_walk_lists_only_open_dirs() -> None:
    """A refresh reads the root and the dirs on screen — never one level into every
    top-level dir. That lookahead is what made a 27-row panel ship 341 entries and
    cost a remote workspace a second SSH round trip (both now removed)."""
    with tempfile.TemporaryDirectory(prefix="clutch-tree-") as td:
        root = Path(td)
        (root / "a" / "inner").mkdir(parents=True)
        (root / "a" / "inner" / "leaf.txt").write_text("x")
        (root / "a" / "one.txt").write_text("x")
        (root / "b").mkdir()
        (root / "b" / "two.txt").write_text("x")
        ws = LocalWorkspace(str(root))

        cold = tree(ws, [], show_hidden=False)
        assert {n["name"] for n in cold} == {"a", "b"}, cold
        assert all("children" not in n for n in cold), "an unopened dir is a leaf row"

        opened = tree(ws, ["a"], show_hidden=False)
        a = next(n for n in opened if n["name"] == "a")
        assert {c["name"] for c in a["children"]} == {"inner", "one.txt"}, a["children"]
        inner = next(c for c in a["children"] if c["name"] == "inner")
        assert "children" not in inner, "one level down is not guessed"
        b = next(n for n in opened if n["name"] == "b")
        assert "children" not in b, "opening one dir does not read its siblings"

        deeper = tree(ws, ["a", "a/inner"], show_hidden=False)
        a = next(n for n in deeper if n["name"] == "a")
        inner = next(c for c in a["children"] if c["name"] == "inner")
        assert {c["name"] for c in inner["children"]} == {"leaf.txt"}


def test_tree_walk_remote_batches_one_exec() -> None:
    """The remote walk asks for every dir it knows in ONE list_many: the old walk
    needed a round trip per level AND could not build level N+1's command before
    level N answered (0.3–0.9 s each on the tunnel)."""

    class FakeRemote:
        def __init__(self, tree_map: dict[str, list[str]]) -> None:
            self.tree_map = tree_map
            self.calls: list[list[str]] = []

        def list_many(self, paths: list[str]) -> dict[str, list[str]]:
            self.calls.append(list(paths))
            return {p: list(self.tree_map.get(p, [])) for p in paths}

    ws = FakeRemote({"": ["a/", "file.txt"], "a": ["inner/", "one.txt"], "a/inner": ["leaf.txt"]})
    nodes = _walk_remote(ws, ["a", "a/inner"], show_hidden=False)
    assert ws.calls == [["", "a", "a/inner"]], ws.calls
    a = next(n for n in nodes if n["name"] == "a")
    assert {c["name"] for c in a["children"]} == {"inner", "one.txt"}
    inner = next(c for c in a["children"] if c["name"] == "inner")
    assert {c["name"] for c in inner["children"]} == {"leaf.txt"}

    # a path the panel could not be showing is not handed to `ls`: not absolute,
    # not through "..", and not under a dir that is not itself open
    ws = FakeRemote({"": ["a/"]})
    _walk_remote(ws, ["../etc", "/etc", "a/b"], show_hidden=False)
    assert ws.calls == [[""]], ws.calls


def test_parse_ls_entries_dots() -> None:
    out = ".hiddendir/\n.hiddenfile\nnormaldir/\nscript*\nlink@\n"
    assert parse_ls_entries(out) == [
        (".hiddendir", True),
        (".hiddenfile", False),
        ("normaldir", True),
        ("script", False),
        ("link", False),
    ]


def _fs_list_local(raw: str, show_hidden: bool) -> dict:
    """Drive fs_list's local branch without an SSH state (backend_mode local)."""
    from agent.base import RunState

    state = RunState.__new__(RunState)  # only backend_mode/bridge_url are read
    state.backend_mode = "local"
    state.bridge_url = None
    return fs_list(state, raw, show_hidden)


if __name__ == "__main__":
    os.environ.setdefault("CLUTCH_TEST", "1")
    test_entry_visible()
    test_fs_list_local()
    test_tree_walk_local()
    test_tree_walk_lists_only_open_dirs()
    test_tree_walk_remote_batches_one_exec()
    test_parse_ls_entries_dots()
    print("All tests passed.")
