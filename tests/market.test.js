// The market index: ONE document every client and every version reads.
//
// This runner pins the document itself — the shape a curated row has, and the
// rules that make a row safe (a version-pinned manifest URL, a digest, a name) —
// plus the three ways the page can get one (the live URL, this machine's last
// good copy, the snapshot this build ships) and the fact that opening the plugin
// page is ONE read: drawing a market row never fetches a module's manifest.
//
// Nothing here touches the network: the live index is a github URL, so the chain
// is driven with a dead mirror prefix and a HOME of its own (tests/market-chain.js,
// in a child process — the cache path is resolved from HOME at require time).
// The network half of this contract is scripts/market_index.py --check, which CI
// runs against the real releases.
// Run: node tests/market.test.js
"use strict";

const { check, summary } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SNAPSHOT = path.join(ROOT, "ui", "market.snapshot.json");
const ENTRIES = path.join(ROOT, "market", "entries.json");
const CHAIN = path.join(__dirname, "market-chain.js");
const components = require("../ui/components");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// a manifest URL a generator would accept: version-pinned, never "latest"
const PINNED = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/clutch-component\.json$/;

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// What the chain answers in a process whose HOME is this directory.
function chain(args, home, env = {}) {
  const r = spawnSync(process.execPath, [CHAIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLUTCH_MANIFEST_TIMEOUT_MS: "1500", ...env },
  });
  const line = String(r.stdout || "").trim().split("\n").pop();
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(`the chain runner said nothing usable (${r.status}): ${r.stdout}${r.stderr}`);
  }
}

