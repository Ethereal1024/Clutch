// The supply line's two network questions, checked without a network
// (ui/net-fetch.js):
//
//   1. the MIRROR — one prefix, applied where a source becomes a URL, so the list
//      this build ships is read through it and everything a manifest names stays
//      its SIBLING: the manifest, the declaration, and the URL the TARGET machine
//      fetches for itself. The digest is untouched by any of it (a mirror carries
//      bytes, it does not vouch for them), and a list somebody wrote by hand — the
//      user's own, or a caller's — is taken literally instead.
//   2. the FETCH — which implementation a remote read uses. Inside Electron that
//      is Chromium's net.fetch (the machine's proxy configuration, applied by the
//      stack rather than by us); this runner is plain node, so what it can exercise
//      is the fallback every test, script and phone takes — including the part that
//      matters most: the caller's AbortSignal still bounds the read.
//
// Run: node tests/net-fetch.test.js

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// A sandbox HOME BEFORE the requires: components.js reads the user's source list
// and caches under ~/.clutch, and settings.json is the mirror's other home.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-net-fetch-home-"));
const SETTINGS = path.join(HOME, ".clutch", "settings.json");
if (process.platform !== "win32") {
  process.env.HOME = HOME; // os.homedir() reads it; win32 reads USERPROFILE (skipped below)
} else {
  fs.rmSync(HOME, { recursive: true, force: true });
}

const { check, summary } = require("./harness");
const { netFetch, mirrorPrefix, mirrored } = require("../ui/net-fetch");
const components = require("../ui/components");

const ROOT = path.join(__dirname, "..");
const SRC = "https://github.com/Ethereal1024/clutch-skills/releases/download/v0.1.1/clutch-component.json";
const MIRROR = "https://ghproxy.invalid/";

function writeSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, typeof data === "string" ? data : JSON.stringify(data));
}

// A stand-in for an accelerator: anything under /m/ is served by FILE NAME, with
// the absolute URL it carries taken as the mirror's own business (a real one maps
// it; this one only has to record what the client asked for).
function serveMirror(files) {
  const state = { seen: [], server: null };
  const server = http.createServer((req, res) => {
    state.seen.push(req.url);
    const name = decodeURIComponent(req.url.split("?")[0]);
    const base = name.split("/").pop();
    if (!name.startsWith("/m/") || !Object.prototype.hasOwnProperty.call(files, base)) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Length": String(files[base].length) });
    res.end(files[base]);
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      resolve(state);
    });
  });
}

