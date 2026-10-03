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
// The same supervisor also answers the reverse direction, and it is the same
// gate read backwards: `hostVersions()` asks which versions a machine holds (and
// which one it would run), `hostRemove()` asks it to let one go. Nothing here
// decides whether that is allowed — the machine that would RUN the component is
// the only side that knows if something is running it, so its refusal comes back
// as its own sentence rather than as a status this file interprets.
//
// The third verb changes no bytes at all: `hostSetDisabled()` asks a machine to
// stop DRIVING a component it holds, or to start again. That is a fact about the
// machine that owns the component — its tools are offered there, or not — so it
// is stored in that machine's own registry table and asked for over the same
// channel, never mirrored here.
//
// Failure here is never fatal to a session: the pass runs in the background and
// a tool whose component has not landed is simply not offered (the host keeps
// no stand-in for it), so every error is reported and the session proceeds.
//
// Where the component comes from — and why this file names none
// ------------------------------------------------------------
// The host ships NO component: not its code, not its artifact, and not a roster
// either. What rides in the app is a list of SOURCES (components.sources.json
// beside this file, plus an optional ~/.clutch/components.sources.json), and a
// source is a MODULE's own release manifest: the module declares its name, its
// interface, where its declaration (component.json) is, and where its artifact
// is per platform. So a release of the host never depends on any module — and a
// module is added to a build by naming a URL, without editing code, or added by
// a user without editing this repo at all.
//
// This is the client-side twin of the host's own discovery (agent/tools/
// catalog.py): the host discovers what is absent-mindedly BESIDE it, the client
// fetches what the module PUBLISHED, and both end at the same wire contract.
//
// Three sources, in the order they win:
//   - a dev checkout beside the host repo: the component's own component.json
//     IS its declaration and the checkout IS its artifact, tarred on demand
//     (scripts/build-component-tar.sh). A contributor's edit therefore beats the
//     published release, which is what makes module development possible.
//   - a dev build:  dist/components/<name>-<platform>  (a onefile built by hand)
//   - a published release: the module's manifest -> its per-platform asset. Its
//     bytes are fetched by the TARGET machine itself, and the sha256 the module's
//     own manifest pinned is what that machine weighs them against (an unpinned
//     artifact is refused here, not guessed at) — so this client never has to
//     hold the tens of megabytes it is installing, which is what makes an
//     install from a phone sane (PLUGIN_PLAN.md 零之四.4). Bytes only this
//     machine has (the two sources above) still travel in the request body.
//
// The declaration comes from the same places: the checkout's own component.json,
// the release's component.json asset (digest-pinned the same way), or — for an
// archive that carries its own manifest — nowhere at all, since the host merges
// what the artifact says about itself (agent/tools/components.py).

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
const ARTIFACT_URL_FIELD = "artifact_url"; // where the bytes are, when the host fetches them for itself
const REQUEST_TIMEOUT_MS = 120_000; // a onefile over a slow link
const MANIFEST_TIMEOUT_MS = 30_000; // a few KB of JSON, from a release
const BUDGET_MS = 300_000; // the whole pass; beyond it the rest is deferred

// The source lists: what this build knows, and what this user added. Both are
// data — the shape is the manifest spec's (schema 1), and a source is either an
// https URL to a module's release manifest or a path to the same file on disk.
const SOURCES_FILE = path.join(__dirname, "components.sources.json");
const USER_SOURCES_FILE = path.join(os.homedir(), ".clutch", "components.sources.json");
const SCHEMA = 1;

const SKIP_DIRS = new Set([".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "node_modules"]);

// ---------------------------------------------------------------- the sources --

// One source list: the file's `sources` array, or [] when there is no file (a
// build with no list installs nothing, and says so — never a crash).
function readSourceList(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [];
  }
  if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.sources)) return [];
  return parsed.sources.filter((s) => typeof s === "string" && s);
}

// The sources one pass installs from. In order: the user's list first, then the
// list this build shipped — the first manifest that names a component is the one
// that ships, so a user can override a module this build knows by naming their
// own, and the shipped list is the fallback. A caller that names its own list
// (a packager pointing a build at a mirror, a test) gets exactly that list.
function sources(explicit = null) {
  if (Array.isArray(explicit)) return explicit.filter((s) => typeof s === "string" && s);
  const out = [];
  for (const file of [USER_SOURCES_FILE, SOURCES_FILE]) {
    for (const s of readSourceList(file)) if (!out.includes(s)) out.push(s);
  }
  return out;
}

