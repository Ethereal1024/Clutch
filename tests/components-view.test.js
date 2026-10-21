// ui/components-view.js is what the plugin tab is served by: which machine a
// request is about, what that machine holds, what this client could give it, and
// the three writes (an install onto it, a removal off it, and the switch that
// stops it being driven or starts it again). It is injectable on purpose, so this
// runner drives the REAL view against a fake install layer — no Electron, no
// supervisor, no network — and asserts the four answers, the far-side/local
// target rule, the market cache and every install verdict path, in both shapes an
// install takes (bytes in the request body, or a URL the target machine fetches).
// Run: node tests/components-view.test.js
const { check, summary } = require("./harness.js");
const components = require("../ui/components");
const { createComponentsView, MARKET_TTL_MS, MARKET_ERROR_TTL_MS } = require("../ui/components-view");

const DIGEST = "a".repeat(64);
const VERSION = "0.1.0+" + DIGEST.slice(0, 16);

function fakeLib(opts = {}) {
  const {
    specs = [],
    errors = [],
    origin = "remote",
    note = "",
    held = [],
    inventoryError = null,
    file = { path: "/tmp/clutch-memory.tar.gz", digest: DIGEST, version: VERSION },
    artifactError = null,
    verdict = { status: "installed", name: "clutch-memory", version: VERSION, digest: DIGEST, path: "/root/0.1.0" },
    uploadError = null,
    fetchError = null,
    versions = [{ name: "clutch-memory", version: VERSION, digest: DIGEST, path: "/root/0.1.0", resolved: true }],
    versionsError = null,
    removal = { status: "removed", name: "clutch-memory", removed: [VERSION] },
    removeError = null,
    switchVerdict = { status: "disabled", name: "clutch-memory", disabled: true },
    switchError = null,
  } = opts;
  const calls = { specReads: 0, inventories: 0, artifacts: [], uploads: [], fetches: [], versionReads: [], removals: [], switches: [] };
  return {
    calls,
    REQUEST_TIMEOUT_MS: 120000,
    marketEntries: async () => {
      // what ui/components.js marketEntries() answers: the checkouts beside this
      // repo, then one row per index entry, and no manifest read
      calls.specReads++;
      return { specs, errors, origin, note, unreachable: errors.some((e) => e.unreachable) };
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
    hostSetDisabled: async (base, name, disabled) => {
      calls.switches.push({ base, name, disabled });
      if (switchError) throw new Error(switchError);
      return switchVerdict;
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
    // the default shape: no bytes here to send — the URL is what travels, and the
    // TARGET machine fetches what it will run
    fetchInstall: async (base, f, timeoutMs) => {
      calls.fetches.push({ base, timeoutMs, url: f.url, artifact: f.artifact, version: f.version, digest: f.digest });
      if (fetchError) throw new Error(fetchError);
      return verdict;
    },
  };
}

// A checkout carries its own declaration, and this one names a process the
// SESSION machine starts: `launch`, with no `entry` of its own — a
// declaration says what it CONTRIBUTES, never what kind it is.
const CHECKOUT = {
  name: "clutch-memory",
  checkout: true,
  source: "/repo/clutch-memory",
  declaration: { name: "clutch-memory", version: "0.1.0", launch: { argv: ["{py}", "{script}"], entry: "memory.py" } },
  published: {
    name: "clutch-memory",
    version: "0.1.0",
    source: "https://example.invalid/clutch-component.json",
    launch: { argv: ["{py}", "{script}"], entry: "memory.py" },
    artifacts: { any: { asset: "clutch-memory.tar.gz", sha256: DIGEST } },
  },
};
const RELEASE = {
  name: "clutch-skills",
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
    const { api } = view({ lib: fakeLib({ held: [{ name: "clutch-memory", version: VERSION, digest: DIGEST }] }) });
    const l = await api.list(EMPTY_WIN);
    check(
      l.held.length === 1 && l.held[0].version === VERSION && l.error === null,
      "the inventory comes back verbatim, with no error"
    );
    const down = view({ lib: fakeLib({ inventoryError: "the host did not answer: fetch failed" }) });
    const l2 = await down.api.list(EMPTY_WIN);
    check(
      l2.held.length === 0 && /the host did not answer/.test(l2.inventoryError || ""),
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
    check(m.entries.length === 2 && m.origin === "remote", "every row the index lists is a market entry, and the page knows which index answered");
    check(
      m.entries[0].origin === "checkout" && m.entries[0].published.version === "0.1.0",
      "a checkout says so, and keeps the release under it (the only thing a machine holding the checkout can receive)"
    );
    check(m.entries[0].version === "0.1.0" && m.entries[1].origin === "market", "a row the index names is the market's, and it is drawn without reading its manifest");
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
    check(m.unreachable === false, "a source that ANSWERED no is not a source that could not be reached");

    // a read that LOST a source is the exception to that five minutes: holding
    // "fetch failed" for five minutes is how a moment of bad network turns into
    // "this page is broken", so it is asked again almost at once — and the page
    // is told which case it has (the mirror hint in ui/js/components-panel.js
    // hangs off exactly this bit)
    const failed = fakeLib({
      specs: [CHECKOUT],
      errors: [
        {
          name: "",
          reason:
            "https://example.invalid/x.json: the source could not be reached (other side closed, asked 3 times)",
          unreachable: true,
        },
      ],
    });
    let lost = 0;
    const retried = createComponentsView({
      supervisorBase: () => "http://127.0.0.1:8890",
      tunnelStatus: () => ({}),
      lib: failed,
      now: () => lost,
    });
    const short = await retried.market();
    check(
      short.unreachable === true && short.errors.length === 1 && short.entries.length === 1,
      "a source that could not be reached is marked as such, and the sources that did answer are still a market"
    );
    lost = MARKET_ERROR_TTL_MS + 1;
    await retried.market();
    check(
      failed.calls.specReads === 2 && lost < MARKET_TTL_MS,
      "an unreachable source is asked again after " + MARKET_ERROR_TTL_MS + "ms, far inside the healthy " + MARKET_TTL_MS + "ms"
    );
    // the same instant, healthy market: nothing to retry, so no ask
    const healthy = fakeLib({ specs: [CHECKOUT] });
    let fine = 0;
    const kept = createComponentsView({
      supervisorBase: () => "http://127.0.0.1:8890",
      tunnelStatus: () => ({}),
      lib: healthy,
      now: () => fine,
    });
    await kept.market();
    fine = MARKET_ERROR_TTL_MS + 1;
    const again = await kept.market();
    check(healthy.calls.specReads === 1, "a market with no lost source is not re-read at the failure TTL");
    check(again.unreachable === false && again.errors.length === 0, "and it draws no reason and asks for no hint");
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
    const refused = view({ lib: fakeLib({ specs: [CHECKOUT], uploadError: "manifest names no `entry`: a component this client runs is a module, and one without it has no implementation here" }) });
    const r4 = await refused.api.install("clutch-memory", EMPTY_WIN, {});
    check(!r4.ok && /names no `entry`/.test(r4.error), "a refusal surfaces with the host's own words");
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

  // ---- 6. the fetch shape: no bytes leave this client ----
  {
    // a published release is a LOCATION plus its pin, not bytes, so the machine
    // that will RUN it fetches them for itself and nothing is uploaded from here
    const URLFILE = {
      name: "clutch-skills",
      url: "https://example.invalid/clutch-skills.tar.gz",
      artifact: "clutch-skills.tar.gz",
      digest: DIGEST,
      version: VERSION,
    };
    const stages = [];
    const fetched = view({ lib: fakeLib({ specs: [RELEASE], file: URLFILE, held: [] }) });
    const r = await fetched.api.install("clutch-skills", EMPTY_WIN, { progress: (s) => stages.push(s.stage) });
    check(r.ok && r.status === "installed", "an install whose bytes are a URL is still an install onto the target machine");
    check(
      fetched.lib.calls.fetches.length === 1 && fetched.lib.calls.uploads.length === 0,
      "the URL is handed over and no bytes are uploaded from this client"
    );
    check(
      fetched.lib.calls.fetches[0].url === "https://example.invalid/clutch-skills.tar.gz" &&
        fetched.lib.calls.fetches[0].artifact === "clutch-skills.tar.gz",
      "the request names the release's own URL and the artifact's own file name"
    );
    check(
      fetched.lib.calls.fetches[0].base === "http://127.0.0.1:8890" && fetched.lib.calls.fetches[0].timeoutMs > 0,
      "and it goes to the target machine's supervisor, with a bounded timeout"
    );
    check(
      stages.includes("fetch") && !stages.includes("upload"),
      "the page is told it is a fetch, not a send (" + stages.join(" → ") + ")"
    );

    // what the target machine refuses is the host's own words, either way
    const refused = view({
      lib: fakeLib({
        specs: [RELEASE],
        file: URLFILE,
        fetchError: "the artifact hashes to 608f3392, not the declared f7ca6bc5",
      }),
    });
    const r2 = await refused.api.install("clutch-skills", EMPTY_WIN, {});
    check(!r2.ok && /hashes to/.test(r2.error), "a fetch the target machine refuses arrives as its own sentence");
  }

  // ---- 7. the reverse verbs: what one machine holds, and letting it go ----
  {
    // the versions of ONE component, in the host's own order and with the
    // host's own answer about which one it would run
    const { api, lib } = view({
      lib: fakeLib({
        versions: [
          { name: "clutch-memory", version: "0.2.0+x", digest: DIGEST, path: "/root/0.2.0", resolved: true },
          { name: "clutch-memory", version: VERSION, digest: DIGEST, path: "/root/0.1.0", resolved: false },
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

  // ---- 9. the switch: the state asked for goes out, the host's bit comes back.
  //         The one write here that touches no bytes, and the only one whose
  //         verdict can be "absent" — the machine does not hold the component.
  {
    const { api, lib } = view({ lib: fakeLib() });
    const off = await api.setDisabled("clutch-memory", true, EMPTY_WIN);
    check(off.ok && off.status === "disabled" && off.disabled === true, "the switch reports the host's verdict and the bit it now holds");
    check(
      lib.calls.switches[0].disabled === true && lib.calls.switches[0].name === "clutch-memory",
      "and what went out is the STATE asked for, not a verb the host would have to interpret"
    );
    check(lib.calls.switches[0].base === "http://127.0.0.1:8890", "asked of the target machine's supervisor");

    const on = view({ lib: fakeLib({ switchVerdict: { status: "enabled", name: "clutch-memory", disabled: false } }) });
    const back = await on.api.setDisabled("clutch-memory", false, EMPTY_WIN);
    check(back.ok && back.disabled === false && on.lib.calls.switches[0].disabled === false, "the other direction sends the other state, and reports the host's bit back");

    // a verdict that carries no bit still answers the state that was asked for
    const bare = view({ lib: fakeLib({ switchVerdict: { status: "disabled", name: "clutch-memory" } }) });
    const b = await bare.api.setDisabled("clutch-memory", true, EMPTY_WIN);
    check(b.ok && b.disabled === true, "a host that sends no bit is still read as the state that was asked for");
    check(b.target && b.target.base === "http://127.0.0.1:8890", "and the answer names the machine it was about");

    // "absent" is an outcome, not a failure: that machine holds nothing of this name
    const nowhere = view({ lib: fakeLib({ switchVerdict: { status: "absent", name: "clutch-nothing" } }) });
    const a = await nowhere.api.setDisabled("clutch-nothing", true, EMPTY_WIN);
    check(a.ok && a.status === "absent", "a component that machine does not hold answers 'absent' rather than failing");

    // a refusal is the host's sentence — a name that could never be an install,
    // and the host's own words for it
    const refused = view({ lib: fakeLib({ switchError: "bad component name: ../../etc" }) });
    const r = await refused.api.setDisabled("../../etc", true, EMPTY_WIN);
    check(!r.ok && /bad component name/.test(r.error), "a refusal surfaces with the host's own words");

    const unreachable = view({ deps: { tunnelStatus: () => ({ active: false, url: null }), windowKind: () => "tunnel" } });
    const n = await unreachable.api.setDisabled("clutch-memory", true, { id: 1 });
    check(!n.ok && unreachable.lib.calls.switches.length === 0, "a machine with no supervisor URL is refused before anything is sent");
  }

  // ---- 10. the view's default install layer is the real one, and complete ----
  {
    check(
      typeof components.upload === "function" && typeof components.fetchInstall === "function",
      "ui/components.js exports both ways the view sends an install: the body uploader and the URL handover"
    );
    check(
      typeof components.hostVersions === "function" && typeof components.hostRemove === "function" && typeof components.hostSetDisabled === "function",
      "and the three reverse calls (list one component's versions, let one go, stop or start driving it)"
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

  // ---- 11. the local machine's supervisor is this client's to start ----
  {
    // The desktop injects the app's own ensureSupervisor (ui/server-bootstrap.js):
    // a supervisor that exits when idle is started again for the write that needs
    // it, instead of the user being told the machine "did not answer" with no way
    // to make it answer.
    const stages = [];
    let wakes = 0;
    // a machine whose supervisor has idle-exited: until it is started, every call
    // to it is refused at the socket — the "did not answer" the page used to be
    // left holding with no way to make the machine answer
    const base = fakeLib({ specs: [CHECKOUT], held: [] });
    let awake = false;
    const refused = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8890"));
    const sleeping = {
      ...base,
      hostInventory: (b) => (awake ? base.hostInventory(b) : refused()),
      upload: (b, f, ms) => (awake ? base.upload(b, f, ms) : refused()),
      fetchInstall: (b, f, ms) => (awake ? base.fetchInstall(b, f, ms) : refused()),
    };
    const asleep = view({
      lib: sleeping,
      deps: {
        ensureSupervisor: async () => {
          wakes++;
          awake = true;
          return true;
        },
      },
    });
    const r = await asleep.api.install("clutch-memory", EMPTY_WIN, { progress: (s) => stages.push(s.stage) });
    check(r.ok && r.status === "installed", "an install onto this machine lands even though its supervisor had exited");
    check(wakes === 1, "the machine's supervisor is started exactly once for the write");
    check(
      stages.indexOf("wake") > stages.indexOf("artifact") && stages.indexOf("wake") < stages.indexOf("upload"),
      "and it is started before anything is sent to it (" + stages.join(" → ") + ")"
    );

    // the wake is the LOCAL machine's: a tunnel's far side starts its own
    const far = view({
      lib: fakeLib({ specs: [CHECKOUT], held: [] }),
      deps: {
        tunnelStatus: () => ({ active: true, url: "http://127.0.0.1:41000" }),
        ensureSupervisor: async () => {
          throw new Error("the far machine's supervisor is not this client's to start");
        },
      },
    });
    const r2 = await far.api.install("clutch-memory", EMPTY_WIN, {});
    check(
      r2.ok && far.lib.calls.uploads[0].base === "http://127.0.0.1:41000",
      "an install aimed at the far machine never starts this one's supervisor"
    );

    // a supervisor that will not come up is one sentence, and nothing else is asked
    // of a machine that is not answering
    const stuck = view({
      lib: fakeLib({ specs: [CHECKOUT], held: [] }),
      deps: { ensureSupervisor: async () => false },
    });
    const r3 = await stuck.api.install("clutch-memory", EMPTY_WIN, {});
    check(
      !r3.ok && /not running and could not be started/.test(r3.error || ""),
      "a supervisor that will not start is reported in words the page can draw"
    );
    check(
      stuck.lib.calls.inventories === 0 && stuck.lib.calls.uploads.length === 0 && stuck.lib.calls.fetches.length === 0,
      "and a machine that is not answering is not asked anything else"
    );

    // a host that owns no supervisor at all (the phone, N4) passes no such dep and
    // installs exactly as it did before
    const plain = view({ lib: fakeLib({ specs: [CHECKOUT], held: [] }) });
    const r4 = await plain.api.install("clutch-memory", EMPTY_WIN, {});
    check(r4.ok && r4.status === "installed", "a host with no supervisor of its own (the phone) installs unchanged");

    // nothing is started for a request this client refuses on its own
    const never = () => {
      throw new Error("nothing should have been started");
    };
    const unknown = view({ lib: fakeLib({ specs: [CHECKOUT] }), deps: { ensureSupervisor: never } });
    const r5 = await unknown.api.install("clutch-nothing", EMPTY_WIN, {});
    check(!r5.ok && /not a component this client knows/.test(r5.error), "a name no source offers is refused before any machine is started");
    const noBytes = view({ lib: fakeLib({ specs: [CHECKOUT], file: null }), deps: { ensureSupervisor: never } });
    const r6 = await noBytes.api.install("clutch-memory", EMPTY_WIN, {});
    check(!r6.ok && /no bytes/.test(r6.error || ""), "and so is a component this client has no bytes for");

    // the boundary: a READ does not wake the machine. Reading a machine that is not
    // running is a fact the page can draw; starting one is a write's act.
    const read = view({
      lib: fakeLib({ inventoryError: "the supervisor did not answer" }),
      deps: { ensureSupervisor: never },
    });
    const l = await read.api.list(EMPTY_WIN);
    check(l.held.length === 0 && /did not answer/.test(l.inventoryError || "") && !l.error, "a read of a machine that is not running stays a sentence, not a wake -- and not a place that cannot be aimed at");
  }

  // ---- 12. the mirrors: a fetch the release host could not answer is retried
  //         through the list this machine knows of (ui/mirrors.js), the page is
  //         told which place is being tried and why, and the list itself is one
  //         read and two writes — never a throw at the page
  {
    // what a retried install looks like from HERE: the install layer (ui/components.js
    // fetchInstall) calls `onRetry` before each attempt past the first, and the
    // verdict names the prefix the bytes actually came through
    const URLFILE = {
      name: "clutch-skills",
      url: "https://example.invalid/clutch-skills.tar.gz",
      artifact: "clutch-skills.tar.gz",
      digest: DIGEST,
      version: VERSION,
    };
    const lib = fakeLib({ specs: [RELEASE], file: URLFILE, held: [] });
    lib.fetchInstall = async (base, f, timeoutMs, opts = {}) => {
      lib.calls.fetches.push({ base, timeoutMs, url: f.url });
      // the direct attempt failed; the hook says which mirror is next, and why
      if (opts.onRetry) opts.onRetry("https://gh-proxy.com/", "HTTP Error 504: Gateway Time-out");
      return { status: "installed", name: "clutch-skills", version: VERSION, digest: DIGEST, via: "https://gh-proxy.com/" };
    };
    const stages = [];
    const retried = view({ lib });
    const r = await retried.api.install("clutch-skills", EMPTY_WIN, { progress: (s) => stages.push(s) });
    check(r.ok && r.via === "https://gh-proxy.com/", "an install whose bytes came through a mirror reports the prefix that served them");
    const mirrorStage = stages.find((s) => s.stage === "mirror");
    check(
      Boolean(mirrorStage) && mirrorStage.prefix === "https://gh-proxy.com/" && /504/.test(mirrorStage.reason || ""),
      "and the page is told which mirror is being tried, and what the host said before it — one slow attempt is not a frozen page"
    );
    check(
      stages.map((s) => s.stage).indexOf("mirror") > stages.map((s) => s.stage).indexOf("fetch") &&
        stages.map((s) => s.stage).indexOf("mirror") < stages.map((s) => s.stage).indexOf("installed"),
      "the retry arrives between the fetch and the verdict (" + stages.map((s) => s.stage).join(" → ") + ")"
    );
    check(
      retried.lib.calls.fetches.length === 1 && !stages.some((s) => s.stage === "upload"),
      "and it is still the target machine's own fetch — no bytes left this client to try a mirror"
    );

    // the same fact from the other side: the artifact itself carries the prefix
    // its bytes came through, when the verdict does not name one
    const prefixed = view({ lib: fakeLib({ specs: [RELEASE], file: { ...URLFILE, via: "https://ghfast.top/" }, held: [] }) });
    const r2 = await prefixed.api.install("clutch-skills", EMPTY_WIN, {});
    check(r2.ok && r2.via === "https://ghfast.top/", "an artifact that already carries the mirror path reports it, verdict or not");

    // a machine-policy install with no mirror in play says nothing about one
    const plain = view({ lib: fakeLib({ specs: [RELEASE], file: URLFILE, held: [] }) });
    const r3 = await plain.api.install("clutch-skills", EMPTY_WIN, {});
    check(r3.ok && r3.via === "", "an install that came from the release's own host invents no mirror");

    // ...and the list itself: one read, two writes, each answered with the list AS
    // IT NOW IS, and a refusal as a sentence under the field
    const store = {
      list: [
        { url: "https://mine.example/", source: "user" },
        { url: "https://gh-proxy.com/", source: "builtin" },
      ],
      calls: { adds: [], removes: [] },
      entries() {
        return this.list.map((e) => ({ ...e }));
      },
      forced() {
        return "";
      },
      add(raw) {
        this.calls.adds.push(raw);
        if (raw === "https://dup.example/") return { ok: false, error: `${raw} is already in the list` };
        this.list = [...this.list, { url: raw, source: "user" }];
        return { ok: true, url: raw };
      },
      remove(raw) {
        this.calls.removes.push(raw);
        if (raw === "https://gh-proxy.com/") {
          return { ok: false, error: `${raw} is a mirror this build ships — it is always tried, so there is nothing to remove` };
        }
        this.list = this.list.filter((e) => e.url !== raw);
        return { ok: true };
      },
    };
    const { api } = view({ deps: { mirrorStore: store } });
    const m = api.mirrors();
    check(
      m.error === null && m.forced === "" && m.mirrors.length === 2 && m.mirrors[0].url === "https://mine.example/",
      "the page can read the list a failed fetch is retried through, the user's entries first"
    );
    const added = api.addMirror("https://mine.example/");
    check(
      added.ok && added.mirrors.length === 3 && added.mirrors[2].source === "user",
      "an add answers with the list as it now is, not with what was asked for"
    );
    const refused = api.addMirror("https://dup.example/");
    check(!refused.ok && /already in the list/.test(refused.error), "a value the list already holds comes back as a sentence, not a duplicate");
    const gone = api.removeMirror("https://gh-proxy.com/");
    check(!gone.ok && /this build ships/.test(gone.error), "a shipped entry cannot be removed, and the refusal says why");
    const dropped = api.removeMirror("https://mine.example/");
    check(dropped.ok && dropped.mirrors.length === 1, "a user entry is removed, and the answer is the list without it");

    // the knob that outranks the list travels with the read
    const forced = view({
      deps: {
        mirrorStore: {
          entries: () => [{ url: "https://gh-proxy.com/", source: "builtin" }],
          forced: () => "https://gh-proxy.com/",
          add: () => ({ ok: true }),
          remove: () => ({ ok: true }),
        },
      },
    }).api.mirrors();
    check(forced.forced === "https://gh-proxy.com/", "with source_mirror set, the page is told which prefix outranks the list");

    // a store that cannot be read is a reason on the page, not a throw out of it
    const broken = view({
      deps: {
        mirrorStore: {
          entries() {
            throw new Error("EACCES: permission denied, open ~/.clutch/components.mirrors.json");
          },
          forced() {
            return "";
          },
          add() {
            throw new Error("EACCES: permission denied, open ~/.clutch/components.mirrors.json");
          },
          remove() {
            throw new Error("EACCES: permission denied, open ~/.clutch/components.mirrors.json");
          },
        },
      },
    });
    const bad = broken.api.mirrors();
    check(bad.mirrors.length === 0 && /EACCES/.test(bad.error || ""), "a list that cannot be read is reported as its reason, not thrown at the page");
    check(broken.api.addMirror("https://x.example/").ok === false, "and a write into that store is a sentence as well");
  }

  // ---- 13. where a component goes is a FACT of what it contributes, never a
  //          choice. `destinationOf` (ui/components.js) answers it from the one
  //          thing a declaration says: `service` (a process that stays on the
  //          session machine), `launch` (one process per call there), or neither
  //          — and then the statement is the CLIENT's and the declaration has to
  //          name the `entry` module that runs it. This is the one
  //          place the answer exists in the page, so these are the checks that
  //          keep it there: a contradiction is a sentence and a byte never
  //          crosses.
  {
    const decl = (name, extra) => ({ name, checkout: true, source: `/repo/${name}`, declaration: { name, version: "0.1.0", ...extra } });
    const pluginSpec = decl("clutch-websearch", { entry: "index.js" });
    const daemonSpec = decl("clutch-workspace", { service: {}, launch: { argv: ["{py}", "{script}"], importable: true } });
    const perCallSpec = decl("clutch-memory", { launch: { argv: ["{py}", "{script}"], entry: "memory.py" } });
    const oddSpec = decl("clutch-odd", { entry: "index.js", launch: { argv: ["node", "server.js"] } });
    const bareSpec = decl("clutch-nothing", { tools: [] });
    check(components.destinationOf(pluginSpec).place === components.PLACE_CLIENT, "no process on the session machine, an `entry` to run: this client's");
    check(components.destinationOf(daemonSpec).place === components.PLACE_SESSION, "a `service` runs where the session commands run");
    check(
      components.destinationOf(perCallSpec).place === components.PLACE_SESSION,
      "a `launch` alone is one process per call, started there: the session machine too"
    );
    check(
      /declares neither/.test(components.destinationOf(bareSpec).error || ""),
      "neither a process here nor an `entry`: a component nothing could run, said in words"
    );
    check(
      /declares `entry` and `launch`/.test(components.destinationOf(oddSpec).error || ""),
      "`entry` beside a process is one declaration speaking two languages, and is refused"
    );
    // a row nobody has read yet is NOT a contradiction: the page says so instead
    const unread = components.destinationOf({ name: "clutch-unread", checkout: false, entry: { manifest: "x" } });
    check(unread.place === null && unread.read === false && unread.error === "", "a declaration not read yet is 'unknown', not a refusal");

    // a client domain, faked as ui/plugin-host.js answers it
    const clientRows = [];
    const put = [];
    const pluginHost = {
      list: () => clientRows.map((r) => ({ ...r })),
      versions: (name) => (name === "clutch-websearch" ? [{ name, version: "0.2.0", resolved: true }] : []),
      install: (opts) => {
        put.push(opts);
        const row = { name: opts.manifest.name, version: opts.version, digest: opts.manifest.digest };
        clientRows.push(row);
        return row;
      },
      remove: () => ({ status: "removed", removed: ["0.2.0"] }),
      setDisabled: () => ({ status: "disabled", disabled: true }),
    };
    const lib = fakeLib({ specs: [pluginSpec, daemonSpec, oddSpec] });
    lib.localArtifact = async (file) => file.path;
    lib.manifestFor = (file) => ({ name: file.name, version: file.version, entry: file.entry });
    const { api } = view({ lib, deps: { plugins: () => pluginHost } });

    // 1. the market row says where it goes, and the page is told by whom
    const m = await api.market();
    const rows = m.entries;
    const pluginRow = rows.find((r) => r.name === "clutch-websearch");
    const oddRow = rows.find((r) => r.name === "clutch-odd");
    check(pluginRow.place === "client" && pluginRow.read === true && !pluginRow.problem, "the market row carries the place its declaration names");
    check(oddRow.place === null && /declares `entry` and `launch`/.test(oddRow.problem), "and a contradiction arrives as a problem, with no place at all");

    // 2. the two inventories are ONE list, each row tagged with its place
    const l = await api.list(EMPTY_WIN);
    check(l.client === true && l.clientError === null && l.error === null, "both domains answered, and the shape says so");
    check(l.held.every((r) => r.place === "session" || r.place === "client"), "every row says which of the two places holds it");

    // 3. a plugin install never touches the session machine: no artifact, no
    //    upload, no fetch, no supervisor — the app process lays the bytes down
    const before = { artifacts: lib.calls.artifacts.length, uploads: lib.calls.uploads.length, fetches: lib.calls.fetches.length };
    const out = await api.install("clutch-websearch", EMPTY_WIN, {});
    check(out.ok === true && out.place === "client", "a plugin installs into this client");
    check(put.length === 1 && put[0].manifest.name === "clutch-websearch", "through the client host own install, measured by it again");
    check(
      lib.calls.uploads.length === before.uploads && lib.calls.fetches.length === before.fetches,
      "and nothing was uploaded to, or fetched by, the session machine"
    );

    // 4. a contradiction is refused BEFORE any byte is built
    const odd = await api.install("clutch-odd", EMPTY_WIN, {});
    check(odd.ok === false && /declares `entry` and `launch`/.test(odd.error), "a contradictory declaration is refused");
    check(lib.calls.artifacts.length === before.artifacts + 1, "with not one byte built for it beyond the one install above");

    // 5. a shell with no client plugin domain says so, and writes nothing
    const bare = view({ lib: fakeLib({ specs: [pluginSpec] }) });
    bare.lib.localArtifact = async (file) => file.path;
    bare.lib.manifestFor = (file) => ({ name: file.name, version: file.version });
    const none = await bare.api.install("clutch-websearch", EMPTY_WIN, {});
    check(none.ok === false && /no client plugin domain/.test(none.error), "no domain is a sentence, not a write to somewhere else");
    check(bare.lib.calls.artifacts.length === 0, "and no bytes were prepared for a place that is not there");
  }

  summary("components-view", "all passed (the two places, inventory, market cache, install + remove + switch verdicts, mirror list + retry)");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
