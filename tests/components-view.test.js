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
    fetchError = null,
    versions = [{ name: "clutch-memory", version: VERSION, interface: "cli", digest: DIGEST, path: "/root/0.1.0", resolved: true }],
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
    check(l.held.length === 0 && /did not answer/.test(l.error || ""), "a read of a machine that is not running stays a sentence, not a wake");
  }

  summary("components-view", "all passed (target machine, inventory, market cache, install + remove + switch verdicts)");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
