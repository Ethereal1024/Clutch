"use strict";

// Which machine a tab's .clc lives on, when the open's own refusal is the only
// evidence there is.
//
// The reported bug: a `tennis` session on hero@192.168.31.237 (file
// /home/hero/table_tennis/tennis.clc, picked while the picker was connected to
// hero) opened with
//
//   Failed to open project: not a .clc project file
//     (on root@region-46.seetacloud.com:31943)
//
// — region-46 being the machine the OTHER tab (`fix-train`) was on. The diagnosis
// that "repaired" that tab asked nothing: it took slots.ts rememberedMachine() —
// the picker's most recently dialled host — wrote it into the tab and persisted it
// with the working set, and because it only ever spoke for tabs with NO machine,
// while slots.ts prepareTabMachine pins every claim to the machine a tab names,
// that tab asked region-46 for a hero path for the rest of its life, across
// restarts.
//
// The fix: the machines this window can reach RIGHT NOW (its live hops, tunnel:list)
// are ASKED, one /api/fs/stat each, for the exact file; the one that answers "file"
// is the answer. Nothing is remembered, and when no live machine holds it nothing
// is invented.
//
// These blocks drive the REAL functions out of project.ts (liveMachines, holdsFile,
// machineWithFile) and slots.ts (asMachine, sameMachine) against a stub shell and
// stub workspace APIs — the source text that ships, not a re-implementation.
//
// Run: node tests/machine-of-file-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const project = read("ui/src/renderer/project.ts");
const slots = read("ui/src/renderer/slots.ts");
const projectFn = slicer(project).fnBody;
const slotsFn = slicer(slots).fnBody;

// the two machines of the reported incident, as the shell spells a hop's target
const HERO = { host: "192.168.31.237", user: "hero", port: 22 };
const REGION = { host: "region-46.seetacloud.com", user: "root", port: 31943 };
const TENNIS = "/home/hero/table_tennis/tennis.clc";

// A shell that holds `hops` (tunnel-core's bound instances: {url, target}) and a
// workspace API that answers "file" only for the paths in `holders` (base -> paths).
// Every question is recorded, because "who was asked" is half of what is under
// test — the diagnosis must ask, and must ask the right machines.
function world(opts) {
  const calls = { lists: 0, asked: [] };
  const hops = opts.hops || [];
  const holders = new Map(
    Object.entries(opts.holders || {}).map(([base, paths]) => [base, new Set(paths)])
  );
  const failed = new Set(opts.failBases || []);
  const ctx = vm.createContext({
    console,
    window: {
      clutchTunnel: {
        list: async () => {
          calls.lists++;
          if (opts.listFails) throw new Error("no bridge");
          return hops.map((h) => ({ ...h, target: { ...h.target } }));
        },
      },
    },
    // what apiFetch does for a caller that names a base: one GET, bounded by a
    // deadline, throwing when the endpoint cannot answer
    apiFetch: async (url, init) => {
      const base = init && init.base;
      calls.asked.push({ base, url });
      if (opts.statFails || failed.has(base)) throw new Error("no route to host");
      const at = String(url).indexOf("path=");
      const asked = at < 0 ? "" : decodeURIComponent(String(url).slice(at + 5));
      const has = holders.get(base);
      return { path: asked, type: has && has.has(asked) ? "file" : "none", error: null };
    },
    // a probe with a directory-shaped answer must not be mistaken for a file
  });
  for (const fn of ["asMachine", "sameMachine"]) vm.runInContext(runnableSnippet(slotsFn(fn)), ctx);
  for (const fn of ["liveMachines", "holdsFile", "machineWithFile"]) {
    vm.runInContext(runnableSnippet(projectFn(fn)), ctx);
  }
  return { ctx, calls };
}

// a hop row as tunnel:list reports it
const hop = (url, target) => ({ tunnelId: "t-" + target.host, active: true, url, target });

const tabOf = (machine, file = TENNIS) => ({ id: "tab-tennis", path: file, name: "tennis", machine });

