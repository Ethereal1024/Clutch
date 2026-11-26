"""File browsing for the HTTP API: the project-picker directory listing, the
workspace tree, and the picker's one write action (new folder), against the
host's own filesystem.

The JSON shapes here are the UI's interface contract and are built in exactly
one place per shape, so the surfaces cannot drift:

  dir listing   {path, parent, entries: [{name, path, dir, link}], error}
  stat result   {path, type: "dir"|"file"|"none", error}
  tree node     {name, path, dir, link, children?}
  mkdir result  {path, error}                (error null on success)

Handler keeps only query parsing + self._json(); everything below is pure
enough to reason about from the payload alone.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .tools.workspace import Workspace

# ---- shared response contract ----


def dir_payload(path: str, parent: str | None, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The one directory-listing envelope the browsers return."""
    return {"path": path, "parent": parent, "entries": entries, "error": None}


def dir_error(message: str) -> dict[str, Any]:
    """Listing failure: HTTP 200 with a non-null error (the UI checks data.error)."""
    return {"error": message}


def entry_visible(name: str, is_dir: bool, show_hidden: bool) -> bool:
    """The one hidden-item policy for every browser surface (the picker's
    /api/fs/list and the workspace tree): with the toggle off NOTHING
    dot-prefixed is listed — file or directory. The old split (dot-dirs
    stayed in the picker so ~/.config could be clicked into) read as "the
    toggle does nothing"; a hidden directory is reached through the path input
    instead, and its non-dot children list normally once inside."""
    return show_hidden or not name.startswith(".")


# ---- project-picker directory listing (/api/fs/list) ----


def fs_list(raw: str, show_hidden: bool) -> dict[str, Any]:
    """Server-side directory browser (the UI picks projects from here).

    One level, starts at the server user's home. Reachable only via the local
    bind or the SSH tunnel, so no auth is needed.
    """
    return _fs_list_local(raw, show_hidden)


def _local_dir(raw: str) -> Path:
    """The local directory a picker request names: empty = home, relative = under
    home, resolved so the listing and a folder created from it agree on the path."""
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = Path.home() / p
        return p.resolve()
    return Path.home().resolve()


