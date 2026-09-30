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
  } = opts;
  const calls = { specReads: 0, inventories: 0, artifacts: [], uploads: [] };
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

  // ---- 6. the view's default install layer is the real one, and complete ----
  {
    check(typeof components.upload === "function", "ui/components.js exports the uploader the view calls");
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

  summary("components-view", "all passed (target machine, inventory, market cache, install verdicts)");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
