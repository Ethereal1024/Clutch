"use strict";

// The /api/* seam contract (docs/ssh-scheme-plan.md §5), kept honest in two parts.
//
// A, C and B render the same renderer; A and C answer it over HTTP from the Python
// host, B answers the same routes in-process from ui/host/api.js. The payloads must
// therefore be equal, and the goldens in tests/fixtures/conformance/ are what
// "equal" means. tests/conformance_capture.py writes them from the real Python
// host; this runner is the other half:
//
//   1. the fixture set is COMPLETE and SELF-CONSISTENT (every endpoint in the
//      manifest has its file, every case it lists is there, every recorded status
//      is a number, and no golden leaked a machine path through the <ROOT>/<HOME>/
//      <TMP> normalization).
//
// (The second half this file used to carry — the four file tools' frozen text,
// compared between `clutch-workspace`'s CLI and the host's own implementation for
// a root on another machine — is gone with that host-side copy: the four are the
// component's alone now, and its own suite under clutch-workspace/tests is what
// holds their text.)
//
// `pending` is the M0 deliverable, not a TODO: it names the milestone that owes the
// route. When ui/host/api.js exists, an endpoint flips to `enforced` in
// tests/fixtures/conformance/manifest.json and THIS file starts comparing it
// case-by-case; an `enforced` endpoint with no in-process handler is a failure, so
// the marker cannot be flipped by wishful editing.
//
// Run: node tests/conform.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const FIX = path.resolve(__dirname, "fixtures", "conformance");
const MANIFEST = path.join(FIX, "manifest.json");

// The in-process host the M1/M4 milestones add (ui/host/api.js). Absent in the
// M0-only state: then every endpoint must still be `pending`, and this runner
// asserts exactly that.
function loadHost() {
  try {
    return require(path.resolve(__dirname, "..", "ui", "host", "api.js"));
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes("ui/host/api.js")) return null;
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(path.join("ui", "host", "api"))) return null;
    throw e;
  }
}

// The stateful half of the comparison: a per-route runner replays every
// `enforced` endpoint against these goldens (it has to build a project, seed the
// journal, claim the .clc, or hold a log — state this runner has no way to
// invent). Each runner owns the endpoints it is the natural home for:
//
//   host-workspace.test.js  the in-process /api/* table (ui/host/api.js)
//   host-events.test.js     the SSE encoder and its catch-up (ui/host/events.js)
//
// Their union is therefore the ONLY acceptable content of the `enforced` set: a
// marker without a replay is a claim, and a replay without a marker is a route
// nobody classified.
const REPLAYERS = ["host-workspace.test.js", "host-events.test.js"];

