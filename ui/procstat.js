// GENERATED FILE — do not edit; edit src/host/procstat.ts and run `npm run build:host`.
// source sha256: b2a6316acb0d2661366f496ec9a491eb0e0fb51091cc2706f8cc5b39e8ecb6ac

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Kernel-verified process identity: the (pid, start tick, boot) a session claim
// NAMES, so the machine that records it can answer "is this still the process I
// recorded?" without trusting a heartbeat.
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
// This side only writes the identity, when it starts a session (this window's
// process, ui/src/host/supervisor-client.ts). The verdict on it is the holding
// machine's, and it is read there (agent/core/lock_reconcile.py, through
// agent/core/procstat.py): a claim is only ever ended on a positive "dead", and
// a host that cannot see the pid's table says so instead of guessing.
//
// One door back: a claim recorded by a session on a FAR host names a window on
// THIS machine (claim_host is this host, from supervisor-client's session start),
// and this is the only kernel that can say whether that window is still there.
// So state() answers here too, and its "dead" is what a host settles a stranded
// claim with (ui/src/host/host-core.ts settleClaim → lock_reconcile.witnessed) —
// the same conviction, in the one place that can honestly reach it.
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
    }
    catch (e) {
        return null; // no such process, or no /proc on this host
    }
    const at = raw.lastIndexOf(")");
    if (at < 0)
        return null;
    return raw.slice(at + 1).trim().split(/\s+/);
}
// This boot's kernel id; "" where the kernel does not name one (Windows, macOS).
// Empty means "a start tick cannot be pinned to a boot here".
function bootId() {
    try {
        return fs.readFileSync("/proc/sys/kernel/random/boot_id", "ascii").trim();
    }
    catch (e) {
        return "";
    }
}
// The process's start tick, as the string the kernel prints; null when it has no
// /proc entry (gone, or no /proc on this host).
function starttime(pid) {
    const fields = statFields(pid);
    if (fields === null || fields.length <= STARTTIME_INDEX)
        return null;
    return fields[STARTTIME_INDEX];
}
// "live" | "dead" | "unknown" for the process (pid, start) — the same
// three-valued answer agent/core/procstat.py gives, and for the same reason: a
// claim is only ever ended on a positive "dead", and a doubt must never read as
// either verdict.
//
//   "live"    the recorded process is still running (a stranger's pid that now
//             carries another start tick is NOT it)
//   "dead"    it exited: no /proc entry on a host that has /proc, a zombie
//             (exited, only waiting to be reaped), or a recycled pid whose start
//             tick no longer matches
//   "unknown" this host cannot read that table at all, so it must not guess
//
// Windows is "unknown" on purpose. It has no /proc, and this half does not carry
// Python's OpenProcess/WaitForSingleObject probe: a client there cannot WITNESS a
// dead window, and says so instead of turning a missing entry into "dead" — the
// one verdict that lets a far host kill a session.
function state(pid, start) {
    if (!Number.isInteger(pid) || pid <= 0)
        return "dead";
    if (process.platform === "win32")
        return "unknown";
    const fields = statFields(pid);
    if (fields === null) {
        // no entry: gone on a host WITH /proc (macOS has none, and cannot tell)
        try {
            fs.statSync("/proc/self");
        }
        catch (e) {
            return "unknown";
        }
        return "dead";
    }
    if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x")
        return "dead";
    if (start && fields.length > STARTTIME_INDEX && fields[STARTTIME_INDEX] !== start)
        return "dead";
    return "live";
}
// {pid, start, boot} for a live-or-recently-dead pid, or null when the pid is
// not a process this host can name. `start` is "" on a host without /proc: the
// record then compares pids only, which is weaker and says so.
function identity(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    const tick = starttime(pid);
    if (tick === null && process.platform !== "win32")
        return null;
    return { pid, start: tick || "", boot: bootId() };
}
module.exports = { bootId, starttime, identity, state };