// A source is a URL or a local path; this is the one place the difference is
// read, so a source works the same wherever it came from.
function isRemote(source) {
  return /^https?:\/\//i.test(source);
}

// One asset of a source: the manifest is the source itself, everything else it
// names is its sibling — so a module's release needs no knowledge of its own
// absolute URL, and a directory of artifacts on disk works the same way.
function assetLocation(source, asset) {
  return isRemote(source) ? new URL(asset, source).toString() : path.join(path.dirname(source), asset);
}

// One module's manifest, validated the way the host validates a declaration:
// a word this client cannot read is refused rather than guessed at. The
// `declaration` the manifest names is a LOCATION (an asset plus its digest), not
// a declaration: the file itself is fetched (and pinned) only when a client
// actually has to hand it to a host, so a manifest stays a few hundred bytes.
function parseManifest(data, source) {
  if (!data || typeof data !== "object") throw new Error("the manifest is not a JSON object");
  if (data.schema !== SCHEMA) throw new Error(`unknown manifest schema ${JSON.stringify(data.schema)}`);
  if (typeof data.name !== "string" || !data.name) throw new Error("the manifest names no component");
  const artifacts = data.artifacts && typeof data.artifacts === "object" ? data.artifacts : {};
  return {
    name: data.name,
    interface: typeof data.interface === "string" ? data.interface : "",
    version: typeof data.version === "string" ? data.version : "",
    declaration: null, // what this client will send: filled from the asset below
    declarationRef: data.declaration && typeof data.declaration === "object" ? data.declaration : null,
    artifacts,
    source,
  };
}

async function readManifest(source) {
  if (!isRemote(source)) {
    return parseManifest(JSON.parse(fs.readFileSync(source, "utf8")), source);
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const r = await fetch(source, { signal: ctl.signal });
    if (!r.ok) throw new Error(`the source answered ${r.status}`);
    return parseManifest(await r.json(), source);
  } finally {
    clearTimeout(t);
  }
}

// Every component this client currently knows of, and why any source was
// unreadable. Data, never a throw: one module's release being down must not stop
// the others from installing.
async function manifests(explicit = null) {
  const out = { components: [], errors: [] };
  for (const source of sources(explicit)) {
    try {
      const manifest = await readManifest(source);
      if (out.components.some((c) => c.name === manifest.name)) continue; // the earlier source is the word
      out.components.push(manifest);
    } catch (e) {
      out.errors.push({ name: "", reason: `${source}: ${(e && e.message) || e}` });
    }
  }
  return out;
}

// ------------------------------------------------------------ local sources --

// A prebuilt artifact sitting on this machine: a dev build, or whatever a
// platform packager placed in the app's resources (nothing, today — the release
// ships no component bytes, which is the point).
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

// The declaration a checkout carries: the component's own component.json, which
// travels with the artifact's bytes when the artifact IS the checkout.
function checkoutDeclaration(name) {
  const p = path.join(REPO, name, "component.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && parsed.name === name) return parsed;
  } catch (e) {
    /* not a checkout, or not readable */
  }
  return null;
}

// The components checked out beside the host repo: the whole development path,
// read from the same manifests the host itself discovers (one file per module,
// nothing here that has to be kept in step).
function checkoutComponents() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(REPO, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const declaration = checkoutDeclaration(entry.name);
    if (!declaration) continue;
    out.push({
      name: declaration.name,
      interface: typeof declaration.interface === "string" ? declaration.interface : "",
      declaration,
      checkout: true,
      source: path.join(REPO, entry.name),
    });
  }
  return out;
}

// ----------------------------------------------------------- remote source --

