// The 409's other half: WHO holds the project, and the one case a user can undo.
//
// "This project is already open in another window" was the end of the story: the
// user had no way to learn which window, and no way back when that window was a
// dead session still holding the flock (the 13-minute `distill.clc` outage). The
// host's record now names the holder (pid, host, since, claiming window), and
// the page offers one action — reclaim — ONLY when that host can PROVE the
// claiming window is gone ("orphan"). A live window, an unclaimed/older lock, or
// a host that cannot answer is left alone: this page never guesses.
//
// Run: node tests/project-lock-reclaim-test.js

"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiModules } = require("./harness");

const ROOT = path.join(__dirname, "..");
const PROJECT = uiModules().find((m) => m.file === "project.ts").code;
const APP = uiModules().find((m) => m.file === "app.ts").code;
const { fnBody } = slicer(PROJECT);

// the three helpers, taken out of the page exactly as it ships
const describeHolder = new Function("return " + fnBody("describeHolder"))();
const provenOrphanOf = (win) => new Function("window", "return " + fnBody("provenOrphan"))(win);
const reclaimOf = (win, notice) =>
  new Function("window", "notice", "return " + fnBody("reclaimLock"))(win, notice);

(async () => {
  // ---- who holds it: the host's record, in the user's words ----
  check(
    describeHolder({ pid: 4242, host: "far-host", since: 1_700_000_000 }) ===
      `Held by process 4242 on far-host since ${new Date(1_700_000_000 * 1000).toLocaleString()}.`,
    "the holder is named: process, machine, and when it took the lock",
  );
  check(describeHolder(null) === "", "a holder that wrote no record says nothing (never a guess)");
  check(describeHolder({}) === "", "and an empty record is the same non-answer");

  // ---- which locks may be taken back: a PROVEN orphan, nothing else ----
  const orphanHost = (calls) => ({
    clutchLocks: {
      list: async () => {
        calls.n++;
        return { locks: [{ project: "/tmp/a.clc", state: "orphan" }] };
      },
    },
  });
  const calls = { n: 0 };
  check(
    (await provenOrphanOf(orphanHost(calls))("/tmp/a.clc")) === true,
    "a lock whose claiming window is gone is a PROVEN orphan",
  );
  check(calls.n === 1, "and the page asked the host (only the host can see the kernel's answer)");
  check(
    (await provenOrphanOf({
      clutchLocks: { list: async () => ({ locks: [{ project: "/tmp/a.clc", state: "live" }] }) },
    })("/tmp/a.clc")) === false,
    "a live window's project is never offered: that is someone's work",
  );
  check(
    (await provenOrphanOf({
      clutchLocks: {
        list: async () => ({ locks: [{ project: "/tmp/a.clc", state: "unclaimed" }, { project: "/tmp/b.clc", state: "orphan" }] }),
      },
    })("/tmp/a.clc")) === false,
    "an unclaimed lock (a build before records) is reported, not reclaimed",
  );
  check(
    (await provenOrphanOf({
      clutchLocks: { list: async () => ({ locks: [{ project: "/tmp/a.clc", state: "unverifiable" }] }) },
    })("/tmp/a.clc")) === false,
    "a remote claim this host cannot verify is doubt, and doubt reclaims nothing",
  );
  check(
    (await provenOrphanOf({
      clutchLocks: { list: async () => ({ locks: [{ project: "/tmp/a.clc", state: "orphan" }] }) },
    })("/tmp/other.clc")) === false,
    "the match is by the locked file, not by 'some lock somewhere is orphaned'",
  );
  check(
    (await provenOrphanOf({
      clutchLocks: {
        list: async () => {
          throw new Error("host down");
        },
      },
    })("/tmp/a.clc")) === false,
    "a host that cannot answer offers no reason to take anything",
  );
  check((await provenOrphanOf({})("/tmp/a.clc")) === false, "a shell with no lock API (Android) simply has no answer");
  check((await provenOrphanOf(orphanHost(calls))(null)) === false, "no project named, nothing to look up");

  // ---- WHICH machine is asked: the tab's own session, never the window's ----
  // A lock lives on the machine the project lives on, and the shell reaches that
  // machine's supervisor through the claim of the slot that holds the session.
  // Asked without a slot, the answer comes from this machine's supervisor — so a
  // project on a far host read as "no such lock here" and the pane fell through
  // to "open read-only?" while nobody else had it open: the fix-train report.
  let askedSlot = "unset";
  await provenOrphanOf({
    clutchLocks: {
      list: async (slotId) => {
        askedSlot = slotId;
        return { locks: [] };
      },
    },
  })("/tmp/a.clc", "tab-7");
  check(askedSlot === "tab-7", "the page asks the host about the TAB's session, which is what picks the machine");

  // ---- taking it back: the HOST's verdict is the answer ----
  const notices = [];
  const notice = (m) => notices.push(m);
  check(
    (await reclaimOf({ clutchLocks: { reclaim: async () => ({ revoked: true, why: "terminated" }) } }, notice)(
      "/tmp/a.clc",
    )) === true,
    "a host that freed the lock is reported as reclaimed",
  );
  check(
    (await reclaimOf({ clutchLocks: { reclaim: async () => ({ revoked: false, why: "the window that claimed it is alive" }) } }, notice)(
      "/tmp/a.clc",
    )) === false,
    "a refusal is NOT a reclaim (the page must not reopen over a live window)",
  );
  check(
    notices.at(-1).includes("the window that claimed it is alive"),
    `and the host's own reason is what the user reads (${notices.at(-1)})`,
  );
  notices.length = 0;
  check(
    (await reclaimOf({
      clutchLocks: {
        reclaim: async () => {
          throw new Error("connection refused");
        },
      },
    }, notice)("/tmp/a.clc")) === false,
    "a host that cannot be reached is not a reclaim either",
  );
  check(notices.at(-1).includes("connection refused"), "and says so, instead of failing silently");
  check((await reclaimOf({}, notice)("/tmp/a.clc")) === false, "no lock API -> no action");

  // the reclaim has to reach the SAME machine the verdict came from
  let reclaimedSlot = "unset";
  check(
    (await reclaimOf({
      clutchLocks: {
        reclaim: async (project, slotId) => {
          reclaimedSlot = slotId;
          return { revoked: true, why: "terminated" };
        },
      },
    }, notice)("/tmp/a.clc", "tab-7")) === true,
    "the reclaim is sent for the tab's session too",
  );
  check(reclaimedSlot === "tab-7", "so the host that HOLDS the lock is the one that is asked to let go");

  // ---- the wiring the page actually ships ----
  check(/e\.owner = err\.owner/.test(PROJECT), "the 409's owner reaches the dialog");
  check(/e\.project = err\.project/.test(PROJECT), "and the exact file the host locked");
  check(/owner/.test(APP) && /e\.owner = data\.owner/.test(APP), "apiFetch carries the owner for every caller");
  const open = PROJECT.slice(PROJECT.indexOf("async function openInTab("));
  const conflict = open.slice(open.indexOf('e.code === "project_open_conflict"'));
  check(
    conflict.indexOf("provenOrphan") > -1 && conflict.indexOf("provenOrphan") < conflict.indexOf("Open read-only"),
    "the takeover is offered BEFORE the read-only fallback (and only when the host proves it)",
  );
  check(/await provenOrphan\(e\.project, tab\.id\)/.test(conflict),
    "and the question names the tab's own session, which is what reaches the machine holding the lock");
  check(/await reclaimLock\(e\.project, tab\.id\)/.test(conflict),
    "and taking it back goes through the host's reclaim, for THIS tab's session");
  check(/await openInTab\(tab, base, readOnly, seq\)/.test(conflict), "a successful reclaim reopens the project it was asked for");

  const preload = fs.readFileSync(path.join(ROOT, "ui", "preload.js"), "utf8");
  check(/exposeInMainWorld\("clutchLocks"/.test(preload), "the page gets the lock API through the preload bridge");
  const main = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8");
  check(/ipcMain\.handle\("locks:list"/.test(main), "locks:list is served by the shell");
  check(/ipcMain\.handle\("locks:reclaim"/.test(main), "so is the reclaim");
  check(
    /supervisorBaseFor\(e\.sender\.id,/.test(main),
    "and both ask the supervisor that owns THIS window's session (local or far side), never a file",
  );

  summary("project-lock-reclaim");
})();
