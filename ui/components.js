// The install layer's SENDING half: getting a component's artifact onto the
// machine whose server will run it.
//
// A component belongs to the machine its server runs on (that is the whole
// point of agent/tools/components.py), so a client installs onto whichever host
// it is about to use — this desktop's supervisor, or the one on the other side
// of an SSH tunnel. Two facts decide whether anything is sent:
//
//   1. the HOST answers what it already holds (GET /api/components), and
//   2. the version gate is CONTENT: the artifact's sha256 is both the version it
//      is installed under and the digest the host compares, so an unchanged
//      artifact uploads nothing and a changed one always lands.
//
// Failure here is never fatal to a session: the pass runs in the background and
// a tool whose component has not landed is simply not offered (the host keeps
// no stand-in for it), so every error is reported and the session proceeds.
//
// Where an artifact comes from:
//   - packaged app: resources/components/<name>-<platform>  (shipped by the release)
//   - a dev build:  dist/components/<name>-<platform>
//   - a dev checkout: the checkout, archived on demand (scripts/build-component-tar.sh),
//     cached under ~/.clutch/artifacts by a source fingerprint, since the
//     checkout is code a host with no artifact of its own can still run under
//     python (the shape rendezvous.py's template launch describes).
//
// The declaration comes from the same places, as component.json (the checkout's
// own, or the release's <dir>/<name>/component.json) — see declarationFor.

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveBash, platformTag, isPackagedApp, fileHash, treeHash } = require("./server-bundle");

const REPO = path.join(__dirname, "..");
const CACHE = path.join(os.homedir(), ".clutch", "artifacts");
const TAR_SCRIPT = path.join(REPO, "scripts", "build-component-tar.sh");
const MANIFEST_HEADER = "X-Clutch-Component"; // agent/tools/components.py's contract: base64 of UTF-8 JSON
const REQUEST_TIMEOUT_MS = 120_000; // a onefile over a slow link
const BUDGET_MS = 300_000; // the whole pass; beyond it the rest is deferred

// What a host has to have to serve the tools a session offers. The host's own
// table (agent/tools/rendezvous.py) is what it accepts; this is the client's
// list of what to ship, and the interface is the manifest's claim about how the
// artifact is spoken to.
const COMPONENTS = [
  { name: "clutch-workspace", interface: "daemon" },
  { name: "clutch-memory", interface: "cli" },
  { name: "clutch-websearch", interface: "cli" },
  { name: "clutch-skills", interface: "cli" },
];

const SKIP_DIRS = new Set([".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "node_modules"]);

// A prebuilt artifact: the app's own resources, or a dev build. Both are single
// files the release produced (a PyInstaller onefile), so nothing is built here.
function shippedArtifact(name) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const tag = platformTag();
  const dirs = [];
  if (isPackagedApp()) dirs.push(path.join(process.resourcesPath, "components"));
  dirs.push(path.join(REPO, "dist", "components"));
  for (const dir of dirs) {
    for (const file of [`${name}-${tag}${exe}`, `${name}${exe}`, `${name}-${tag}.tar.gz`, `${name}.tar.gz`]) {
      const p = path.join(dir, file);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (e) {
        /* keep looking */
      }
    }
  }
  return null;
}

// The declaration that travels WITH the artifact (COMPONENTS.md): the same
// component.json the host discovers. Searched beside the artifact — the packaged
// release ships it as resources/components/<name>/component.json, a dev build
// under dist/components/, and a dev checkout IS one — so an install lands with
// the component's whole declaration (tools, launch, ui), not just install
// facts. A host that receives only the bytes of a declaring archive would still
// merge the artifact's own manifest (agent/tools/components.py), but the header
// is the declaration of record for the release's bare onefile artifacts.
function declarationFor(name) {
  const dirs = [];
  if (isPackagedApp()) dirs.push(path.join(process.resourcesPath, "components"));
  dirs.push(path.join(REPO, "dist", "components"), path.join(REPO, name));
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, "component.json"), "utf8"));
      if (parsed && parsed.name === name) return parsed;
    } catch (e) {
      /* keep looking */
    }
  }
  return null;
}

