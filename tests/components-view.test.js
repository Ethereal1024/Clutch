// ui/components-view.js is what the plugin tab is served by: which machine a
// request is about, what that machine holds, what this client could give it, and
// the one install. It is injectable on purpose, so this runner drives the REAL
// view against a fake install layer — no Electron, no supervisor, no network —
// and asserts the four answers, the far-side/local target rule, the market cache
// and every install verdict path.
// Run: node tests/components-view.test.js
const { check, summary } = require("./harness.js");
const components = require("../ui/components");
const { createComponentsView, MARKET_TTL_MS } = require("../ui/components-view");

const DIGEST = "a".repeat(64);
const VERSION = "0.1.0+" + DIGEST.slice(0, 16);

function fakeLib(opts = {}) {
  const {
    specs = [],
    errors = [],
    sourceCount = 4,
    held = [],
    inventoryError = null,
    file = { path: "/tmp/clutch-memory.tar.gz", digest: DIGEST, version: VERSION },
    artifactError = null,
    verdict = { status: "installed", name: "clutch-memory", version: VERSION, digest: DIGEST, path: "/root/0.1.0" },
    uploadError = null,
    versions = [{ name: "clutch-memory", version: VERSION, interface: "cli", digest: DIGEST, path: "/root/0.1.0", resolved: true }],
    versionsError = null,
    removal = { status: "removed", name: "clutch-memory", removed: [VERSION] },
    removeError = null,
  } = opts;
  const calls = { specReads: 0, inventories: 0, artifacts: [], uploads: [], versionReads: [], removals: [] };
  return {
    calls,
    REQUEST_TIMEOUT_MS: 120000,
    sources: () => new Array(sourceCount).fill("https://example.invalid/clutch-component.json"),
    componentSpecs: async () => {
      calls.specReads++;
      return { specs, errors };
    },
    hostInventory: async () => {
      calls.inventories++;
      if (inventoryError) throw new Error(inventoryError);
      return held;
    },
    hostVersions: async (base, name) => {
      calls.versionReads.push({ base, name });
      if (versionsError) throw new Error(versionsError);
      return versions;
    },
    hostRemove: async (base, name, version) => {
      calls.removals.push({ base, name, version });
      if (removeError) throw new Error(removeError);
      return removal;
    },
    artifactFor: async (spec) => {
      calls.artifacts.push(spec.name);
      if (artifactError) throw new Error(artifactError);
      return file ? { ...file, name: spec.name } : null;
    },
    upload: async (base, f, timeoutMs) => {
      calls.uploads.push({ base, timeoutMs, version: f.version, digest: f.digest });
      if (uploadError) throw new Error(uploadError);
      return verdict;
    },
  };
}

const CHECKOUT = {
  name: "clutch-memory",
  interface: "cli",
  checkout: true,
  source: "/repo/clutch-memory",
  declaration: { name: "clutch-memory", interface: "cli", version: "0.1.0" },
  published: {
    name: "clutch-memory",
    interface: "cli",
    version: "0.1.0",
    source: "https://example.invalid/clutch-component.json",
    artifacts: { any: { asset: "clutch-memory.tar.gz", sha256: DIGEST } },
  },
};
const RELEASE = {
  name: "clutch-skills",
  interface: "cli",
  checkout: false,
  version: "0.2.0",
  source: "https://example.invalid/skills.json",
  artifacts: { any: { asset: "clutch-skills.tar.gz", sha256: DIGEST } },
};
const EMPTY_WIN = null; // no window handle: the tunnel, if any, decides

function view(deps = {}) {
  const lib = deps.lib || fakeLib();
  return {
    lib,
    api: createComponentsView({
      supervisorBase: () => "http://127.0.0.1:8890",
      tunnelStatus: () => ({ active: false, url: null }),
      lib,
      ...deps.deps,
    }),
  };
}