def _fs_list_local(raw: str, show_hidden: bool) -> dict[str, Any]:
    root = _local_dir(raw)
    if not root.is_dir():
        return dir_error(f"not a directory: {root}")
    try:
        listing = sorted(root.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except OSError as e:
        return dir_error(f"cannot list directory: {e}")
    entries = [
        {
            "name": e.name,
            "path": str(e),
            "dir": e.is_dir(),
            # realpath, not e.resolve(): a symlink LOOP makes Path.resolve() raise
            # RuntimeError (3.10), which would take down the whole listing over
            # one unresolvable entry. realpath hands back the loop path itself.
            "link": os.path.realpath(e) if e.is_symlink() else None,
        }
        for e in listing
        if entry_visible(e.name, e.is_dir(), show_hidden)
    ]
    parent = str(root.parent) if root.parent != root else None
    return dir_payload(str(root), parent, entries)


# ---- the path bar's one question (/api/fs/stat) ----


def stat_payload(path: str, kind: str) -> dict[str, Any]:
    """The one stat envelope.

    `type` is the whole answer the picker routes on, and it has exactly three
    values — the same three the JS host answers (ui/host/fs.js `fsStat`): a
    directory, a regular file, or `none`. Anything that is neither (a fifo, a
    socket, a broken symlink: what a local `test -f` would not match either)
    reads as `none`, because the picker can only open a project from a file.
    """
    return {"path": path, "type": kind if kind in ("dir", "file") else "none", "error": None}


def fs_stat(raw: str) -> dict[str, Any]:
    """What is at this path: a directory, a regular file, or nothing yet?

    The address bar is the picker's single surface (navigate / open / create), so
    this is the one question it asks before doing any of them. A path that is not
    there is NOT an error and never a 404: absent is the create offer, i.e. data
    in `type`. Answering 404 for it is indistinguishable from "this host has no
    such route" — which is exactly how typing a new filename came back as
    "could not check path: not found" and no file could be created.
    """
    return _fs_stat_local(raw)


def _fs_stat_local(raw: str) -> dict[str, Any]:
    # `_local_dir` resolves the parent chain without requiring the leaf to exist
    # (Path.resolve is non-strict), so the answer names the path a create would
    # produce — and the listing and the offer cannot disagree about it.
    target = _local_dir(raw)
    if target.is_dir():
        return stat_payload(str(target), "dir")
    if target.is_file():
        return stat_payload(str(target), "file")
    return stat_payload(str(target), "none")


# ---- the picker's write side: one folder ----


def valid_name(name: str) -> str | None:
    """Why `name` cannot be ONE file or folder name, or None when it can.

    One policy for the picker's create row and /api/fs/mkdir, so what the UI
    accepts is exactly what the server accepts: one path segment, no separator,
    no control character (a newline would end a listing line early and split
    one entry into two), and neither "." nor ".." — those name
    directories, not new entries.
    """
    if not name.strip():
        return "a name is required"
    if name in (".", ".."):
        return "that name is reserved"
    for ch in name:
        if ch in ("/", "\\", "\0") or ord(ch) < 32 or ord(ch) == 127:
            return "a name cannot contain a path separator or a control character"
    return None


def fs_mkdir(raw_dir: str, name: str) -> dict[str, Any]:
    """Create ONE folder inside `raw_dir` — the picker's "+ Folder" row.

    mkdir(parents=False) is the point, not an accident: the browser names a
    directory that is on screen, so a path that is not there is a stale listing,
    not an instruction to build a tree (and a recursive mkdir would let a typed
    name with a separator create a whole missing branch unchecked).
    """
    reason = valid_name(name)
    if reason is not None:
        return {"path": None, "error": reason}
    return _fs_mkdir_local(raw_dir, name)


def _fs_mkdir_local(raw_dir: str, name: str) -> dict[str, Any]:
    parent = _local_dir(raw_dir)
    target = parent / name
    try:
        target.mkdir()
    except FileExistsError:
        return {"path": str(target), "error": f"already exists: {name}"}
    except FileNotFoundError:
        return {"path": str(target), "error": f"no such directory: {parent}"}
    except OSError as e:
        return {"path": str(target), "error": f"cannot create folder: {e.strerror or e}"}
    return {"path": str(target), "error": None}


# ---- workspace tree (/api/workspace/tree) ----


def tree(ws: Workspace, expanded: list[str], show_hidden: bool) -> list:
    """The walk lists exactly what the panel shows: the root, plus every
    directory the reader has expanded. Nothing else is read."""
    return _walk(ws.root, ws, expanded, show_hidden)


def _tree_node(name: str, child_rel: str, is_dir: bool) -> dict[str, Any]:
    """One workspace-tree node: {name, path, dir, link} (link resolved by the
    local walk, which has the file system at hand)."""
    return {"name": name, "path": child_rel, "dir": is_dir, "link": None}


def _should_list(child_rel: str, expanded: set[str]) -> bool:
    """Whether a child dir gets listed now: it is one the reader has OPEN.

    There used to be a one-level lookahead on top of this (`rel in expanded` and
    `rel == ""`), so every refresh listed the contents of every top-level dir and
    of every expanded one. That is what made the walk expensive: a panel showing
    27 rows shipped 341 entries, every extra level read on the way to a tree the
    user was not looking at. The children of a dir the reader opens arrive on the
    next walk, which the toggle asks for immediately (workspace-panel.ts:
    scheduleTreeRefresh(0))."""
    return child_rel in expanded


def _walk(root: Path, workspace: Workspace, expanded: list[str], show_hidden: bool) -> list:
    """Lazy partial tree: list children only for the root and the expanded dirs, so
    opening a big project never walks the whole tree up front and a refresh never
    reads a directory nobody is looking at. show_hidden keeps dotfiles out of every
    level.

    A directory the OS refuses to list raises OSError here and the caller fails
    loudly: an unreadable directory must not be quietly rendered as an empty one
    (the picker's /api/fs/list already reports its failures through dir_error —
    one behaviour, not two)."""
    expanded = set(expanded)

    def list_entries(p: Path) -> list[Path]:
        entries = workspace.visible_entries(p)
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]
        return entries

    def build(p: Path, rel: str) -> list:
        out = []
        for e in list_entries(p):
            child_rel = str(e.relative_to(root))
            node = _tree_node(e.name, child_rel, e.is_dir())
            # the workspace hook, not e.resolve(): a symlink loop raises
            # RuntimeError there (3.10) and would kill the whole tree over one
            # entry the UI merely labels
            node["link"] = str(workspace.realpath(e)) if e.is_symlink() else None
            # symlinked dirs are shown as leaves: prevents escaping into system
            # trees and symlink cycles; the agent's tools still follow links, so
            # only the UI is affected
            if e.is_dir() and not e.is_symlink():
                if _should_list(child_rel, expanded):
                    node["children"] = build(e, child_rel)
            out.append(node)
        return out

    return build(root, "")
