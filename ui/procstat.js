// GENERATED FILE — do not edit; edit src/host/procstat.ts and run `npm run build:host`.
// source sha256: 6cdcf087da4126a88cd90f64798bc35db23cb8eae89d8edff7f05b108f065f27

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
module.exports = { bootId, starttime, identity };