async function main() {
  // ---- 1. the document this build ships ---------------------------------
  const snapshot = readJSON(SNAPSHOT);
  check(snapshot.schema === 2, "the shipped snapshot is index schema 2");
  check(Array.isArray(snapshot.entries) && snapshot.entries.length >= 4, `and it lists the modules this project publishes (${snapshot.entries.length})`);
  check(!("generated" in snapshot) && !("updated" in snapshot), "with no timestamp in it: an unchanged market is byte-identical, so --check is a real staleness gate");

  const ids = snapshot.entries.map((e) => e.id);
  check(new Set(ids).size === ids.length, "every row has its own <owner>/<name> id");
  check(
    snapshot.entries.every((e) => /^[\w.-]+\/[\w.-]+$/.test(e.id)),
    "an id is owner/name — what a row is cited by, and what a module's own repo path already is"
  );
  check(
    snapshot.entries.every((e) => e.manifest && PINNED.test(e.manifest) && !/\/releases\/latest\//.test(e.manifest)),
    "every row names a VERSION-pinned manifest URL, never releases/latest: publishing a release installs nothing until the index says so"
  );
  check(
    snapshot.entries.every((e) => /^[0-9a-f]{64}$/.test(e.manifest_sha256)),
    "and pins those exact bytes by sha256, so a row cannot be swapped under this client"
  );
  check(
    snapshot.entries.every((e) => e.version && e.manifest.includes(`/download/v${e.version}/`)),
    "the row's version is the one its manifest URL carries: two spellings of one fact do not drift"
  );
  check(
    snapshot.entries.every((e) => typeof e.name === "string" && e.name && typeof e.summary === "string" && e.summary),
    "a row says what the component IS (name + summary), because a module's manifest describes an install and not a market"
  );
  check(
    snapshot.entries.every((e) => Array.isArray(e.tags) && e.tags.length > 0),
    "and carries the tags a page filters by"
  );
  check(
    snapshot.entries.every((e) => !("interface" in e) && !("runs_on" in e)),
    "and no kind word: where a component runs is its declaration's answer (`service` / `launch` / `entry`), so the index repeats none of it"
  );

  // ---- 2. the curation file and the shipped copy say the same thing ------
  // market/entries.json is the only file adding a plugin touches; the snapshot is
  // its generated copy (digests and all — a digest is read from the release, so it
  // lives in the generated file only). Comparing the curated fields here catches
  // the one mistake a hand edit makes: forgetting to regenerate. The digests
  // themselves are the generator's network gate (scripts/market_index.py --check,
  // which CI runs against the real releases).
  const curated = readJSON(ENTRIES);
  const CURATED = ["id", "name", "manifest", "version", "summary", "homepage", "license"];
  check(
    curated.entries.length === snapshot.entries.length,
    `the curation file and the shipped copy list the same number of rows (${curated.entries.length} / ${snapshot.entries.length})`
  );
  check(
    curated.entries.every((e, i) => e.id === snapshot.entries[i].id),
    "in the same order — the document is deterministic, so a regenerated file is byte-identical"
  );
  const drift = curated.entries
    .map((e, i) => [e, snapshot.entries[i]])
    .filter(([a, b]) => !b || CURATED.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f])) || JSON.stringify(a.tags) !== JSON.stringify(b.tags));
  check(
    drift.length === 0,
    `every curated field in ui/market.snapshot.json matches market/entries.json${
      drift.length ? ` (stale: ${drift.map(([a]) => a.id).join(", ")} — run scripts/market_index.py --write)` : ""
    }`
  );
  check(
    snapshot.entries.every((e) => !("manifest_sha256" in (curated.entries.find((c) => c.id === e.id) || {}))),
    "and the digest is the generator's to add: a hand-written digest would be a claim nobody checked"
  )

  // ---- 3. opening the page is ONE read --------------------------------
  // marketEntries() is the page's path: the checkouts beside this repo, then one
  // row per index entry — and not a single manifest read.
  {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = () => {
      fetched++;
      return Promise.reject(new Error("this test has no network"));
    };
    try {
      const listed = await components.marketEntries({ index: SNAPSHOT });
      check(listed.errors.length === 0 && listed.origin === "given", "the snapshot is a readable index, even when it is handed over as a path");
      check(fetched === 0, "and drawing every row it lists fetched nothing: an index is the point of the index");
      // every module this project publishes also has a checkout beside this repo,
      // so on a contributor's machine the market rows are the ones WITHOUT one:
      // a checkout is drawn from its own bytes and the row only describes it
      const names = new Set(listed.specs.map((s) => s.name));
      const rowsOnly = snapshot.entries.filter((e) => !listed.specs.some((s) => s.checkout && s.name === e.name));
      check(
        rowsOnly.every((e) => names.has(e.name)),
        `every row the index lists is drawn, checkout or not (${rowsOnly.length} without a local edit)`
      );
      const fromMarket = listed.specs.filter((s) => !s.checkout);
      check(
        fromMarket.every((s) => s.entry && s.entry.manifest_sha256 && s.source === s.entry.manifest && s.published === null),
        "and a row is a POINTER: it names the release and its pin, and claims no manifest it has not read"
      );
      const checkouts = listed.specs.filter((s) => s.checkout);
      check(
        checkouts.length > 0 && checkouts.every((s) => s.entry || !snapshot.entries.some((e) => e.name === s.name)),
        "a checkout beside this repo still outranks the index for BYTES — and, when the market lists it, keeps the row's own copy"
      );
      const described = checkouts.filter((s) => s.entry);
      check(
        described.every((s) => s.entry.summary && s.id === s.entry.id),
        "so a contributor's edit is described by the market it is a row of (summary, tags, id), not left mute"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ---- 4. one bad ROW is a reason; a bad DOCUMENT is an error ------------
  {
    const dir = tmp("clutch-market-doc-");
    const manifest = path.join(dir, "clutch-sample.json");
    fs.writeFileSync(manifest, JSON.stringify({ schema: 1, name: "clutch-sample", version: "0.1.0", artifacts: {} }));
    const sha = require("crypto").createHash("sha256").update(fs.readFileSync(manifest)).digest("hex");
    const good = { id: "acme/clutch-sample", name: "clutch-sample", manifest, manifest_sha256: sha, version: "0.1.0" };
    const doc = (entries) => {
      const file = path.join(dir, "index.json");
      fs.writeFileSync(file, JSON.stringify({ schema: 2, entries }));
      return file;
    };

    const mixed = await components.readIndex({
      index: doc([
        good,
        { id: "not-an-id", name: "x", manifest: manifest, manifest_sha256: sha },
        { id: "acme/unpinned", name: "unpinned", manifest },
        { ...good, id: "acme/second", name: "clutch-sample" }, // same name twice
      ]),
    });
    check(mixed.entries.length === 1, "a row that cannot be read is dropped, and the readable ones are still a market");
    check(mixed.errors.length === 3, `and each dropped row says why (${mixed.errors.map((e) => e.reason).join(" | ")})`);
    check(
      mixed.errors.some((e) => /<owner>\/<name>/.test(e.reason)) &&
        mixed.errors.some((e) => /pins no sha256/.test(e.reason)) &&
        mixed.errors.some((e) => /twice/.test(e.reason)),
      "the id, the missing pin and the duplicate name are each named in the row's own words"
    );
    check(mixed.errors.every((e) => e.unreachable === false), "and none of them is drawn as a network problem: a wrong row is not an unreachable one");

    const stale = await components.readIndex({ index: doc([{ ...good, manifest_sha256: "0".repeat(64) }]) });
    check(stale.entries.length === 1, "a row pinning the wrong bytes is still a row the client can hold");
    // the install path: one manifest read per row, and the three agreements a row
    // has to keep (the pin, the name, the version) are checked HERE — the checkouts
    // beside this repo are drawn from their own bytes and are not the subject
    const only = (out) => out.specs.filter((s) => s.name === "clutch-sample" || s.name === "clutch-other");
    const specs = await components.componentSpecs({ index: doc([{ ...good, manifest_sha256: "0".repeat(64) }]) });
    check(
      only(specs).length === 0 && specs.errors.length === 1 && /not the 0{64} the index pins/.test(specs.errors[0].reason),
      "until something INSTALLS it: the pin is checked then, and a swapped manifest is refused in the pin's own words"
    );
    const wrong = await components.componentSpecs({ index: doc([{ ...good, name: "clutch-other", id: "acme/clutch-other" }]) });
    check(
      only(wrong).length === 0 && /declares clutch-sample/.test(wrong.errors[0].reason),
      "and a row describing another component than its manifest does is refused too"
    );
    const offVersion = await components.componentSpecs({ index: doc([{ ...good, version: "9.9.9" }]) });
    check(
      only(offVersion).length === 0 && /stale/.test(offVersion.errors[0].reason),
      "as is a row left behind by a release: the index decides which version is current, so it has to agree with the manifest"
    );

    const broken = await components.readIndex({ index: doc([]).replace(/index\.json$/, "nope.json") });
    check(
      broken.entries.length === 0 && broken.errors.length === 1 && /ENOENT|no such file/i.test(broken.errors[0].reason),
      "a document that is not there is one reason and an empty market, never a throw"
    );
    const wrongSchema = path.join(dir, "old.json");
    fs.writeFileSync(wrongSchema, JSON.stringify({ schema: 1, sources: [] }));
    const old = await components.readIndex({ index: wrongSchema });
    check(
      old.entries.length === 0 && /unknown index schema 1/.test(old.errors[0].reason),
      "and the list this build used to ship is not quietly read as a market: schema 1 is refused by name"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 5. the chain: live, then last-known, then what this build ships ---
  if (process.platform === "win32") {
    console.log("SKIP: the chain runs in a child process with its own HOME, which win32 does not read");
  } else {
    const home = tmp("clutch-market-home-");
    const cache = path.join(home, ".clutch", "market", "index.json");
    const DEAD = "http://127.0.0.1:1/m/"; // a mirror that is not there: every read fails at once
    try {
      // (a) nothing on this machine yet: the copy this build ships is still a market
      const cold = chain([], home, { CLUTCH_SOURCE_MIRROR: DEAD });
      check(cold.fatal === undefined, `a cold start with no network still answers (${cold.fatal || "no throw"})`);
      check(
        cold.origin === "snapshot" && cold.entries === snapshot.entries.length,
        `and it lists every module this build shipped a row for (origin ${cold.origin}, ${cold.entries})`
      );
      check(/could not be read/.test(cold.note) && /this build ships/.test(cold.note), "saying in words that the live index was out of reach and which copy it drew instead");
      check(cold.unreachable === true, "and that the failure was the network — which is what offers a mirror");
      check(cold.errors.length === 0, "the snapshot itself is not an error: a remembered market is a market");
      check(cold.cacheWritten === false, "and a fallback is not cached: a copy this build ships is not a copy this machine heard");

      // (b) last good read: the cache outranks the snapshot, and says so
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      const remembered = { schema: 2, entries: [{ ...snapshot.entries[0], summary: "the summary this machine last heard" }] };
      fs.writeFileSync(cache, JSON.stringify(remembered));
      const warm = chain([], home, { CLUTCH_SOURCE_MIRROR: DEAD });
      check(warm.origin === "cache" && warm.entries === 1, `the last good copy on this machine outranks the shipped one (origin ${warm.origin}, ${warm.entries})`);
      check(/cached/.test(warm.note), "and the page is told it is drawing a remembered market, not this moment's");
      check(warm.unreachable === true, "the reason it is remembered is still the network");

      // (c) a cache this client cannot read is a tier that failed, not the end
      fs.writeFileSync(cache, JSON.stringify({ schema: 1, sources: ["https://example.invalid/x.json"] }));
      const stale = chain([], home, { CLUTCH_SOURCE_MIRROR: DEAD });
      check(
        stale.origin === "snapshot" && stale.entries === snapshot.entries.length,
        "a cache from an older shape is skipped, not obeyed: the build's own snapshot still answers"
      );

      // (d) a caller that names an index gets exactly it, and no chain
      const given = chain([SNAPSHOT], home, { CLUTCH_SOURCE_MIRROR: DEAD });
      check(given.origin === "given" && given.note === "" && given.entries === snapshot.entries.length, "an index a caller named is taken literally: no fallback, no note, no mirror");
      check(given.unreachable === false, "and nothing about it is a network problem");

      // (e) the live read: a proxy that answers in the mirror's place
      //     (the same shape CLUTCH_SOURCE_MIRROR ships, exercised end to end in
      //     tests/net-fetch.test.js — here only that a live copy is what wins)
      const live = { schema: 2, entries: [{ ...snapshot.entries[0], summary: "the live market" }] };
      const liveDir = tmp("clutch-market-live-");
      const liveFile = path.join(liveDir, "index.json");
      fs.writeFileSync(liveFile, JSON.stringify(live));
      const read = await components.readIndex({ index: liveFile });
      check(read.origin === "given" && read.entries[0].summary === "the live market", "a live index is read as it stands, and its rows are the ones drawn");
      fs.rmSync(liveDir, { recursive: true, force: true });

      // (f) the tier order is the code's, not this test's: the shipped snapshot is
      //     the last step, and it is reachable from a build with nothing else
      check(path.basename(components.SNAPSHOT_FILE) === "market.snapshot.json", "the shipped tier is the file beside ui/components.js (inside the asar once packaged)");
      check(fs.existsSync(components.SNAPSHOT_FILE), "and it is actually in the bundle: verify-build-config.js asserts the same file");
      check(/\/releases\/download\/market\/index\.json$/.test(components.INDEX_URL), "the live tier is one URL at a fixed tag: a new row never needs a new client");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => summary("market"))
  .catch((e) => {
    console.log("FAIL: uncaught: " + ((e && e.stack) || e));
    process.exit(1);
  });