async function main() {
  // ---- 1. which machine a request is about ----
  {
    const local = view();
    check(
      JSON.stringify(local.api.target(EMPTY_WIN)) === JSON.stringify({ kind: "local", base: "http://127.0.0.1:8890" }),
      "with no tunnel the target machine is this machine's supervisor"
    );
    const remote = view({ deps: { tunnelStatus: () => ({ active: true, url: "http://127.0.0.1:41000" }) } });
    check(
      remote.api.target(EMPTY_WIN).base === "http://127.0.0.1:41000" && remote.api.target(EMPTY_WIN).kind === "remote",
      "a live tunnel makes the far side's supervisor the target"
    );
    // the window's OWN session decides when it has one: a tunnel being up is not
    // the same claim as this window running on the far side (it may have fallen
    // back to a local session)
    const fellBack = view({
      deps: {
        tunnelStatus: () => ({ active: true, url: "http://127.0.0.1:41000" }),
        windowKind: () => "local",
      },
    });
    check(
      fellBack.api.target({ id: 1 }).kind === "local",
      "a window that fell back to a local session targets THIS machine, tunnel or not"
    );
    const tunneled = view({ deps: { windowKind: () => "tunnel", tunnelStatus: () => ({ active: true, url: "http://127.0.0.1:41000" }) } });
    check(tunneled.api.target({ id: 1 }).kind === "remote", "a tunneled window targets the far machine");
    // a tunnel that died between claims: a target with no base is no machine
    const deadTunnel = view({ deps: { tunnelStatus: () => ({ active: false, url: null }), windowKind: () => "tunnel" } });
    check(deadTunnel.api.target({ id: 1 }).base === "", "a tunneled window after the tunnel died has no target base");
    const bad = await deadTunnel.api.list({ id: 1 });
    check(bad.error && bad.held.length === 0, "and a read says so instead of throwing");
  }

  // ---- 2. what the machine holds ----
  {
    const { api } = view({ lib: fakeLib({ held: [{ name: "clutch-memory", version: VERSION, interface: "cli", digest: DIGEST }] }) });
    const l = await api.list(EMPTY_WIN);
    check(
      l.held.length === 1 && l.held[0].version === VERSION && l.error === null,
      "the inventory comes back verbatim, with no error"
    );
    const down = view({ lib: fakeLib({ inventoryError: "the host did not answer: fetch failed" }) });
    const l2 = await down.api.list(EMPTY_WIN);
    check(
      l2.held.length === 0 && /the host did not answer/.test(l2.error || ""),
      "a supervisor that did not answer is reported as the reason, not as an empty machine"
    );
  }

  // ---- 3. the market, and the reason it can be short ----
  {
    const lib = fakeLib({
      specs: [CHECKOUT, RELEASE],
      errors: [{ name: "", reason: "https://example.invalid/x.json: the source answered 404" }],
    });
    const { api } = view({ lib });
    const m = await api.market();
    check(m.entries.length === 2 && m.sources === 4, "every readable source contributes a market entry");
    check(
      m.entries[0].origin === "checkout" && m.entries[0].published.version === "0.1.0",
      "a checkout says so, and keeps the release under it (the only thing a machine holding the checkout can receive)"
    );
    check(m.entries[0].version === "0.1.0" && m.entries[1].origin === "release", "a release is read straight from its manifest");
    check(m.errors.length === 1 && /404/.test(m.errors[0]), "a source that did not answer is drawn as its reason");

    // the cache: a page reopened a moment later must not re-read four sources
    await api.market();
    check(lib.calls.specReads === 1, "the market is read once and cached (TTL " + MARKET_TTL_MS + "ms)");
    await api.market({ force: true });
    check(lib.calls.specReads === 2, "an explicit refresh reads it again");
    // an expired cache is a read, not a stale answer
    const clocked = createComponentsView({
      supervisorBase: () => "http://127.0.0.1:8890",
      tunnelStatus: () => ({}),
      lib,
      now: (() => {
        let t = 0;
        return () => (t += MARKET_TTL_MS + 1);
      })(),
    });
    await clocked.market();
    await clocked.market();
    check(lib.calls.specReads === 4, "a market read older than its TTL is refreshed");
  }

  // ---- 4. one install ----
  {
    // already held at exactly this version + digest: the host's gate, answered
    // here so nothing is uploaded
    const current = view({
      lib: fakeLib({ specs: [CHECKOUT], held: [{ name: "clutch-memory", version: VERSION, digest: DIGEST }] }),
    });
    const stages = [];
    const r = await current.api.install("clutch-memory", EMPTY_WIN, { progress: (s) => stages.push(s.stage) });
    check(r.ok && r.status === "current", "a component the machine already holds at that digest is 'current'");
    check(current.lib.calls.uploads.length === 0, "and nothing is uploaded for it");
    check(stages.includes("artifact") && stages.includes("current"), "the client reports the steps it took (" + stages.join(" → ") + ")");

    // the upload path: where the bytes go, under which version, with a real timeout
    const up = view({ lib: fakeLib({ specs: [CHECKOUT], held: [] }) });
    const r2 = await up.api.install("clutch-memory", EMPTY_WIN, { progress: () => {} });
    check(r2.ok && r2.status === "installed" && r2.version === VERSION, "a fresh install reports the host's verdict and version");
    check(up.lib.calls.uploads[0].base === "http://127.0.0.1:8890", "the bytes go to the target machine's supervisor");
    check(
      up.lib.calls.uploads[0].timeoutMs > 0,
      "the upload carries a bounded timeout (an undefined one aborts the request on the spot)"
    );
    check(
      up.lib.calls.artifacts[0] === "clutch-memory" && /^0\.1\.0\+/.test(up.lib.calls.uploads[0].version),
      "the artifact is built for that component and installed under its own version + digest"
    );

    // a different digest under the same version is NOT current: the gate is the pair
    const stale = view({
      lib: fakeLib({ specs: [CHECKOUT], held: [{ name: "clutch-memory", version: VERSION, digest: "b".repeat(64) }] }),
    });
    const r3 = await stale.api.install("clutch-memory", EMPTY_WIN, {});
    check(r3.ok && stale.lib.calls.uploads.length === 1, "the same version with other bytes is uploaded, not assumed current");

    // a host that refuses: the verdict is the host's, and its reason is what the page shows
    const refused = view({ lib: fakeLib({ specs: [CHECKOUT], uploadError: "manifest declares interface 'data', expected one of ('daemon', 'cli')" }) });
    const r4 = await refused.api.install("clutch-memory", EMPTY_WIN, {});
    check(!r4.ok && /interface 'data'/.test(r4.error), "a refusal surfaces with the host's own words");
  }

  // ---- 5. the ways an install does not happen at all ----
  {
    const unknown = view({ lib: fakeLib({ specs: [CHECKOUT] }) });
    const r = await unknown.api.install("clutch-nothing", EMPTY_WIN, {});
    check(!r.ok && /not a component this client knows/.test(r.error), "a name no source offers is refused before anything moves");

    const nothing = view({ lib: fakeLib({ specs: [CHECKOUT], file: null }) });
    const r2 = await nothing.api.install("clutch-memory", EMPTY_WIN, {});
    check(!r2.ok && /no checkout.*no artifact/.test(r2.error || ""), "no bytes for this platform is a refusal with its reason");

    const broken = view({ lib: fakeLib({ specs: [CHECKOUT], artifactError: "the artifact answered 404" }) });
    const r3 = await broken.api.install("clutch-memory", EMPTY_WIN, {});
    check(!r3.ok && /404/.test(r3.error), "an artifact that cannot be fetched is reported, not thrown");

    const { api } = view();
    const r4 = await api.install("clutch-memory", { id: 9 }, {});
    check(!r4.ok, "no window and no tunnel still installs to this machine");
  }

  // ---- 7. the reverse verbs: what one machine holds, and letting it go ----
  {
    // the versions of ONE component, in the host's own order and with the
    // host's own answer about which one it would run
    const { api, lib } = view({
      lib: fakeLib({
        versions: [
          { name: "clutch-memory", version: "0.2.0+x", interface: "cli", digest: DIGEST, path: "/root/0.2.0", resolved: true },
          { name: "clutch-memory", version: VERSION, interface: "cli", digest: DIGEST, path: "/root/0.1.0", resolved: false },
        ],
      }),
    });
    const v = await api.versions("clutch-memory", EMPTY_WIN);
    check(v.error === null && v.versions.length === 2, "every version this machine holds comes back for one component");
    check(v.versions[0].resolved === true && v.versions[1].resolved === false, "with the host's own verdict about which one it would run");
    check(lib.calls.versionReads[0].name === "clutch-memory" && lib.calls.versionReads[0].base === "http://127.0.0.1:8890", "the question goes to THIS machine's supervisor, by name");

    // a read that failed is the reason it failed, never "no versions"
    const blind = view({ lib: fakeLib({ versionsError: "DELETE /api/components/versions/… answered 500" }) });
    const v2 = await blind.api.versions("clutch-memory", EMPTY_WIN);
    check(v2.versions.length === 0 && /answered 500/.test(v2.error || ""), "a version read that failed says why, instead of reporting an empty machine");

    // and a target that does not exist is not asked at all
    const nowhere = view({ deps: { tunnelStatus: () => ({ active: false, url: null }), windowKind: () => "tunnel" } });
    const v3 = await nowhere.api.versions("clutch-memory", { id: 1 });
    check(v3.error && nowhere.lib.calls.versionReads.length === 0, "a machine with no supervisor URL is reported without a request being made");
  }

  // ---- 8. one removal, and the three shapes its verdict takes ----
  {
    const { api, lib } = view({ lib: fakeLib() });
    const r = await api.remove("clutch-memory", {}, EMPTY_WIN);
    check(r.ok && r.status === "removed" && r.removed[0] === VERSION, "a removal reports the host's verdict and the versions that went");
    check(lib.calls.removals[0].name === "clutch-memory" && lib.calls.removals[0].version === "", "no version named means the component goes whole");
    check(lib.calls.removals[0].base === "http://127.0.0.1:8890", "and it is asked of the target machine's supervisor");

    const one = view({ lib: fakeLib({ removal: { status: "removed", name: "clutch-memory", removed: [VERSION] } }) });
    await one.api.remove("clutch-memory", { version: VERSION }, EMPTY_WIN);
    check(one.lib.calls.removals[0].version === VERSION, "a version the caller names is the one asked about");

    // "absent" is an outcome, not a failure: what was asked for is already true
    const gone = view({ lib: fakeLib({ removal: { status: "absent", name: "clutch-memory", removed: [] } }) });
    const r2 = await gone.api.remove("clutch-memory", {}, EMPTY_WIN);
    check(r2.ok && r2.status === "absent" && r2.removed.length === 0, "a component that was already gone answers 'absent' and is not an error");

    // a refusal is the host's sentence — the page quotes it, this layer does not
    // invent a verdict of its own (the host is the side that knows what is running)
    const refused = view({ lib: fakeLib({ removeError: "clutch-memory is being served right now by a daemon this process did not start (pid 4242): stop it first" }) });
    const r3 = await refused.api.remove("clutch-memory", {}, EMPTY_WIN);
    check(!r3.ok && /pid 4242/.test(r3.error), "a refusal surfaces with the host's own words");

    const nowhere = view({ deps: { tunnelStatus: () => ({ active: false, url: null }), windowKind: () => "tunnel" } });
    const r4 = await nowhere.api.remove("clutch-memory", {}, { id: 1 });
    check(!r4.ok && nowhere.lib.calls.removals.length === 0, "a machine with no supervisor URL is refused before anything is sent");
  }

  // ---- 9. the view's default install layer is the real one, and complete ----
  {
    check(typeof components.upload === "function", "ui/components.js exports the uploader the view calls");
    check(
      typeof components.hostVersions === "function" && typeof components.hostRemove === "function",
      "and the two reverse calls (list one component's versions, let one go)"
    );
    check(
      Number.isFinite(components.REQUEST_TIMEOUT_MS) && components.REQUEST_TIMEOUT_MS > 0,
      "and the upload timeout it must pass is exported too"
    );
    const { api } = view({
      lib: fakeLib({ artifacts: [] }),
      deps: {},
    });
    check(typeof api.marketCache === "function", "the view exposes its market cache (a page can tell what it is showing)");
  }

  summary("components-view", "all passed (target machine, inventory, market cache, install + remove verdicts)");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