// Download once, into a name that carries the digest the manifest pinned: a
// second pass finds the file and needs no network, and a manifest that changes
// its bytes changes the name. What still comes down through here is the
// DECLARATION (a few hundred bytes, and it has to be inlined into the manifest a
// host reads); an ARTIFACT's bytes are the target machine's to fetch, not this
// client's (PLUGIN_PLAN.md 零之四.4).
async function downloadPinned(url, sha256, dest, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (fs.existsSync(dest)) return dest;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`the artifact answered ${r.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    const got = fileHash(tmp);
    if (got !== sha256) throw new Error(`${url} has sha256 ${got}, not the ${sha256} its manifest pins`);
    fs.renameSync(tmp, dest);
    return dest;
  } finally {
    clearTimeout(t);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (e) {
      /* never created */
    }
  }
}

// The asset one entry names, `{asset, sha256}` or the asset name alone — a bare
// name is a manifest that pinned nothing, and it is refused rather than trusted.
function pinnedAsset(entry, what, name) {
  const asset = typeof entry === "string" ? entry : entry && entry.asset;
  const sha256 = typeof entry === "string" ? "" : entry && entry.sha256;
  if (typeof asset !== "string" || !asset) throw new Error(`the ${name} manifest names no ${what}`);
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) {
    throw new Error(`the ${name} manifest pins no sha256 for ${what} ${asset} — an unpinned artifact is refused`);
  }
  return { asset, sha256 };
}

// The artifact a published manifest points at for THIS platform, or why there is
// none: the exact platform key, else `any` (a shape that needs no per-platform
// build — the tar of a pure-Python component is one).
//
// What comes back is a LOCATION plus the digest the release pinned it with, not
// bytes: the machine that will RUN the component fetches it and is measured
// against that pin (PLUGIN_PLAN.md 零之四.4). So this client can hand over an
// install it has never held, which is the point — and the pin keeps a URL from
// being a weaker promise than a body.
function publishedArtifact(manifest) {
  const tag = platformTag();
  const entry = manifest.artifacts[tag] || manifest.artifacts.any;
  if (!entry) return { problem: `no artifact for ${tag} in its manifest` };
  const { asset, sha256 } = pinnedAsset(entry, "artifact", manifest.name);
  return { url: assetLocation(manifest.source, asset), artifact: path.basename(asset), digest: sha256 };
}

// The declaration that rode with a release: its component.json asset, pinned by
// digest like the artifact. An archive that carries its own manifest needs none,
// so a manifest without a `declaration` is legal and lands as a thinner install.
async function remoteDeclaration(manifest) {
  if (!manifest.declarationRef) return null;
  const { asset, sha256 } = pinnedAsset(manifest.declarationRef, "declaration", manifest.name);
  const dest = path.join(CACHE, `${manifest.name}-${sha256.slice(0, 16)}-component.json`);
  await downloadPinned(assetLocation(manifest.source, asset), sha256, dest, MANIFEST_TIMEOUT_MS);
  const parsed = JSON.parse(fs.readFileSync(dest, "utf8"));
  if (!parsed || parsed.name !== manifest.name) {
    throw new Error(`the declaration names ${parsed && parsed.name}, not ${manifest.name}`);
  }
  return parsed;
}

// ------------------------------------------------------------------- the pass --

// Every component this client could install, split by where its bytes come from.
// Never throws: an unreadable source is a report, and the pass goes on without it.
async function componentSpecs({ sources: list = null } = {}) {
  const out = { specs: [], errors: [] };
  out.specs.push(...checkoutComponents()); // a contributor's edit beats a release
  const byName = new Map(out.specs.map((s) => [s.name, s]));
  const fetched = await manifests(list);
  out.errors.push(...fetched.errors);
  for (const manifest of fetched.components) {
    const checkout = byName.get(manifest.name);
    if (checkout) {
      // a checkout's own bytes win, but the release it published stays reachable
      // under it: a machine that already HOLDS the checkout has nothing to
      // receive, and the published artifact is then the only thing to hand over
      checkout.published = manifest;
      continue;
    }
    const spec = { ...manifest, checkout: false };
    byName.set(spec.name, spec);
    out.specs.push(spec);
  }
  return out;
}

// The version ONE install is recorded under: the component's own version with
// the content digest appended — `0.1.0+<hex16>`. The host already reads that
// shape (agent/tools/components.py `_VERSION_RE`, and COMPONENTS.md says an
// installed manifest may carry it), so nothing new is being asked of it; what it
// buys is a version a client can LIST. A bare digest is an identity, not a
// version: a host holding only that can say which bytes it has but not which
// release, and an upgrade or a rollback has to be asked FOR a version.
//
// A spec that names no version (a bare `{name, interface}`) still sends the
// digest alone — an identity is all this client has, and inventing a version
// would be a claim it cannot back. A version that already carries a digest is
// handed over as it stands, rather than suffixed twice.
function installVersion(named, digest) {
  const short = digest.slice(0, 16);
  const version = named && typeof named.version === "string" ? named.version.trim() : "";
  if (!version) return short;
  return version.includes("+") ? version : `${version}+${short}`;
}

// The artifact one install would hand over, or null when there is none. Where the
// bytes ARE decides which of the two shapes the install takes (PLUGIN_PLAN.md
// 零之四.4):
//
//   - `path`: bytes on THIS machine — a checkout beside the host repo, a prebuilt
//     artifact beside the app. There is nothing to fetch them from, so they travel
//     in the request body (`upload()` at the bottom of this file).
//   - `url`: the release published them, and the TARGET machine fetches them
//     itself (`fetchInstall()`). `artifact` is the file's own name, because its
//     suffix is how a host reads the artifact's shape, and `digest` is the pin the
//     release declared — the receiving host measures what it fetched against it.
//
// `checkout` is false for the machine that already holds the checkout beside the
// host repo (there is nothing to send it that it does not have, so a checkout
// spec falls back to the release its module published, if any).
async function artifactFor(spec, { checkout = true } = {}) {
  const local = shippedArtifact(spec.name) || (checkout ? checkoutArtifact(spec.name) : null);
  if (local) {
    // the bytes are this machine's own: the declaration is the one that travels
    // with them — the checkout's own component.json, which is a checkout's whole
    // point (an edited manifest describes the edited code beside it)
    const declaration = spec.declaration || (spec.published ? await remoteDeclaration(spec.published) : null);
    const digest = fileHash(local);
    return { ...spec, declaration, path: local, digest, version: installVersion(declaration || spec, digest) };
  }
  const published = spec.published || (spec.checkout ? null : spec);
  if (!published || !published.artifacts) return null; // nothing here and nothing published
  const remote = publishedArtifact(published);
  if (remote.problem) throw new Error(remote.problem);
  const declaration = await remoteDeclaration(published);
  return {
    ...spec,
    // the published bytes are described by the published declaration, never by a
    // checkout's (the two can disagree the moment a contributor edits one)
    declaration,
    url: remote.url, // the target machine's own fetch: no copy of this here
    artifact: remote.artifact, // its own file name, so the host reads its shape
    digest: remote.digest,
    // the release's own manifest names its version too, and a manifest that pins
    // no separate declaration is a legal (thinner) install
    version: installVersion(declaration || published, remote.digest),
  };
}

// One JSON call to a machine's component endpoints, with the timeout every
// caller in this file passes. A refusal comes back as the HOST's own sentence
// (`{"error": …}`, the shape every component endpoint refuses with): "that
// version is not installed" and "a daemon is running it" are outcomes a page has
// to be able to quote, and a bare status code would leave it guessing which.
async function hostJSON(url, { method = "GET", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, signal: ctl.signal });
    const text = await r.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (e) {
      /* a non-JSON body is reported below as the status */
    }
    if (!r.ok) throw new Error(body.error || `${method} ${url} answered ${r.status}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

// What the host already holds (the version gate's first half).
async function hostInventory(base, timeoutMs = REQUEST_TIMEOUT_MS) {
  const body = await hostJSON(`${base}/api/components`, { timeoutMs });
  return Array.isArray(body.components) ? body.components : [];
}

// Every version of ONE component this machine holds, newest first and with
// `resolved` marking the one a launch would use — the rows a removal is asked
// about. The host answers the ORDER too: which version wins is its decision, and
// re-sorting it here would be a second opinion.
async function hostVersions(base, name, timeoutMs = REQUEST_TIMEOUT_MS) {
  const body = await hostJSON(`${base}/api/components/versions?name=${encodeURIComponent(name)}`, { timeoutMs });
  return Array.isArray(body.versions) ? body.versions : [];
}

// Let ONE component go. `version` names a single version to drop; with no
// version the component goes whole (agent/tools/components.py remove()). The
// verdict is the host's — "removed" with the versions that went, or "absent"
// when there was nothing to remove (the request is already true, so it is not an
// error) — and a refusal arrives as the host's own sentence, thrown.
async function hostRemove(base, name, version = "", timeoutMs = REQUEST_TIMEOUT_MS) {
  const q = version ? `?version=${encodeURIComponent(version)}` : "";
  return hostJSON(`${base}/api/components/${encodeURIComponent(name)}${q}`, { method: "DELETE", timeoutMs });
}

// Stop driving ONE component on this machine, or start again. The one verb on
// this layer that touches no bytes: the component stays installed, stays whole
// and stays LISTED, and the only thing that changes is whether this machine
// offers its tools — which is why the bit lives in the machine's own table (the
// same one its installs are recorded in) and not in this client. `disabled` is
// the state being asked for, spelled the way the host stores it (true = here,
// not to be driven), so neither side has to translate a word into its opposite.
// The verdict is the host's: "disabled"/"enabled" with the bit it now holds, or
// "absent" when this machine does not hold the component at all (an answer, not
// a failure: the request is already true there). A refusal arrives as the host's
// own sentence, thrown.
async function hostSetDisabled(base, name, disabled, timeoutMs = REQUEST_TIMEOUT_MS) {
  const verb = disabled ? "disable" : "enable";
  return hostJSON(`${base}/api/components/${encodeURIComponent(name)}/${verb}`, { method: "POST", timeoutMs });
}

// The manifest ONE install request carries: the component's own declaration with
// the install facts on top — a host that never saw the checkout still receives a
// component it can drive, because the declaration rode with the request.
// `artifact` is the artifact's own file name (the receiving host reads its shape
// from the suffix: an archive is unpacked, anything else is one executable).
function manifestFor(spec) {
  return {
    ...(spec.declaration || {}),
    name: spec.name,
    version: spec.version,
    interface: spec.interface || (spec.declaration && spec.declaration.interface) || "",
    digest: spec.digest,
    artifact: spec.path ? path.basename(spec.path) : spec.artifact || "",
  };
}

// The install request itself, whichever way the bytes travel: one endpoint, one
// header, one answer — the host's verdict, or the host's own sentence thrown so
// the page can quote the machine that refused.
async function postInstall(base, manifest, body, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/components/install`, {
      method: "POST",
      headers: {
        [MANIFEST_HEADER]: Buffer.from(JSON.stringify(manifest), "utf8").toString("base64"),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
      },
      body,
      signal: ctl.signal,
    });
    const text = await r.text();
    let out = {};
    try {
      out = JSON.parse(text);
    } catch (e) {
      /* a non-JSON body is reported below as the status */
    }
    if (!r.ok) throw new Error(out.error || `install refused (${r.status})`);
    return out;
  } finally {
    clearTimeout(t);
  }
}

// The fallback shape: the bytes go in the body, because this machine is the only
// place they are (`api/components.js` decides with `artifactFor`: a checkout, or a
// prebuilt artifact beside the app). A release's artifact does NOT come through
// here unless a caller has it locally — the target machine fetches its own.
async function upload(base, spec, timeoutMs) {
  if (!spec.path) {
    throw new Error(`this client holds no bytes for ${spec.name} to upload: it has neither a local artifact nor a URL`);
  }
  return postInstall(base, manifestFor(spec), fs.readFileSync(spec.path), timeoutMs);
}

// The default shape (PLUGIN_PLAN.md 零之四.4): the request carries NO bytes and
// names the URL the release published, and the machine that will RUN the
// component fetches it for itself. That machine is the one that needs the bytes,
// so a client on a slow uplink — a phone — never has to hold the tens of
// megabytes it is installing. The digest travels with the URL, so the host weighs
// what it fetched against exactly the pin a body would have been weighed against.
async function fetchInstall(base, spec, timeoutMs) {
  const manifest = { ...manifestFor(spec), [ARTIFACT_URL_FIELD]: spec.url };
  return postInstall(base, manifest, Buffer.alloc(0), timeoutMs);
}

// Make sure `base`'s machine holds every component this client can give it.
// Never throws: the returned summary is what the caller logs, and components
// that were deferred or refused simply stay absent — the host then offers no
// tool for them, because it has no implementation of its own to fall back to.
async function ensureComponents(base, { checkout = true, sources: list = null, progress = null, budgetMs = BUDGET_MS } = {}) {
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
  const known = await componentSpecs({ sources: list });
  out.errors.push(...known.errors);
  const deadline = Date.now() + budgetMs;
  for (const spec of known.specs) {
    let file;
    try {
      file = await artifactFor(spec, { checkout });
    } catch (e) {
      out.errors.push({ name: spec.name, reason: (e && e.message) || String(e) });
      say(`${spec.name} failed: ${e && e.message}`);
      continue;
    }
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
    // the machine that will RUN it fetches its own bytes when this client has
    // none; only bytes that exist here and nowhere else travel in the body
    const send = file.path ? upload : fetchInstall;
    try {
      const res = await send(base, file, Math.max(Math.min(left, REQUEST_TIMEOUT_MS), 1000));
      (res.status === "current" ? out.current : out.installed).push(spec.name);
      say(`${spec.name} ${res.status}`);
    } catch (e) {
      out.errors.push({ name: spec.name, reason: e && e.message });
      say(`${spec.name} failed: ${e && e.message}`);
    }
  }
  return out;
}

module.exports = {
  ensureComponents,
  artifactFor,
  installVersion,
  componentSpecs,
  readManifest,
  downloadPinned,
  checkoutArtifact,
  checkoutComponents,
  sources,
  hostInventory,
  hostVersions,
  hostRemove,
  hostSetDisabled,
  upload,
  fetchInstall,
  CACHE,
  REQUEST_TIMEOUT_MS,
  SOURCES_FILE,
  USER_SOURCES_FILE,
};
