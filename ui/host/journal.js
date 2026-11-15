// The host's own file bookkeeping: undo snapshots, the turn journal, the
// protected set.
//
// None of this is a file tool. It is what the WORKSPACE knows and a file tool
// cannot: which bytes a path held before the last overwrite (the UI's "↶ undo"),
// which task each mutation belonged to (the UI's "roll back to here"), and which
// paths are invisible to the agent (the project's own .clc). The component that
// performs the write is told nothing about tasks, and the task loop knows no
// byte offsets — the journal is the one place that holds both.
//
// Ported from `agent/tools/workspace.py:138-247` (Workspace.snapshot /
// restore / begin_turn / record_mutation / rollback_anchors / rollback_from /
// protect / is_protected). It is pure memory plus two file operations, so the
// port is nearly literal; what changed is only that write/delete are async
// (every file op on a far root is an exec round trip).
//
// createJournal({realpath, write, delete}) -> the bookkeeping half of a workspace

"use strict";

// undo stack depth per file (snapshots before each overwrite)
const MAX_SNAPSHOTS_PER_FILE = 5;

function createJournal(io) {
  const realpath = io && io.realpath;
  const write = io && io.write;
  const remove = io && io.delete;
  if (typeof realpath !== "function" || typeof write !== "function" || typeof remove !== "function") {
    throw new TypeError("createJournal needs {realpath, write, delete}");
  }

  // per-file undo stack: previous contents recorded before every overwrite
  const snapshots = new Map(); // key -> [content, ...]
  // The TURN JOURNAL: every file a write replaced (or created), keyed by the log
  // offset of the user task that was running when it changed (beginTurn). It
  // answers the UI's "roll back to this task": undoing a task means undoing every
  // recorded mutation at or after that task's offset, newest first, and DELETING
  // the files that did not exist before — a creation is not something the
  // per-file undo stack can express, which is why the journal is its own record.
  let journal = []; // {anchor, path, existed, content}
  let anchor = null;
  const protectedPaths = new Set();

  function snapshot(path, content) {
    // key on realpath, like every other piece of bookkeeping: two spellings of
    // one file must share a stack
    const key = String(realpath(String(path)));
    const stack = snapshots.get(key) || [];
    stack.push(String(content));
    if (stack.length > MAX_SNAPSHOTS_PER_FILE) stack.shift();
    snapshots.set(key, stack);
  }

  // Pop the last snapshot and write it back; the restored content, or null when
  // there is no snapshot for this file (the "no snapshot to restore" answer the
  // UI's undo button gets).
  async function restore(path) {
    const key = String(realpath(String(path)));
    const stack = snapshots.get(key);
    if (!stack || !stack.length) return null;
    const content = stack.pop();
    await write(String(path), content);
    return content;
  }

  // ---- the turn journal (the UI's whole-task rollback) ---------------------

  function beginTurn(at) {
    anchor = Math.trunc(Number(at));
  }

  // Journal one file mutation. `existed` false means the write CREATED the path,
  // so a rollback removes it instead of restoring content. Nothing is recorded
  // when no checkpoint is open: a tool call outside a run has no task to be
  // rolled back with, and inventing one would offer the UI an undo that restores
  // state no task ever produced.
  function recordMutation(path, existed, previous = "") {
    if (anchor === null) return;
    journal.push({ anchor, path: String(path), existed: Boolean(existed), content: String(previous) });
  }

  // The log offsets a rollback checkpoint actually exists for, ascending. A task
  // that changed nothing is absent on purpose.
  function rollbackAnchors() {
    return [...new Set(journal.map((entry) => entry.anchor))].sort((a, b) => a - b);
  }

  // Undo every journaled mutation at or after `from` and report what changed;
  // null when nothing was recorded for that task or any later one.
  //
  // The entries are applied NEWEST FIRST, which is what makes the same path
  // written twice come out right: the later write is undone to its intermediate
  // content, then the earlier one to what preceded it — and a file created and
  // then rewritten ends up deleted. A path that cannot be put back (permissions,
  // a file removed by a shell command) is reported by omission rather than
  // aborting the rest of the rollback. The undone entries are dropped: their
  // effect is gone, and a second rollback to the same task must not restore
  // pre-task content over work done since.
  async function rollbackFrom(from) {
    const picked = journal.filter((entry) => entry.anchor >= from);
    if (!picked.length) return null;
    journal = journal.filter((entry) => entry.anchor < from);
    const restored = [];
    const deleted = [];
    for (const entry of picked.slice().reverse()) {
      try {
        if (entry.existed) {
          await write(entry.path, entry.content);
          restored.push(entry.path);
        } else {
          await remove(entry.path);
          deleted.push(entry.path);
        }
      } catch (error) {
        // not put back; left out of the report instead of guessed
      }
    }
    return { restored, deleted };
  }

  // ---- the protected set (the project's own .clc) --------------------------

  // Mark a file as invisible/unusable to the agent.
  function protect(path) {
    protectedPaths.add(String(realpath(String(path))));
  }

  // Deliberately unguarded: realpath on a far root is lexical and total, so a
  // path that cannot be normalized is simply not the protected file.
  function isProtected(path) {
    return protectedPaths.has(String(realpath(String(path))));
  }

  function protectedSet() {
    return new Set(protectedPaths);
  }

  return {
    snapshot,
    restore,
    beginTurn,
    recordMutation,
    rollbackAnchors,
    rollbackFrom,
    protect,
    isProtected,
    protectedSet,
    // for the tests and for a host that has to show what it is hiding
    snapshotCount(path) {
      const stack = snapshots.get(String(realpath(String(path))));
      return stack ? stack.length : 0;
    },
    journalLength() {
      return journal.length;
    },
  };
}

module.exports = { createJournal, MAX_SNAPSHOTS_PER_FILE };