// The checkout, fingerprinted: an edited source has to produce a new artifact
// (and so pass the host's gate), an untouched one has to upload nothing.
function sourceFingerprint(dir) {
  return treeHash([dir], {
    base: dir,
    skipDirs: SKIP_DIRS,
    skipFile: (p) => p.endsWith(".pyc"),
  });
}

// The dev fallback artifact: the checkout as a tar, members at its top level (the
// install directory IS the component's own directory, so `memory.py` has to be
// at its root, not inside a `<name>/` subtree).
function checkoutArtifact(name) {
  const src = path.join(REPO, name);
  if (!fs.existsSync(path.join(src, "pyproject.toml"))) return null; // not a checkout
  const out = path.join(CACHE, `${name}-${platformTag()}-${sourceFingerprint(src).slice(0, 16)}.tar.gz`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const r = spawnSync(resolveBash(), [TAR_SCRIPT, src, tmp], { stdio: "pipe" });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* never created */
    }
    return null;
  }
  fs.renameSync(tmp, out);
  return out;
}

// The artifact this client would send for one component, or null when it has
// none: `checkout` is false for the machine that already holds the checkout
// beside the host repo (there is nothing to send it that it does not have).
function artifactFor(spec, { checkout = true } = {}) {
  const file = shippedArtifact(spec.name) || (checkout ? checkoutArtifact(spec.name) : null);
  if (!file) return null;
  const digest = fileHash(file);
  return { ...spec, declaration: declarationFor(spec.name), path: file, digest, version: digest.slice(0, 16) };
}

// What the host already holds (the version gate's first half).
async function hostInventory(base, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/components`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`the host answered ${r.status} to /api/components`);
    const body = await r.json();
    return Array.isArray(body.components) ? body.components : [];
  } finally {
    clearTimeout(t);
  }
}

async function upload(base, spec, timeoutMs) {
  const data = fs.readFileSync(spec.path);
  // the manifest is the component's own declaration with the install facts on
  // top — a remote host that never saw the checkout still receives a component
  // it can drive, because the declaration rode with the artifact
  const manifest = {
    ...(spec.declaration || {}),
    name: spec.name,
    version: spec.version,
    interface: spec.interface,
    digest: spec.digest,
    artifact: path.basename(spec.path), // its suffix is how the host reads the shape
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/components/install`, {
      method: "POST",
      headers: {
        [MANIFEST_HEADER]: Buffer.from(JSON.stringify(manifest), "utf8").toString("base64"),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
      },
      body: data,
      signal: ctl.signal,
    });
    const text = await r.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (e) {
      /* a non-JSON body is reported below as the status */
    }
    if (!r.ok) throw new Error(body.error || `install refused (${r.status})`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

// Make sure `base`'s machine holds every component this client can give it.
// Never throws: the returned summary is what the caller logs, and components
// that were deferred or refused simply stay absent — the host then offers no
// tool for them, because it has no implementation of its own to fall back to.
async function ensureComponents(base, { checkout = true, progress = null, budgetMs = BUDGET_MS } = {}) {
  const out = { current: [], installed: [], skipped: [], deferred: [], errors: [] };
  const say = (msg) => {
    if (progress) progress(msg);
  };
  let have;
  try {
    have = await hostInventory(base);
  } catch (e) {
    out.errors.push({ name: "", reason: `the host did not answer: ${e && e.message}` });
    return out;
  }
  const deadline = Date.now() + budgetMs;
  for (const spec of COMPONENTS) {
    const file = artifactFor(spec, { checkout });
    if (!file) {
      out.skipped.push(spec.name);
      continue;
    }
    const held = have.find((h) => h.name === spec.name);
    if (held && held.version === file.version && held.digest === file.digest) {
      out.current.push(spec.name);
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      out.deferred.push(spec.name);
      continue;
    }
    try {
      const res = await upload(base, file, Math.max(Math.min(left, REQUEST_TIMEOUT_MS), 1000));
      (res.status === "current" ? out.current : out.installed).push(spec.name);
      say(`${spec.name} ${res.status}`);
    } catch (e) {
      out.errors.push({ name: spec.name, reason: e && e.message });
      say(`${spec.name} failed: ${e && e.message}`);
    }
  }
  return out;
}

module.exports = { COMPONENTS, ensureComponents, artifactFor, checkoutArtifact, hostInventory, CACHE };