function replayedEndpoints() {
  const covered = [];
  for (const file of REPLAYERS) {
    try {
      covered.push(...(require(`./${file}`).COVERED || []));
    } catch (e) {
      return { error: `${file}: ${(e && e.message) || String(e)}` };
    }
  }
  return covered;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---- 1. the fixture set --------------------------------------------------

function fixtureShape() {
  check(fs.existsSync(MANIFEST), "the goldens have a manifest (run python -m tests.conformance_capture)");
  if (!fs.existsSync(MANIFEST)) return null;
  const manifest = readJson(MANIFEST);
  check(manifest.format === 1, "manifest.format is the version this runner understands");
  check(Array.isArray(manifest.endpoints) && manifest.endpoints.length > 0, "the manifest lists endpoints");
  check(
    Array.isArray(manifest.normalizations) && manifest.normalizations.includes("<ROOT>"),
    "the manifest names the path tokens the goldens are normalized with"
  );

  const host = loadHost();
  const ids = new Set();
  let cases = 0;
  let pending = 0;
  let enforced = 0;

  for (const ep of manifest.endpoints) {
    check(!ids.has(ep.id), `${ep.id}: endpoint ids are unique`);
    ids.add(ep.id);
    check(["pending", "enforced"].includes(ep.status), `${ep.id}: has an enforcement marker`);
    if (ep.status === "pending") pending++;
    else enforced++;

    const file = path.join(FIX, ep.file);
    const here = fs.existsSync(file);
    check(here, `${ep.id}: its golden file exists (${ep.file})`);
    if (!here) continue;
    const doc = readJson(file);
    check(doc.endpoint === ep.id, `${ep.id}: the file names the endpoint it belongs to`);
    check(
      JSON.stringify(doc.cases.map((c) => c.id)) === JSON.stringify(ep.cases),
      `${ep.id}: the manifest lists exactly the cases in the file`
    );

    for (const c of doc.cases) {
      cases++;
      if ("frame" in c) {
        // an SSE frame is produced by the encoder, not by a request: its whole
        // contract is the bytes, so the case records the text and nothing else
        check(
          typeof c.frame === "string" && c.frame.startsWith("data: ") && c.frame.endsWith("\n\n"),
          `${ep.id}/${c.id}: records one framed SSE payload`
        );
        continue;
      }
      check(typeof c.status === "number" && Number.isInteger(c.status), `${ep.id}/${c.id}: records an HTTP status`);
      check(typeof c.method === "string" && c.method.length > 0, `${ep.id}/${c.id}: records the method`);
      check(typeof c.path === "string" && c.path.startsWith("/"), `${ep.id}/${c.id}: records the route`);
      check("body" in c || "ndjson" in c, `${ep.id}/${c.id}: records an answer`);
      if ("masked" in c) {
        // a masked field is compared by TYPE only: the value itself is the
        // machine's (a home listing), and freezing it would freeze this host
        const body = c.body || {};
        for (const key of c.masked) {
          check(
            body[key] && typeof body[key] === "object" && "__masked__" in body[key],
            `${ep.id}/${c.id}: masked field ${key} records its type, not its contents`
          );
        }
      }
    }
  }

  check(cases >= 30, `the fixture set covers the contract (${cases} cases)`);
  check(pending + enforced === manifest.endpoints.length, "every endpoint carries exactly one marker");

  if (host === null) {
    check(pending === manifest.endpoints.length, "no in-process host yet, so no endpoint is marked enforced");
    console.log(`note: ${pending} endpoint(s) pending -> ${manifest.endpoints.map((e) => `${e.id} (${e.owner})`).join(", ")}`);
  } else {
    check(enforced > 0, "an in-process host exists, so at least one endpoint is enforced");
    check(typeof host.createApi === "function", "ui/host/api.js exposes createApi(state)");
    check(typeof host.readBody === "function", "ui/host/api.js exposes readBody (the one body contract)");

    const covered = replayedEndpoints();
    if (!Array.isArray(covered)) {
      check(false, `a host runner must load (${covered.error})`);
    } else {
      const marked = manifest.endpoints
        .filter((e) => e.status === "enforced")
        .map((e) => e.id)
        .sort();
      const replayed = [...covered].sort();
      check(
        JSON.stringify(marked) === JSON.stringify(replayed),
        `every enforced endpoint is replayed by a host runner (${marked.join(", ") || "none"})`
      );
      for (const id of replayed) {
        check(manifest.endpoints.some((e) => e.id === id), `${id}: replayed endpoint exists in the manifest`);
      }
      console.log(`note: ${replayed.length} enforced, ${pending} pending -> ${manifest.endpoints.filter((e) => e.status === "pending").map((e) => `${e.id} (${e.owner})`).join(", ") || "none"}`);
    }
  }
  return manifest;
}

// ---- 1b. no golden may leak a machine path ------------------------------
//
// The capture replaces the workspace root, the home dir and the temp dir with
// tokens. A path it failed to replace would compare against the WRONG machine's
// path on the next host — silently, because the shape is right. Values only: an
// absolute path inside a sentence ("not a directory: <ROOT>/x") is legitimately
// only detected by the same rule applied to the whole string below.
const PATH_ALLOWLIST = new Set(["/nonexistent_clutch_xyz"]);

function leaks(value, where, out) {
  if (typeof value === "string") {
    if (value.startsWith("/")) {
      const ok = /^<(ROOT|HOME|TMP)>/.test(value) || PATH_ALLOWLIST.has(value);
      if (!ok) out.push(`${where}: ${value}`);
    } else {
      // a sentence can carry a path too: any absolute-looking run must be tokenized
      for (const m of value.match(/(?:^|[\s:'"])(\/[A-Za-z0-9_.-]+\/[^\s'"]*)/g) || []) {
        if (!/^[\s:'"]*<(ROOT|HOME|TMP)>/.test(m) && !PATH_ALLOWLIST.has(m.trim().replace(/^[\s:'"]+/, ""))) {
          out.push(`${where}: ${value}`);
        }
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => leaks(v, `${where}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) leaks(value[k], `${where}.${k}`, out);
  }
}

function noLeakedPaths(manifest) {
  const found = [];
  for (const ep of manifest.endpoints) {
    const doc = readJson(path.join(FIX, ep.file));
    // the case-level `path` is the HTTP ROUTE, not a filesystem path: check the
    // answers and the request bodies, which are the only places a machine path
    // can hide
    const checkable = doc.cases.map((c) => ({ body: c.body, ndjson: c.ndjson, frame: c.frame, request: c.request }));
    leaks(checkable, ep.id, found);
  }
  check(found.length === 0, `no golden carries a machine path (${found.length ? found.join(" | ") : "clean"})`);
}

async function main() {
  const manifest = fixtureShape();
  if (manifest) noLeakedPaths(manifest);
  summary("conform");
}

main().catch((e) => {
  check(false, `suite crashed: ${(e && e.stack) || e}`);
  summary("conform");
});