async function main() {
  // ---- 1) THE REPORTED CASE -------------------------------------------------
  {
    const { ctx, calls } = world({
      hops: [hop("http://127.0.0.1:35929", HERO), hop("http://127.0.0.1:36107", REGION)],
      // the file is where the user picked it: on hero. region-46 has never heard
      // of /home/hero/table_tennis
      holders: { "http://127.0.0.1:35929": [TENNIS] },
    });
    // the poisoned record: the tab was stamped with the OTHER tab's machine
    const tab = tabOf({ ...REGION });
    const there = await ctx.machineWithFile(tab);
    check(there && there.machine.host === HERO.host && there.machine.user === HERO.user,
      "a tab stamped with the wrong machine is repaired to the machine that HAS the file (" +
      JSON.stringify(there && there.machine) + ")");
    check(there && there.base === "http://127.0.0.1:35929",
      "and it comes with the live base to re-claim it on, so the open runs there (" +
      (there && there.base) + ")");
    check(calls.asked.length === 2,
      "every live machine was asked — the recorded machine is not trusted, and the other one is not " +
      "assumed either (" + calls.asked.length + ")");
    check(calls.asked.every((a) => a.url.indexOf(encodeURIComponent(TENNIS)) > 0),
      "each was asked for the exact FILE (not its directory): what the host refused is what is looked for");
    check(tab.machine.host === REGION.host,
      "the diagnosis itself writes nothing: the caller decides, and only a machine that answered is recorded");
  }

  // ---- 2) a tab that never recorded a machine -------------------------------
  {
    const { ctx } = world({
      hops: [hop("http://127.0.0.1:36107", REGION), hop("http://127.0.0.1:35929", HERO)],
      holders: { "http://127.0.0.1:35929": [TENNIS] },
    });
    const there = await ctx.machineWithFile(tabOf(undefined));
    check(there && there.machine.host === HERO.host,
      "an unknown-machine tab (a store from before the field) gets the holder, whichever row it is in");
  }

  // ---- 3) the machine the open already failed on is not an answer ------------
  {
    const { ctx, calls } = world({
      hops: [hop("http://127.0.0.1:36107", REGION)],
      holders: { "http://127.0.0.1:36107": [TENNIS] },
    });
    const there = await ctx.machineWithFile(tabOf({ ...REGION }));
    check(there === null,
      "a file held only by the machine that just refused it is no repair: re-claiming there repeats " +
      "the same refusal");
    check(calls.asked.length === 1, "…and that machine was still asked, so the answer is evidence, not a shortcut");
  }

  // ---- 4) nobody holds it: invent nothing ------------------------------------
  {
    const hops = [hop("http://127.0.0.1:36107", REGION), hop("http://127.0.0.1:35929", HERO)];
    const { ctx } = world({ hops, holders: {} });
    const tab = tabOf({ ...REGION });
    const there = await ctx.machineWithFile(tab);
    check(there === null,
      "no live machine holds the path: the refusal stands (a genuinely bad path, or its machine is not " +
      "connected) — no machine is invented");
    check(tab.machine.host === REGION.host && String(tab.machine.port) === "31943",
      "and the tab's record is left exactly as it was");
  }

  // ---- 5) a path that is not a .clc is not a machine question ---------------
  {
    const { ctx, calls } = world({
      hops: [hop("http://127.0.0.1:35929", HERO)],
      holders: { "http://127.0.0.1:35929": ["/home/hero/notes.txt"] },
    });
    const there = await ctx.machineWithFile(tabOf({ ...REGION }, "/home/hero/notes.txt"));
    check(there === null,
      "the host's 'not a .clc' is the other half of its one message: no machine can heal a non-project path");
    check(calls.lists === 0 && calls.asked.length === 0,
      "so no hop is enumerated and nothing is asked");
  }

  // ---- 6) silence is not a verdict ------------------------------------------
  {
    // the shell cannot even list its hops (an older build, a broken bridge)
    const { ctx } = world({ listFails: true, hops: [hop("http://127.0.0.1:35929", HERO)] });
    check((await ctx.machineWithFile(tabOf({ ...REGION }))) === null,
      "a shell that cannot say which hops are up answers nothing — no fallback to a remembered host");

    // one hop is dead, the other one holds the file
    const { ctx: mixed } = world({
      hops: [hop("http://127.0.0.1:36107", REGION), hop("http://127.0.0.1:35929", HERO)],
      holders: { "http://127.0.0.1:35929": [TENNIS] },
      failBases: ["http://127.0.0.1:36107"],
    });
    const there = await mixed.machineWithFile(tabOf(undefined));
    check(there && there.machine.host === HERO.host,
      "a hop that cannot answer (a dead forward) does not hide the one that can");

    // every probe fails: the open's own failure stays the honest answer
    const { ctx: silent } = world({
      hops: [hop("http://127.0.0.1:35929", HERO)],
      statFails: true,
    });
    check((await silent.machineWithFile(tabOf(undefined))) === null,
      "and when every machine is silent, nothing is claimed about where the file is");
  }

  // ---- 7) the traits that make it a search, not a guess ---------------------
  {
    const live = projectFn("liveMachines");
    check(/window\.clutchTunnel\.list/.test(live),
      "the candidate machines are the shell's own LIVE hops — not the picker's history, not a URL's shape");
    check(/!machine \|\| !row\.url/.test(live),
      "a row with no address or no machine record cannot be asked, and is left out instead of guessed");
    check(!/localStorage|rememberedMachine/.test(live + projectFn("machineWithFile")),
      "nothing in the diagnosis reads the connection list or any remembered host");
    const probe = projectFn("holdsFile");
    check(/st\.type === "file"/.test(probe) && /timeout: 10000/.test(probe),
      "the answer must be the FILE itself, and the question is bounded: a failed open cannot hang the pane");
  }

  summary("machine-of-file", "the machine that HAS the file is asked for, not remembered");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
