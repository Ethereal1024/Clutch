"""The show-hidden toggle must hide EVERY dot entry — files AND directories —
on every surface (picker /api/fs/list, workspace tree), on both transports.

User report (all platforms): "show hidden 不论开启还是关闭都会显示隐藏文件".
Root cause: the picker's entry_visible deliberately kept dot-DIRECTORIES
visible with the toggle off ("a way into ~/.config"), so the connection
window's file browser looked like the toggle did nothing. The unified policy
is now the file-manager standard: off = no dot entries anywhere; reaching a
hidden directory stays possible through the path input.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.browsing import entry_visible, fs_list, tree
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
        # the one-level lookahead into normaldir must not leak dot entries either
        (root / "normaldir" / ".dot").write_text("x")
        off = tree(ws, ["normaldir"], show_hidden=False)
        nd = next(n for n in off if n["name"] == "normaldir")
        kids = {c["name"] for c in nd.get("children", [])}
        assert kids == set(), kids

        on = tree(ws, [], show_hidden=True)
        names = {n["name"] for n in on}
        assert names == {".hiddendir", ".hiddenfile", "normaldir", "normalfile"}, names


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
    test_parse_ls_entries_dots()
    print("All tests passed.")