// A server that accepts a connection and never answers: the only way to prove a
// timeout still fires is to watch one not fire.
function serveSilence() {
  const server = http.createServer(() => {});
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function sha256(buf) {
  return require("crypto").createHash("sha256").update(buf).digest("hex");
}

async function main() {
  // ---- 1. the mirror, as a function -------------------------------------
  check(mirrored(SRC, "") === SRC, "no prefix: a source is read exactly where it points");
  check(
    mirrored(SRC, MIRROR) === MIRROR + SRC,
    "a prefix mirrors the source: <mirror>/<the absolute url> (path preserved, so siblings keep resolving)"
  );
  check(mirrored(SRC, "https://ghproxy.invalid///") === MIRROR + SRC, "a trailing slash on the prefix is the same mirror, not a second one");
  check(mirrored(MIRROR + SRC, MIRROR) === MIRROR + SRC, "a source already under the prefix is not mirrored twice");
  check(mirrored("/opt/components/clutch-component.json", MIRROR) === "/opt/components/clutch-component.json", "a source on disk has no mirror and is left alone");
  check(mirrored("http://lan.local/clutch-component.json", MIRROR) === MIRROR + "http://lan.local/clutch-component.json", "an http source is mirrored like an https one");
  check(mirrored(SRC, "ghproxy.invalid") === SRC, "a prefix that is not http(s) is dropped, not obeyed into a URL nobody serves");

  // ---- 2. where the prefix comes from -----------------------------------
  check(mirrorPrefix() === "", "no env and no setting: no mirror (the pre-existing behavior, unchanged)");
  writeSettings({ source_mirror: MIRROR });
  check(mirrorPrefix() === MIRROR.replace(/\/$/, ""), "source_mirror in ~/.clutch/settings.json is a mirror a GUI launch can have");
  process.env.CLUTCH_SOURCE_MIRROR = "https://env.invalid/";
  check(mirrorPrefix() === "https://env.invalid", "the environment wins: a shell that sets it is this run's answer");
  delete process.env.CLUTCH_SOURCE_MIRROR;
  writeSettings({ source_mirror: "ghproxy.invalid" });
  check(mirrorPrefix() === "", "a settings value that is not http(s) is ignored like an env one");
  writeSettings({ profiles: { work: { source_mirror: MIRROR } }, active: "work" });
  check(mirrorPrefix() === MIRROR.replace(/\/$/, ""), "a legacy {profiles, active} settings file mirrors the active profile");
  fs.rmSync(SETTINGS);

  // ---- 3. the fetch a remote read uses ----------------------------------
  check(!process.versions.electron, "this runner is plain node: the Chromium stack the app gets cannot be exercised here");
  check(typeof netFetch() === "function", "outside Electron, netFetch() hands back a working fetch");
  const alive = await serveMirror({ "hello.json": Buffer.from(JSON.stringify({ ok: true })) });
  try {
    const r = await netFetch()(alive.base + "/m/hello.json");
    check(r.ok && (await r.json()).ok === true, "and it is the global fetch: a real request, a real response");
    const silent = await serveSilence();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 100);
      let aborted = null;
      try {
        await netFetch()(silent.base + "/never", { signal: ctl.signal });
      } catch (e) {
        aborted = e;
      } finally {
        clearTimeout(t);
      }
      check(
        !!aborted && /abort/i.test(aborted.name + aborted.message),
        "the caller's signal comes through untouched: every timeout in components.js is still a bound"
      );
    } finally {
      silent.server.close();
    }
  } finally {
    alive.server.close();
  }

  // ---- 4. the ONE index, read through the mirror -------------------------
  // What a build carries is no longer a list of module URLs but ONE document
  // every client and every version reads (ui/components.js readIndex). A mirror
  // is still the one string that moves it, and a caller who names an index of
  // its own is taken literally — write the URL (or path) you mean.
  check(
    components.INDEX_URL === "https://github.com/Ethereal1024/Clutch/releases/download/market/index.json",
    "the build names one index, at a fixed tag: a client version never has to learn a new URL"
  );
  check(mirrorPrefix() === "", "with no mirror, the index is read exactly where it points");
  check(mirrored(components.INDEX_URL, MIRROR) === MIRROR + components.INDEX_URL, "a prefix moves the index like any other source");

  const market = await serveMirror({ "index.json": Buffer.from(JSON.stringify({ schema: 2, entries: [] })) });
  process.env.CLUTCH_SOURCE_MIRROR = market.base + "/m/";
  try {
    const read = await components.readIndex();
    check(
      read.origin === "remote" && read.errors.length === 0 && read.entries.length === 0,
      "the index is read through the prefix, and what it holds is the market"
    );
    check(
      market.seen.includes(`/m/${components.INDEX_URL}`),
      `and the mirror was asked for it by its absolute URL (${market.seen.join(", ")})`
    );
    const given = await components.readIndex({ index: path.join(ROOT, "ui", "market.snapshot.json") });
    check(
      given.origin === "given" && given.entries.length > 0,
      "a caller's own index is taken literally: an index written down is not sent through an accelerator"
    );
  } finally {
    market.server.close();
    delete process.env.CLUTCH_SOURCE_MIRROR;
  }

  // ---- 5. one prefix moves the whole supply line -------------------------
  // A market and release stand-in, served BY the mirror only: the index names the
  // release and pins its manifest, the manifest names its declaration and its
  // artifact as siblings exactly as a real one does, and the URLs the client ends
  // up holding are the mirror's.
  const decl = Buffer.from(JSON.stringify({ name: "clutch-memory", interface: "cli", version: "9.9.9" }));
  const artifact = Buffer.from("the artifact's bytes are the target machine's business, not this client's");
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      name: "clutch-memory",
      interface: "cli",
      version: "9.9.9",
      declaration: { asset: "component.json", sha256: sha256(decl) },
      artifacts: { any: { asset: "clutch-memory-any.tar.gz", sha256: sha256(artifact) } },
    })
  );
  const manifestUrl = "https://github.com/Ethereal1024/clutch-memory/releases/download/v9.9.9/clutch-component.json";
  const index = Buffer.from(
    JSON.stringify({
      schema: 2,
      entries: [
        {
          id: "Ethereal1024/clutch-memory",
          name: "clutch-memory",
          manifest: manifestUrl,
          manifest_sha256: sha256(manifest),
          version: "9.9.9",
          interface: "cli",
          runs_on: "self",
        },
      ],
    })
  );
  const release = await serveMirror({
    "index.json": index,
    "clutch-component.json": manifest,
    "component.json": decl,
    "clutch-memory-any.tar.gz": artifact,
  });
  process.env.CLUTCH_SOURCE_MIRROR = release.base + "/m/";
  try {
    const specs = await components.componentSpecs({});
    const spec = specs.specs.find((s) => s.name === "clutch-memory");
    check(
      Boolean(spec && spec.published && spec.published.source === `${release.base}/m/${manifestUrl}`),
      "the index is read through the mirror, the manifest it names too, and the manifest knows where it came from"
    );
    const handed = await components.artifactFor(spec, { checkout: false });
    const expected = `${release.base}/m/${manifestUrl.replace(/clutch-component\.json$/, "clutch-memory-any.tar.gz")}`;
    check(
      Boolean(handed && !handed.path && handed.url === expected),
      `the artifact the TARGET machine fetches is the mirror's own sibling URL (${handed && handed.url})`
    );
    check(
      Boolean(handed && handed.digest === sha256(artifact) && handed.artifact === "clutch-memory-any.tar.gz"),
      "and the pin is the release's own digest, unchanged: the mirror carries bytes, it does not vouch for them"
    );
    check(
      release.seen.length > 0 && release.seen.every((u) => u.startsWith("/m/https://github.com/")),
      `every read went through the mirror, none around it (${release.seen.join(", ")})`
    );
    check(
      !release.seen.some((u) => /clutch-memory-any\.tar\.gz/.test(u)),
      "and the artifact itself was never fetched here: the bytes are the target machine's to get"
    );
  } finally {
    release.server.close();
    delete process.env.CLUTCH_SOURCE_MIRROR;
  }

  fs.rmSync(HOME, { recursive: true, force: true });
}

main()
  .then(() => summary("net-fetch"))
  .catch((e) => {
    console.log("FAIL: uncaught: " + ((e && e.stack) || e));
    process.exit(1);
  });
