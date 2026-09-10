"""File browsing for the HTTP API: the project-picker directory listing and
the workspace tree, over both transports (local iterdir / SSH remote `ls`).

The JSON shapes here are the UI's interface contract and are built in exactly
one place per shape, so the local and remote implementations cannot drift:

  dir listing   {path, parent, entries: [{name, path, dir, link}], error}
  tree node     {name, path, dir, link, children?}

Handler keeps only query parsing + self._json(); everything below is pure
enough to reason about from the payload alone.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import RunState
from .tools.transport import SshTransport
from .tools.workspace import RemoteWorkspace, Workspace, parse_ls_entries, shq

# per-exec timeout for remote directory browsing (one ls / echo $HOME over the bridge)
_FS_LIST_TIMEOUT = 30.0


# ---- shared response contract ----


def dir_payload(path: str, parent: str | None, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The one directory-listing envelope both transports return."""
    return {"path": path, "parent": parent, "entries": entries, "error": None}


def dir_error(message: str) -> dict[str, Any]:
    """Listing failure: HTTP 200 with a non-null error (the UI checks data.error)."""
    return {"error": message}


def entry_visible(name: str, is_dir: bool, show_hidden: bool) -> bool:
    """The one hidden-item policy for the directory browser: dot-FILES are
    filtered when hidden entries are off, dot-DIRECTORIES stay listed — the
    browser needs a way into ~/.config-style directories. Both transports call
    this, so a local listing and a remote listing of the same directory agree
    (the local list used to hide dot-dirs and had drifted from the remote)."""
    return show_hidden or is_dir or not name.startswith(".")


# ---- project-picker directory listing (/api/fs/list) ----


def fs_list(state: RunState, raw: str, show_hidden: bool) -> dict[str, Any]:
    """Server-side directory browser (the UI picks projects from here).

    One level, starts at the server user's home (or the SSH remote's home in
    degradation mode). Reachable only via the local bind or the SSH tunnel, so
    no auth is needed.
    """
    if state.backend_mode == "ssh" and state.bridge_url:
        return _fs_list_remote(state, raw, show_hidden)
    return _fs_list_local(raw, show_hidden)


def _fs_list_local(raw: str, show_hidden: bool) -> dict[str, Any]:
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = Path.home() / p
        root = p.resolve()
    else:
        root = Path.home().resolve()
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
            "link": str(e.resolve()) if e.is_symlink() else None,
        }
        for e in listing
        if entry_visible(e.name, e.is_dir(), show_hidden)
    ]
    parent = str(root.parent) if root.parent != root else None
    return dir_payload(str(root), parent, entries)


def _fs_list_remote(state: RunState, raw: str, show_hidden: bool) -> dict[str, Any]:
    """One-level remote directory listing via a single ls exec over the bridge."""
    transport = SshTransport(state.bridge_url)
    base = state.remote_root or "~"
    if raw:
        target = raw if raw.startswith("/") else base.rstrip("/") + "/" + raw
    else:
        target = base
    if target == "~" or target.startswith("~/"):
        home = transport.run("echo $HOME", _FS_LIST_TIMEOUT).stdout.strip() or base
        target = home if target == "~" else home + target[1:]
    r = transport.run(f"ls -1AF {shq(target)}", _FS_LIST_TIMEOUT)
    if r.code != 0:
        return dir_error(f"not a directory: {target}")
    entries = [
        {
            "name": name,
            "path": target.rstrip("/") + "/" + name,
            "dir": is_dir,
            # link targets need an extra readlink exec per symlink; skip (P2 MVP)
            "link": None,
        }
        for name, is_dir in parse_ls_entries(r.stdout)
        if entry_visible(name, is_dir, show_hidden)
    ]
    parent = target.rsplit("/", 1)[0] if target != "/" else None
    return dir_payload(target, parent, entries)


# ---- workspace tree (/api/workspace/tree) ----


def tree(ws: Workspace, expanded: list[str], show_hidden: bool) -> list:
    """Dispatch by transport; both walks share the lazy partial-walk policy."""
    if isinstance(ws, RemoteWorkspace):
        return _walk_remote(ws, expanded, show_hidden)
    return _walk(ws.root, ws, expanded, show_hidden)


def _tree_node(name: str, child_rel: str, is_dir: bool) -> dict[str, Any]:
    """One workspace-tree node: {name, path, dir, link} (link resolved by the
    local walk, which has the file system at hand)."""
    return {"name": name, "path": child_rel, "dir": is_dir, "link": None}


def _should_list(rel: str, child_rel: str, expanded: set[str]) -> bool:
    """Whether a child dir gets listed now: the root, an explicitly expanded
    dir, or a dir directly under an expanded one (the one-level lookahead)."""
    return rel == "" or child_rel in expanded or rel in expanded


def _walk_remote(ws: Workspace, expanded: list[str], show_hidden: bool) -> list:
    """Remote counterpart of _walk: same lazy partial walk (root + expanded dirs +
    one-level lookahead), but every level lists all its directories in ONE exec
    (RemoteWorkspace.list_many), so a tree costs ~depth round trips instead of one
    per directory. Entries come from the shared parse_ls_entries parser."""
    expanded = set(expanded)
    children: dict[str, list[dict[str, Any]]] = {}
    by_path: dict[str, dict[str, Any]] = {}

    frontier: list[str] = [""]
    while frontier:
        listed = ws.list_many(frontier)  # one SSH round trip per tree level
        next_frontier: list[str] = []
        for rel in frontier:
            out: list[dict[str, Any]] = []
            for name, is_dir in parse_ls_entries("\n".join(listed.get(rel, []))):
                if not show_hidden and name.startswith("."):
                    continue
                child_rel = name if rel == "" else f"{rel}/{name}"
                node = _tree_node(name, child_rel, is_dir)
                out.append(node)
                if is_dir:
                    by_path[child_rel] = node
                    if _should_list(rel, child_rel, expanded):
                        next_frontier.append(child_rel)
            children[rel] = out
        frontier = next_frontier

    # attach each listed level under its parent dir node
    for rel, out in children.items():
        if rel == "":
            continue
        parent = by_path.get(rel)
        if parent is not None:
            parent["children"] = out
    return children[""]


def _walk(root: Path, workspace: Workspace | None, expanded: list[str], show_hidden: bool) -> list:
    """Lazy partial tree walk: list children only for the root, the currently
    expanded dirs, and their direct children (one level of lookahead). Deeper
    levels are fetched as they get expanded, so opening a big project never walks
    the whole tree up front. show_hidden keeps dotfiles out of every level."""
    expanded = set(expanded)

    def list_entries(p: Path) -> list[Path]:
        if workspace is not None:
            entries = workspace.visible_entries(p)
        else:
            try:
                entries = sorted(p.iterdir(), key=lambda e: (e.is_file(), e.name.lower()))
            except OSError:
                return []
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]
        return entries

    def build(p: Path, rel: str) -> list:
        out = []
        for e in list_entries(p):
            child_rel = str(e.relative_to(root))
            node = _tree_node(e.name, child_rel, e.is_dir())
            node["link"] = str(e.resolve()) if e.is_symlink() else None
            # symlinked dirs are shown as leaves: prevents escaping into system
            # trees and symlink cycles; the agent's tools still follow links, so
            # only the UI is affected
            if e.is_dir() and not e.is_symlink():
                if _should_list(rel, child_rel, expanded):
                    node["children"] = build(e, child_rel)
            out.append(node)
        return out

    return build(root, "")
