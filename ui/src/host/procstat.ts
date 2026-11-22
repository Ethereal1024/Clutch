// Kernel-verified process identity: "is this still the process I recorded?"
//
// The client's half of agent/core/procstat.py. A .clc's owner record names the
// window that claimed it as (claim_host, claim_pid, claim_start), and the pid is
// a NUMBER, not an identity: the kernel recycles it, and on POSIX a zombie keeps
// it until somebody reaps it. So "some process has this number" is never read as
// "the claimant is alive" — the start tick (field 22 of /proc/<pid>/stat) has to
// match the one recorded as well. Both mistakes this module exists to prevent
// (a stranger's pid read as the window, a zombie read as a live one) were made
// by the bare `kill(pid, 0)` checks this tree used to carry.
//
// The CLIENT is the side that needs this, and only for one question: the lock is
// on some machine, the window that claimed it runs on THIS one, and only this
// machine's kernel can say whether that window is still there. The answer is
// relayed to the holding machine as a witness (ui/main.ts locks:reclaim) — the
// far side can compare it with its record, and nothing else.
//
// Verdicts are three-valued on purpose:
//   "live"    — the recorded process is still running
//   "dead"    — it exited (or a stranger holds the number now)
//   "unknown" — this host cannot see that pid's table (a pid from ANOTHER
//               machine's table, a kernel with no /proc). Doubt is never read as
//               either verdict: a project is only taken from its owner on a
//               positive "dead".
const fs = require("fs");

// /proc/<pid>/stat, field numbers (1-based): 1 pid, 2 comm, 3 state, ... 22
// starttime. Everything before state is "<pid> (<comm>) ", and comm may contain
// spaces and parentheses, so the split happens AFTER the last ')' and the index
// below is field 22.
const STARTTIME_INDEX = 19;

function statFields(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch (e) {
    return null; // no such process, or no /proc on this host
  }
  const at = raw.lastIndexOf(")");
  if (at < 0) return null;
  return raw.slice(at + 1).trim().split(/\s+/);
}

// This boot's kernel id; "" where the kernel does not name one (Windows, macOS).
// Empty means "a start tick cannot be pinned to a boot here".
function bootId() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "ascii").trim();
  } catch (e) {
    return "";
  }
}

// The process's start tick, as the string the kernel prints; null when it has no
// /proc entry (gone, or no /proc on this host).
function starttime(pid) {
  const fields = statFields(pid);
  if (fields === null || fields.length <= STARTTIME_INDEX) return null;
  return fields[STARTTIME_INDEX];
}

// {pid, start, boot} for a live-or-recently-dead pid, or null when the pid is
// not a process this host can name. `start` is "" on a host without /proc: the
// record then compares pids only, which is weaker and says so (see state()).
function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const tick = starttime(pid);
  if (tick === null && process.platform !== "win32") return null;
  return { pid, start: tick || "", boot: bootId() };
}

// The kernel's answer for (pid, start) on boot `boot`. An empty `start` is a
// caller with no tick (a record written on a host without /proc): the pid alone
// is then the only evidence, and the verdict says nothing about how weak it is —
// so a "live" with no tick is the frail fact it looks like.
function state(pid, started = "", boot = "") {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (process.platform === "win32") {
    // No /proc: ask the kernel by name. ESRCH is gone; EPERM is a process this
    // user may not open, which still exists.
    try {
      process.kill(pid, 0);
      return "live";
    } catch (e) {
      return e && e.code === "EPERM" ? "live" : "dead";
    }
  }
  const fields = statFields(pid);
  if (fields === null) {
    // No /proc entry here. On a host WITH /proc that is "gone"; without one
    // (macOS) this module cannot tell, and says so.
    return fs.existsSync("/proc/self") ? "dead" : "unknown";
  }
  if (boot) {
    const mine = bootId();
    // a tick recorded on another boot names a different instant: this pid's
    // do-not-match is proof, not doubt
    if (mine && boot !== mine) return "dead";
  }
  if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") {
    return "dead"; // exited; only waiting to be reaped
  }
  if (started && fields.length > STARTTIME_INDEX && fields[STARTTIME_INDEX] !== started) {
    return "dead"; // the number was recycled: another process holds it now
  }
  return "live";
}

module.exports = { bootId, starttime, identity, state };
