// In-app updating, end to end on a machine that has no installer to run.
//
// Three things are checked here, and the split is the same split the code has:
//
//   1. the PURE half (ui/update-core.js): version ordering, the two release shapes
//      a mirror or the GitHub API can answer with, and which asset belongs to this
//      (system, arch) — the decision that, when it is wrong, installs another
//      machine's build;
//   2. the I/O half (ui/update-service.js) driven against a FAKE fetch and a temp
//      directory: the check, the download, the verification against the release's
//      own size and digest, the progress it reports, and the failures a person will
//      actually meet (a 404, a dead network, a truncated file, a rewritten one);
//   3. the desktop installer (ui/update-install.js) and the About pane's state
//      machine (ui/js/update-panel.js) as DATA and as words. Nothing here spawns a
//      process, opens a dmg, runs dpkg or installs an APK — that half is on the
//      device, and this runner says so by pinning the exact command that would run
//      instead of running it.
//
// Run: node tests/update-core.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { check, summary } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const UI = path.join(ROOT, "ui");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

const core = require("../ui/update-core");
const { createUpdateService, sources, safeName, inside } = require("../ui/update-service");
const { shq, macBundle, macSwapScript, detachedCommand, createDesktopInstaller } = require("../ui/update-install");

// a folder that belongs to this runner and to nothing else
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-update-test-"));
const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(TMP, "case-"));
  tmps.push(d);
  return d;
}

// ---- the release payloads the pipeline actually publishes ----
// The names are the ones .github/workflows/release.yml + ui/electron-builder.yml
// produce (see ui/update-core.js's table): a test whose asset names do not match
// the build proves nothing about the build.
const VERSION = read(ROOT, "VERSION").trim();
const NEXT = "0.1.61";
const ASSETS = (v, size) => [
  { name: "Clutch Setup " + v + ".exe", size, browser_download_url: "https://example.invalid/Clutch%20Setup%20" + v + ".exe" },
  { name: "Clutch-" + v + "-arm64.dmg", size, browser_download_url: "https://example.invalid/Clutch-" + v + "-arm64.dmg" },
  { name: "clutch-ui_" + v + "_amd64.deb", size, browser_download_url: "https://example.invalid/clutch-ui_" + v + "_amd64.deb" },
  { name: "clutch-android-v" + v + ".apk", size, browser_download_url: "https://example.invalid/clutch-android-v" + v + ".apk" },
];

// ---- 1. versions: the one comparison the whole feature hangs on ----
{
  check(core.parseVersion("v0.1.61").nums.join(".") === "0.1.61", "a release tag is read through its leading v (v0.1.61 -> 0.1.61)");
  check(core.parseVersion("  0.1.60  ").nums.join(".") === "0.1.60", "and whitespace around a stamp is not a version difference");
  check(core.parseVersion("nightly") === null, "something that is not a version parses to null rather than to 0.0.0");

  check(core.compareVersions("0.1.61", "0.1.60") === 1, "0.1.61 is newer than 0.1.60");
  check(core.compareVersions("0.1.60", "0.1.60") === 0, "and equal to itself");
  check(core.compareVersions("0.2.0", "0.10.0") === -1, "the comparison is numeric per field, not lexicographic (0.2.0 is OLDER than 0.10.0)");
  check(core.compareVersions("1.0.0", "0.99.99") === 1, "the major field outranks the rest");
  check(core.compareVersions("v0.1.61", "0.1.60") === 1, "a tag with a v compares like the number it names");
  check(
    core.compareVersions("0.1.61-rc1", "0.1.61") === -1,
    "a prerelease sorts BELOW the release it precedes, so a build sitting on -rc1 is offered the final"
  );
  check(core.compareVersions("0.1.61", "0.1.61-rc1") === 1, "…and the final is never offered the rc");
  check(core.compareVersions("0.1.61-rc2", "0.1.61-rc1") === 1, "two prereleases still order against each other");
  check(core.compareVersions("nightly", "0.1.60") === -1, "an unreadable version sorts lowest: it can never claim to be newer");
  check(core.compareVersions("0.1.60", "nightly") === 1, "…and a real number always outranks it");
  check(core.compareVersions("nightly", "nonsense") === 0, "two unreadable strings are equal, which is the only honest answer");

  check(core.isNewer("0.1.61", "0.1.60") === true, "isNewer says yes for a newer tag");
  check(core.isNewer("0.1.60", "0.1.60") === false, "and no for the same number: an up-to-date build is not offered its own release");
  check(core.isNewer("0.1.59", "0.1.60") === false, "nor for an older one (a build ahead of the last release, a dev stamp)");
  check(core.isNewer("0.1.61", "") === true, "every release is newer than nothing, which is why the page refuses an empty stamp instead of relying on this");
}

// ---- 2. the platform key: what this machine is, in the release's terms ----
{
  check(core.platformKey({ platform: "win32", arch: "x64" }) === "win-x64", "Windows x64 -> win-x64");
  check(core.platformKey({ platform: "darwin", arch: "arm64" }) === "mac-arm64", "an Apple Silicon mac -> mac-arm64");
  check(core.platformKey({ platform: "darwin", arch: "x64" }) === "mac-x64", "an Intel mac -> mac-x64");
  check(core.platformKey({ platform: "linux", arch: "x64" }) === "linux-x64", "Linux x64 -> linux-x64");
  check(core.platformKey({ platform: "linux", arch: "aarch64" }) === "linux-arm64", "aarch64 is arm64 by another name");
  check(
    core.platformKey({ platform: "linux", arch: "arm64", mobile: true }) === "android-arm64",
    "the phone says mobile explicitly: its WebView reports a Linux user agent, so any guess off the OS would install a deb"
  );

  check(core.installKind("win-x64") === "nsis", "a Windows build is installed by the NSIS installer");
  check(core.installKind("mac-arm64") === "dmg", "a mac build by the dmg's swap script");
  check(core.installKind("linux-amd64".replace("amd64", "x64")) === "deb", "a Linux build by dpkg");
  check(core.installKind("android-arm64") === "apk", "a phone build by the system package installer");
  check(core.installKind("") === "", "and a key nobody can read picks no installer at all");
}

// ---- 3. release payloads: two shapes, one list of assets ----
{
  const gh = core.normalizeRelease({
    tag_name: "v" + NEXT,
    body: "  what changed  ",
    assets: [
      { name: "a.deb", size: 10, browser_download_url: "https://x.invalid/a.deb", digest: "sha256:ABCD" },
      { name: "b.exe", browser_download_url: "https://x.invalid/b.exe" },
      { name: "no url" },
      null,
    ],
  });
  check(gh.version === "v" + NEXT, "the GitHub shape takes its version from tag_name");
  check(gh.notes === "what changed", "and its notes from body, trimmed");
  check(gh.assets.length === 2, "an asset with no URL is dropped: there is nothing to download");
  check(gh.assets[0].sha256 === "abcd", "a stated digest is kept as the bare hex, lowercased");
  check(gh.assets[0].platform === "", "GitHub assets name no platform — the file name is the only hint there is");
  check(gh.assets[1].sha256 === "", "an asset with no digest states none rather than lying with an empty one");
  check(gh.assets[1].size === 0, "and no size is 0, not NaN");

  const own = core.normalizeRelease({
    version: NEXT,
    notes: "n",
    artifacts: {
      "linux-x64": { name: "c.deb", url: "https://x.invalid/c.deb", size: 5, sha256: "FEED" },
      "win-x64": "https://x.invalid/d.exe", // the short form: a URL and nothing else
      "mac-arm64": { name: "no url" },
    },
  });
  check(own.version === NEXT, "the self-hosted shape takes its version from version (no tag_name at all)");
  check(own.assets.length === 2, "an artifact with no URL is dropped here too");
  check(own.assets[0].platform === "linux-x64", "a named artifact carries its platform: this file exists to say which machine gets what");
  check(own.assets[0].sha256 === "feed", "its digest is normalized the same way");
  check(own.assets[1].name === "d.exe", "the short form takes its name from the URL's last segment");
  check(core.normalizeRelease(null).assets.length === 0, "a null payload normalizes to no assets instead of throwing");
}

// ---- 4. picking the file for one machine, out of one release ----
{
  const release = (v) => core.normalizeRelease({ tag_name: "v" + v, assets: ASSETS(v, 100) });
  const pick = (key, v = NEXT) => core.pickAsset(release(v), key);

  check(pick("win-x64").name === "Clutch Setup " + NEXT + ".exe", "win-x64 gets the NSIS Setup exe");
  check(pick("mac-arm64").name === "Clutch-" + NEXT + "-arm64.dmg", "mac-arm64 gets the arm64 dmg, not the one naming another arch");
  check(pick("linux-x64").name === "clutch-ui_" + NEXT + "_amd64.deb", "linux-x64 gets the amd64 deb (the name the pipeline produces)");
  check(pick("android-arm64").name === "clutch-android-v" + NEXT + ".apk", "the phone gets the universal APK");
  check(pick("win-arm64").name === "Clutch Setup " + NEXT + ".exe", "a platform with no arch in any name still gets the one file published for it");
  check(pick("linux-arm64") === null, "and a deb published only for amd64 is refused on arm64: dpkg would not unpack it, and 'no build for this machine' is the more useful answer");
  check(pick("mac-x64") === null, "mac-x64 of an arm64-only release is null: the only dmg NAMES the other architecture, and installing it would hand the user a binary their machine cannot launch");

  const single = core.normalizeRelease({ tag_name: "v" + NEXT, assets: [{ name: "Clutch-" + NEXT + ".dmg", browser_download_url: "https://x.invalid/u.dmg" }] });
  check(
    core.pickAsset(single, "mac-x64").name === "Clutch-" + NEXT + ".dmg",
    "a dmg that names no architecture at all is offered to both: a release is not refused because it stopped putting the arch in the file name"
  );

  const named = core.normalizeRelease({
    version: NEXT,
    artifacts: { "linux-x64": { name: "explicit.deb", url: "https://x.invalid/e.deb" } },
  });
  check(
    core.pickAsset(named, "linux-x64").name === "explicit.deb",
    "an artifact the manifest names for this platform wins over any name matching"
  );
  check(core.pickAsset(named, "win-x64") === null, "and a platform the manifest does not name gets nothing, which is what a manifest is for");

  check(core.pickAsset(release(NEXT), "") === null, "an unreadable platform key picks nothing (no installer, no file)");
  check(core.pickAsset(null, "linux-x64") === null, "and no release picks nothing");

  const plan = core.downloadPlan(release(NEXT), "linux-x64", { current: "0.1.60" });
  check(plan.available === true && plan.kind === "deb", "a newer release with an asset for this machine is available, to be installed as a deb");
  const same = core.downloadPlan(release("0.1.60"), "linux-x64", { current: "0.1.60" });
  check(same.available === false, "the release this build already is reports available: false");
  const ahead = core.downloadPlan(release("0.1.59"), "linux-x64", { current: "0.1.60" });
  check(ahead.available === false, "and so does an older one, though it still names an asset");
  const missing = core.downloadPlan(release(NEXT), "", { current: "0.1.60" });
  check(missing.available === false && missing.asset === null, "no platform key, no asset, no update");
}

// ---- 5. the service: a check against a fake release page ----
// One fake fetch for the whole runner: the release URL answers with a payload the
// case chose, an asset URL answers with the bytes a case chose, and everything is
// counted so "how many times did it ask?" can be asserted (that count is the
// difference between a retry policy and hammering a rate limit).
function fakeNet(opts = {}) {
  const net = { calls: [], release: null, body: null, status: 200 };
  net.fetch = async (url) => {
    net.calls.push(String(url));
    const u = String(url);
    if (u.includes("releases/latest")) {
      if (net.release instanceof Error) throw net.release;
      if (net.status !== 200) return { ok: false, status: net.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => net.release };
    }
    if (net.body instanceof Error) throw net.body;
    const chunks = Array.isArray(net.body) ? net.body : [net.body];
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(Buffer.concat(chunks).length) : null) },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        }),
      },
      arrayBuffer: async () => Buffer.concat(chunks),
    };
  };
  return net;
}

function serviceFor(opts = {}) {
  return createUpdateService(
    Object.assign(
      {
        platform: "linux",
        arch: "x64",
        updatesDir: tempDir(),
        fetchImpl: null,
        install: null,
      },
      opts
    )
  );
}

async function section5() {
  const net = fakeNet();
  net.release = { tag_name: "v" + NEXT, body: "notes", assets: ASSETS(NEXT, 100) };
  const svc = serviceFor({ fetchImpl: net.fetch });
  check(svc.key === "linux-x64" && svc.kind === "deb", "the service knows which key and which installer this machine is, before anything is asked");

  const plan = await svc.check({ current: "0.1.60" });
  check(plan.ok && plan.available, "a newer release for this machine is an available update");
  check(plan.latest === "v" + NEXT && plan.current === "0.1.60", "the plan names both numbers: what is here and what is out");
  check(plan.asset && plan.asset.name === "clutch-ui_" + NEXT + "_amd64.deb", "and the exact file it will download");
  check(plan.key === "linux-x64" && plan.kind === "deb", "with the platform key and the install kind on the answer, so the page words its button without re-deciding");
  check(plan.notes === "notes", "the release notes travel with the plan");
  check(plan.newer === true, "and `newer` says the version moved (whether or not a file exists for this machine)");
  check(svc.plan().latest === "v" + NEXT, "the plan is held: download() is the second half of this decision, never a new one");

  // every check is a fresh look at the release page (it is cheap, and a release
  // published since the last press must be seen); the download, though, acts on
  // the plan this check settled on and never re-asks
  const before = net.calls.length;
  const again = await svc.check({ current: "0.1.60" });
  check(again.ok && net.calls.length === before + 1, "a second check does ask again — cheap, and the only way a release published since the last press is seen");

  // "newer, but nothing for this machine" is its own sentence
  const macOnly = fakeNet();
  macOnly.release = {
    tag_name: "v" + NEXT,
    assets: [{ name: "Clutch-" + NEXT + "-arm64.dmg", browser_download_url: "https://example.invalid/x.dmg" }],
  };
  const linux = serviceFor({ fetchImpl: macOnly.fetch, arch: "arm64" });
  const noFile = await linux.check({ current: "0.1.60" });
  check(noFile.ok && noFile.available === false && noFile.newer === true, "a release that publishes nothing for this machine is 'newer but not for you', which is not the same as up to date");
  check(/no linux-arm64 build/.test(noFile.reason), "and the reason names the platform key it looked for (" + noFile.reason + ")");

  const upToDate = fakeNet();
  upToDate.release = { tag_name: "v" + VERSION, assets: ASSETS(VERSION, 100) };
  const current = await serviceFor({ fetchImpl: upToDate.fetch }).check({ current: VERSION });
  check(current.ok && current.available === false && current.newer === false, "the release this build already is: not available, not newer");
  check(current.reason === "up to date", "and the reason says so plainly");

  const noStamp = await serviceFor({ fetchImpl: fakeNet().fetch }).check({ current: "" });
  check(noStamp.ok === false && /does not state its own version/.test(noStamp.error), "a build with no stamp is refused: comparing against nothing would offer every release to a checkout");
}

// ---- 6. the service: a download, verified against the release ----
async function section6() {
  const body = Buffer.from("this stands in for a 40 MB deb, and it is not four lines long\n".repeat(40));
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const dir = tempDir();
  const net = fakeNet();
  net.release = {
    tag_name: "v" + NEXT,
    body: "notes",
    assets: [
      {
        name: "clutch-ui_" + NEXT + "_amd64.deb",
        size: body.length,
        browser_download_url: "https://example.invalid/clutch-ui.deb",
        digest: "sha256:" + sha,
      },
    ],
  };
  // two chunks, so the streamed path (not the arrayBuffer shortcut) is what runs
  const half = Math.ceil(body.length / 2);
  net.body = [body.subarray(0, half), body.subarray(half)];

  const staged = [];
  const svc = serviceFor({
    updatesDir: dir,
    fetchImpl: net.fetch,
    install: (file, info) => {
      staged.push({ file, info });
      return { ok: true, command: "pkexec", args: ["dpkg", "-i", file], quits: false };
    },
  });
  await svc.check({ current: "0.1.60" });

  const progress = [];
  const got = await svc.download({ onProgress: (stage) => progress.push(stage) });
  check(got.ok === true, "the download lands (" + (got.error || "ok") + ")");
  check(got.name === "clutch-ui_" + NEXT + "_amd64.deb", "under the name the release gave it");
  check(got.path === path.join(dir, got.name), "inside the one directory this service will hand to an installer");
  check(fs.readFileSync(got.path).equals(body), "and the bytes on disk are the bytes that were served");
  check(got.size === body.length, "the size is what arrived");
  check(got.sha256 === sha && got.verified === true, "the sha256 is computed and checked against the digest the release pinned");
  check(got.version === "v" + NEXT && got.kind === "deb", "the result still says which release and which installer it belongs to");
  check(!fs.existsSync(got.path + ".part"), "the .part file is renamed away, never left behind: a .part is not installable and must not look like it is");

  check(progress.length >= 2, "progress is reported more than once over a download (" + progress.length + " stages)");
  check(
    progress[0].phase === "download" && progress[0].received === 0,
    "starting at zero bytes, before anything is fetched — a button that shows nothing until a server answers looks dead"
  );
  check(
    progress.every((s, i) => i === 0 || s.received >= progress[i - 1].received),
    "and never going backwards"
  );
  check(
    progress.some((s) => s.percent === 100),
    "reaching 100% before the file is called done"
  );
  check(progress[progress.length - 1].phase === "verified", "and ending on the verification, not on the last byte");
  check(progress.every((s) => s.file === got.name), "every stage names the file, so the pane can say what is downloading");

  const refused = await svc.install("/etc/passwd");
  check(refused.ok === false && staged.length === 0, "installing a path outside the download directory is refused, and the installer is never called");
  const installed = await svc.install(got.path);
  check(installed.ok === true && installed.quits === false, "a file this service downloaded is handed to the installer, whose answer travels back whole");
  check(staged.length === 1 && staged[0].info.kind === "deb", "with the install kind and the version the plan settled on (" + JSON.stringify(staged[0] && staged[0].info) + ")");

  // no installer at all (a page whose shell has none)
  const bare = serviceFor({ updatesDir: dir, fetchImpl: net.fetch });
  await bare.check({ current: "0.1.60" });
  const nowhere = await bare.install(path.join(dir, got.name));
  check(nowhere.ok === false && /cannot install/.test(nowhere.error), "a build with no installer says so instead of pretending");

  // a download with no check behind it
  const blank = serviceFor({ fetchImpl: net.fetch });
  const early = await blank.download();
  check(early.ok === false && /check first/.test(early.error), "downloading before checking is refused: there is no decision to act on yet");

  // and a service with nowhere to write
  const homeless = createUpdateService({ platform: "linux", arch: "x64", updatesDir: "", fetchImpl: net.fetch });
  await homeless.check({ current: "0.1.60" });
  const nowhereToPut = await homeless.download();
  check(nowhereToPut.ok === false && /no directory/.test(nowhereToPut.error), "and a service with no directory says that rather than failing on a filesystem call");
}

// ---- 7. the service: the failures, which are the part that actually happens ----
async function section7() {
  // a 404 is an ANSWER: every mirror would say the same thing
  const gone = fakeNet();
  gone.status = 404;
  const svc = serviceFor({ fetchImpl: gone.fetch });
  const answer = await svc.check({ current: "0.1.60" });
  check(answer.ok === false && /HTTP 404/.test(answer.error), "a 404 from the release page is reported as a failed check (" + answer.error + ")");
  check(gone.calls.length === 1, "and it is NOT retried through the mirror list: a 404 is the same 404 through every prefix, so asking again only costs a request");

  // a dead network is a reason about the road, so the mirrors are tried
  const dead = fakeNet();
  dead.release = new Error("getaddrinfo ENOTFOUND api.github.com");
  const deadSvc = serviceFor({ fetchImpl: dead.fetch });
  const unreachable = await deadSvc.check({ current: "0.1.60" });
  check(unreachable.ok === false && /ENOTFOUND/.test(unreachable.error), "an unreachable host is a failed check with the network's own words in it");
  check(
    dead.calls.length === sources(core.RELEASE_URL).length,
    "and it IS retried through every configured place (" + dead.calls.length + " of " + sources(core.RELEASE_URL).length + "), because a different prefix is a different road"
  );

  // the body is not the JSON the API promises (a captive portal, an error page)
  const html = fakeNet();
  html.release = { json: null };
  const portal = createUpdateService({
    platform: "linux",
    arch: "x64",
    updatesDir: tempDir(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token <"); } }),
  });
  const notJson = await portal.check({ current: "0.1.60" });
  check(notJson.ok === false && /not JSON/.test(notJson.error), "a body that is not JSON says so (a captive portal answers 200 with a login page)");

  // a failure is not cached: the next press is a new attempt
  check(portal.plan() === null, "a failed check is not remembered — the next press must be a new attempt, not a replay of an error");

  // the file arrives short
  const shortBody = Buffer.from("half");
  const shortNet = fakeNet();
  shortNet.release = {
    tag_name: "v" + NEXT,
    assets: [{ name: "clutch-ui_x.deb", size: 9999, browser_download_url: "https://example.invalid/s.deb" }],
  };
  shortNet.body = [shortBody];
  const shortDir = tempDir();
  const shortSvc = serviceFor({ updatesDir: shortDir, fetchImpl: shortNet.fetch });
  await shortSvc.check({ current: "0.1.60" });
  const truncated = await shortSvc.download();
  check(truncated.ok === false && /did not match the release/.test(truncated.error), "a file shorter than the release states is refused (" + truncated.error + ")");
  check(fs.readdirSync(shortDir).length === 0, "and nothing is left on disk: neither the file nor a .part the installer might find");

  // the file is the right length and the wrong bytes
  const swappedNet = fakeNet();
  swappedNet.release = {
    tag_name: "v" + NEXT,
    assets: [
      {
        name: "clutch-ui_y.deb",
        size: 4,
        browser_download_url: "https://example.invalid/y.deb",
        digest: "sha256:" + "0".repeat(64),
      },
    ],
  };
  swappedNet.body = [Buffer.from("evil")];
  const swappedDir = tempDir();
  const swapped = serviceFor({ updatesDir: swappedDir, fetchImpl: swappedNet.fetch });
  await swapped.check({ current: "0.1.60" });
  const rewritten = await swapped.download();
  check(rewritten.ok === false && /sha256/.test(rewritten.error), "a file that matches the size but not the pinned sha256 is refused: this is the only integrity fact in the path");
  check(fs.readdirSync(swappedDir).length === 0, "and it is deleted, not kept as something a later press might install");

  // a download that fails for a path reason is retried from nothing, not resumed
  const flaky = fakeNet();
  flaky.release = { tag_name: "v" + NEXT, assets: [{ name: "f.deb", size: 4, browser_download_url: "https://example.invalid/f.deb" }] };
  let attempts = 0;
  const original = flaky.fetch;
  const flakySvc = serviceFor({
    updatesDir: tempDir(),
    fetchImpl: async (url, opts) => {
      if (String(url).includes("f.deb") && attempts++ === 0) throw new Error("ECONNRESET");
      return original(url, opts);
    },
  });
  flaky.body = [Buffer.from("done")];
  await flakySvc.check({ current: "0.1.60" });
  const retried = await flakySvc.download();
  const places = sources("https://example.invalid/f.deb").length;
  check(
    places === 1 ? attempts === 1 && retried.ok === false : retried.ok === true && attempts >= 2,
    "a download cut by the network is retried from the beginning through the next place, never resumed onto a partial file (" +
      attempts + " attempt(s) over " + places + " place(s))"
  );
}

// ---- 8. names and paths: the two shortcuts a page must not have ----
{
  check(safeName("../../etc/passwd") === "passwd", "an asset name is reduced to its basename: a release cannot name a path");
  check(safeName("Clutch Setup 0.1.61.exe") === "Clutch_Setup_0.1.61.exe", "and to characters a filename can hold (spaces become underscores, the extension stays)");
  check(safeName("clutch-ui_0.1.61_amd64.deb") === "clutch-ui_0.1.61_amd64.deb", "the names the pipeline produces pass through unchanged");
  check(safeName("") === "clutch-update", "an empty name still gets one, so the download has somewhere to go");
  check(safeName("..") === "clutch-update" && safeName(".") === "clutch-update", "and '.'/'..' are not names");

  const dir = path.join(TMP, "inside");
  check(inside(dir, path.join(dir, "a.deb")) === true, "a file directly in the download directory is inside it");
  check(inside(dir, path.join(dir, "nested", "a.deb")) === true, "a file in a subdirectory is inside it too");
  check(inside(dir, path.join(dir, "..", "a.deb")) === false, "a sibling reached through .. is not");
  check(inside(dir, dir) === false, "and the directory itself is not a file to install");
  check(inside("", "/tmp/a.deb") === false, "a service with no directory has nothing inside it");
}

// ---- 9. the desktop installer, as data ----
{
  check(shq("plain") === "'plain'", "a shell word is single-quoted");
  check(shq("a b") === "'a b'", "so a path with a space stays one word");
  check(shq("it's") === "'it'\\''s'", "and an apostrophe cannot end the quoting early");

  check(
    macBundle("/Applications/Clutch.app/Contents/MacOS/clutch") === "/Applications/Clutch.app",
    "the bundle is derived from the executable Electron reports (…/Contents/MacOS/… -> ….app)"
  );
  check(macBundle("/home/me/clutch/ui/node_modules/electron/dist/electron") === "", "a checkout running from a folder is not a .app bundle, and says so");

  const script = macSwapScript({ dmg: "/tmp/x y/Clutch-0.1.61-arm64.dmg", app: "/Applications/Clutch.app" });
  check(/^#!\/bin\/sh/.test(script), "the mac swap script is a /bin/sh script");
  check(script.includes("DMG='/tmp/x y/Clutch-0.1.61-arm64.dmg'"), "with the dmg path quoted into it");
  check(script.includes("APP='/Applications/Clutch.app'"), "and the bundle it is replacing");
  check(script.includes("LOG='/tmp/x y/Clutch-0.1.61-arm64.dmg.log'"), "and a log file beside the download: the script runs with no terminal, so anything it has to say goes to a file");
  check(/pgrep/.test(script), "it waits for this process to exit before touching the bundle (a running executable is mapped)");
  check(script.includes('hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MNT"'), "it mounts the dmg read-only at a directory of its own choosing, so the volume name cannot collide");
  check(/find "\$MNT" -maxdepth 1 -name "\*\.app"/.test(script), "it finds the .app inside the mounted image");
  check(script.includes('ditto "$SRC" "$STAGE"'), "stages a copy with ditto, which keeps the bundle's metadata");
  check(script.includes('mv "$APP" "$OLD"'), "moves the old bundle aside rather than deleting it first");
  check(script.includes('mv "$OLD" "$APP"'), "and puts it back if the new one cannot be moved in");
  check(script.includes('xattr -cr "$APP"'), "clears the quarantine flag an unsigned dmg would set, which macOS would otherwise refuse to launch");
  check(/open "\$APP"/.test(script), "and reopens the app the user was using");

  check(JSON.stringify(detachedCommand("nsis", "/tmp/Clutch Setup.exe")) === JSON.stringify({ cmd: "/tmp/Clutch Setup.exe", args: ["/S"] }), "Windows runs the Setup exe with /S (the user already pressed Install)");
  check(detachedCommand("dmg", "/tmp/c.dmg", { scriptPath: "/tmp/s.sh" }).cmd === "/bin/sh", "macOS runs the swap script");
  check(JSON.stringify(detachedCommand("dmg", "/tmp/c.dmg", { scriptPath: "/tmp/s.sh" }).args) === JSON.stringify(["/tmp/s.sh"]), "with the script as its argument, not as its interpreter");
  check(detachedCommand("dmg", "/tmp/c.dmg") === null, "and a dmg with no script has no command at all");
  check(
    JSON.stringify(detachedCommand("deb", "/tmp/c.deb", { pkexec: true })) === JSON.stringify({ cmd: "pkexec", args: ["dpkg", "-i", "/tmp/c.deb"] }),
    "Linux with pkexec runs dpkg behind the polkit prompt"
  );
  check(
    JSON.stringify(detachedCommand("deb", "/tmp/c.deb")) === JSON.stringify({ cmd: "xdg-open", args: ["/tmp/c.deb"] }),
    "and without pkexec hands the deb to the desktop's own installer"
  );
  check(detachedCommand("apk", "/tmp/c.apk") === null, "an APK has no desktop command: the phone installs its own");
  check(detachedCommand("nsis", "") === null, "and no file, no command");
}

async function section9b() {
  // the spawner, with everything it would touch replaced: this is the closest a
  // runner without an OS installer can come to pressing the button
  const dir = tempDir();
  const file = path.join(dir, "Clutch Setup 0.1.61.exe");
  fs.writeFileSync(file, "installer");

  const spawned = [];
  const quits = [];
  const installer = createDesktopInstaller({
    platform: "win32",
    appBundle: "",
    quit: () => quits.push(Date.now()),
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref: () => {}, on: () => {} };
    },
    existsSync: (p) => p === file,
    tmpDir: dir,
    log: () => {},
  });

  const missing = installer.install(path.join(dir, "gone.exe"));
  check(missing.ok === false && /gone/.test(missing.error), "a file that is not there is refused by name, not by a failed spawn");

  const started = installer.install(file);
  check(started.ok === true && started.command === file, "Windows installs by running the Setup exe");
  check(JSON.stringify(started.args) === JSON.stringify(["/S"]), "silently: the consent was the button");
  check(started.quits === true, "and the app quits so the installer can replace the running exe");
  check(spawned.length === 1 && spawned[0].opts.detached === true, "spawned detached, because it has to outlive this process");
  check(spawned[0].opts.stdio === "ignore", "with no pipes to a process that is about to be replaced");
  check(quits.length === 0, "the quit is NOT immediate: the command has just been handed to the OS");
  await new Promise((r) => setTimeout(r, 400));
  check(quits.length === 1, "it happens a moment later, once the spawn has returned");

  const mac = createDesktopInstaller({
    platform: "darwin",
    appBundle: "",
    spawnImpl: () => ({ unref: () => {}, on: () => {} }),
    existsSync: () => true,
    tmpDir: dir,
  });
  const noBundle = mac.install(file, { kind: "dmg" });
  check(noBundle.ok === false && /\.app bundle/.test(noBundle.error), "a mac build that is not running from a .app has nothing to replace, and says so instead of writing a script that would fail later");

  const scripted = createDesktopInstaller({
    platform: "darwin",
    appBundle: "/Applications/Clutch.app",
    quit: () => {},
    spawnImpl: (cmd, args) => {
      spawned.push({ cmd, args });
      return { unref: () => {}, on: () => {} };
    },
    existsSync: () => true,
    tmpDir: dir,
  });
  const dmg = path.join(dir, "Clutch-0.1.61-arm64.dmg");
  const macStarted = scripted.install(dmg, { kind: "dmg" });
  check(macStarted.ok === true && macStarted.quits === true, "a mac install quits too: the script is waiting for exactly that");
  check(macStarted.command === "/bin/sh", "and it runs the generated script");
  const scriptPath = macStarted.args[0];
  check(fs.existsSync(scriptPath), "which was written to disk");
  check((fs.statSync(scriptPath).mode & 0o777) === 0o700, "with owner-only permissions: it is a file that replaces an application bundle");

  const linux = createDesktopInstaller({
    platform: "linux",
    quit: () => quits.push("linux"),
    spawnImpl: (cmd, args) => {
      spawned.push({ cmd, args });
      return { unref: () => {}, on: () => {} };
    },
    existsSync: (p) => p === "/usr/bin/pkexec" || p === file,
    tmpDir: dir,
  });
  const deb = linux.install(file, { kind: "deb" });
  check(deb.ok === true && deb.command === "pkexec", "a Linux install with pkexec on the machine runs dpkg");
  check(deb.quits === false, "and does NOT quit: dpkg needs no exit and the polkit prompt may still be cancelled");
  await new Promise((r) => setTimeout(r, 400));
  check(quits.length === 1, "so the only quit in this section is the Windows one — a Linux press never closes the app under the user");
}

// ---- 10. the About pane's state machine ----
// The real ui/js/update-panel.js, in a context holding exactly what it touches: a
// document of two elements, the build stamp, and whichever bridges a scenario says
// this page has. The words are the thing under test — they are what a person acts
// on.
const PANEL = read(UI, "js", "update-panel.js");

function panel(bridges = {}) {
  const els = new Map();
  function element(id) {
    if (els.has(id)) return els.get(id);
    const el = { id, textContent: "", disabled: false, classes: new Set(), listeners: {} };
    el.classList = {
      toggle(name, on) {
        if (on) el.classes.add(name);
        else el.classes.delete(name);
      },
    };
    el.addEventListener = (ev, fn) => {
      el.listeners[ev] = fn;
    };
    els.set(id, el);
    return el;
  }

  const box = { document: { getElementById: element }, console: { warn: () => {}, log: () => {} } };
  box.window = box; // the page's global scope: window.x IS x
  vm.createContext(box);
  if ("version" in bridges && bridges.version !== null) box.CLUTCH_VERSION = bridges.version;
  if (bridges.update) box.clutchUpdate = bridges.update;
  if (bridges.shell) box.clutchShell = bridges.shell;
  vm.runInContext(PANEL, box, { filename: "js/update-panel.js" });

  return {
    box,
    button: () => element("about-update-btn"),
    note: () => element("about-update-note"),
    press: () => vm.runInContext("runUpdate()", box),
    reset: () => element("settings-tab-about").listeners.click(),
  };
}

// a bridge whose answers a case chooses, counting the calls it was asked to make
function fakeBridge(answers) {
  const bridge = {
    calls: [],
    check: async (current) => {
      bridge.calls.push(["check", current]);
      return answers.check;
    },
    download: async () => {
      bridge.calls.push(["download"]);
      return typeof answers.download === "function" ? answers.download() : answers.download;
    },
    install: async (file) => {
      bridge.calls.push(["install", file]);
      return answers.install;
    },
    onProgress: (cb) => {
      bridge.listener = cb;
      return () => {};
    },
  };
  return bridge;
}

async function section10() {
  // --- a plain browser: no bridge, so nothing to promise ---
  {
    const p = panel({ version: VERSION });
    check(p.button().disabled === true, "outside the app the button is disabled: there is no installer behind this page");
    check(/Open the app/.test(p.note().textContent), "and the line says what to do instead (" + p.note().textContent + ")");
    await p.press(); // must be a no-op, not a throw
    check(true, "pressing it anyway does nothing");
  }

  // --- a build with no stamp passes no version, and the shell decides ---
  {
    const bridge = fakeBridge({ check: { ok: false, current: "", key: "linux-x64", kind: "deb", error: "this build does not state its own version" } });
    const p = panel({ version: null, update: bridge });
    await p.press();
    check(bridge.calls[0][0] === "check" && bridge.calls[0][1] === "", "the check is asked with the page's own stamp — empty when the page has none (the desktop shell falls back to its package version)");
    check(p.button().textContent === "Try again", "a failed check leaves a button that says Try again");
    check(p.note().classes.has("error"), "and a line in the alert tone");
    check(/does not state its own version/.test(p.note().textContent), "carrying the reason, in the words the service used (" + p.note().textContent + ")");
    check(p.button().disabled === false, "so the next press is possible");

    const stamped = panel({ version: "0.1.60", update: fakeBridge({ check: { ok: true, available: false, reason: "up to date", current: "0.1.60", latest: "v0.1.60", key: "linux-x64", kind: "deb" } }) });
    await stamped.press();
    check(/newest release/.test(stamped.note().textContent), "an up-to-date build is told it is on the newest release (" + stamped.note().textContent + ")");
    check(stamped.button().textContent === "Check for updates", "and the button goes back to what it says when there is nothing to do");
    check(stamped.note().classes.has("error") === false, "with no alert tone: being current is not a failure");
  }

  // --- available: the second press is the consent, and it does everything ---
  {
    const bridge = fakeBridge({
      check: {
        ok: true,
        available: true,
        current: "0.1.60",
        latest: "v0.1.61",
        key: "linux-x64",
        kind: "deb",
        asset: { name: "clutch-ui_0.1.61_amd64.deb", size: 2621440, url: "https://example.invalid/x.deb" },
      },
      download: { ok: true, path: "/home/me/.config/clutch/updates/clutch-ui_0.1.61_amd64.deb", name: "clutch-ui_0.1.61_amd64.deb", size: 2621440 },
      install: { ok: true, command: "xdg-open", quits: false },
    });
    const p = panel({ version: "0.1.60", update: bridge });
    await p.press();
    check(p.button().textContent === "Install 0.1.61", "a newer build turns the button into the version it will install (" + p.button().textContent + ")");
    check(p.button().disabled === false, "and keeps it pressable: that press is the consent to replace the running build");
    check(/2\.5 MB/.test(p.note().textContent), "the line states the size, so a phone on a slow network knows what it is starting (" + p.note().textContent + ")");
    check(bridge.calls.length === 1, "nothing was downloaded yet");

    await p.press();
    check(bridge.calls[1][0] === "download", "the second press downloads");
    check(bridge.calls[2][0] === "install" && bridge.calls[2][1] === "/home/me/.config/clutch/updates/clutch-ui_0.1.61_amd64.deb", "and then hands the FILE — not the URL — to the installer");
    check(/finish it there/.test(p.note().textContent), "a Linux install does not quit the app, so the line asks the user to finish in the installer and restart (" + p.note().textContent + ")");

    // the reset: reopening the pane starts over, unless something is in flight
    p.reset();
    check(p.button().textContent === "Check for updates", "reopening the About pane forgets a finished answer");
  }

  // --- the download reports bytes, and the pane shows them ---
  {
    let release = null;
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "win-x64", kind: "nsis", asset: { name: "Clutch Setup 0.1.61.exe", size: 20971520 } },
      download: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, path: "C:/updates/Clutch Setup 0.1.61.exe", size: 20971520 });
        }),
      install: { ok: true, command: "C:/updates/Clutch Setup 0.1.61.exe", args: ["/S"], quits: true },
    });
    const p = panel({ version: "0.1.60", update: bridge });
    await p.press();
    const downloading = p.press(); // not awaited: it is in flight
    await new Promise((r) => setTimeout(r, 0));
    check(p.button().textContent === "Downloading…", "while the bytes are arriving the button says Downloading…");
    check(p.button().disabled === true, "and is disabled: a second press mid-download would start a second one");

    bridge.listener({ phase: "download", file: "Clutch Setup 0.1.61.exe", received: 10485760, total: 20971520, percent: 50 });
    check(/50% of 20\.0 MB/.test(p.note().textContent), "progress reaches the line as a percentage of the total (" + p.note().textContent + ")");
    bridge.listener({ phase: "download", file: "Clutch Setup 0.1.61.exe", received: 20971520, total: 20971520, percent: 100 });
    check(/100%/.test(p.note().textContent), "and reaches 100% before the file is called done");

    release();
    await downloading;
    check(/Restarting/.test(p.button().textContent), "a Windows/macOS install quits the app, so the button says it is restarting (" + p.button().textContent + ")");
    check(/comes back as Clutch 0\.1\.61/.test(p.note().textContent), "and the line names the build that is coming back (" + p.note().textContent + ")");

    // a stale stage from another window must not repaint this pane
    const quiet = fakeBridge({ check: { ok: true, available: false, reason: "up to date", current: "0.1.60", latest: "v0.1.60" } });
    const idle = panel({ version: "0.1.60", update: quiet });
    quiet.listener({ phase: "download", file: "someone-else.exe", received: 1, total: 10, percent: 10 });
    check(idle.note().textContent === "", "progress that arrives while this pane is not downloading is ignored (the phone's bridge fans out to every window)");
  }

  // --- a failed download, and the press that follows it ---
  {
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "android-arm64", kind: "apk", asset: { name: "clutch-android-v0.1.61.apk", size: 0 } },
      download: { ok: false, error: "download failed: getaddrinfo ENOTFOUND example.invalid" },
      install: { ok: true },
    });
    const p = panel({ version: "0.1.60", update: bridge, shell: { installApk: () => '{"ok":true}' } });
    await p.press();
    check(p.button().textContent === "Install 0.1.61", "a release whose size the API does not state still gets a button (no size in the line, but the version is)");
    await p.press();
    check(/the download failed:/.test(p.note().textContent), "a failed download says what failed (" + p.note().textContent + ")");
    check(p.note().classes.has("error") && p.button().textContent === "Try again", "and offers a fresh press — which checks again, because that plan's file never arrived");
    check(bridge.calls.filter((c) => c[0] === "download").length === 1, "and does not silently retry the download: a press is what starts one");
  }

  // --- the phone: its own installer, its own permission, its own words ---
  {
    const installs = [];
    const shell = {
      installApk: (file) => {
        installs.push(file);
        return '{"ok":true}';
      },
    };
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "android-arm64", kind: "apk", asset: { name: "clutch-android-v0.1.61.apk", size: 52428800 } },
      download: { ok: true, path: "/data/user/0/io.clutch.mobile/files/updates/clutch-android-v0.1.61.apk", name: "clutch-android-v0.1.61.apk", size: 52428800 },
      install: { ok: false, error: "the phone's shell installs an APK — the page calls window.clutchShell.installApk for that" },
    });
    const p = panel({ version: "0.1.60", update: bridge, shell });
    await p.press();
    await p.press();
    check(installs.length === 1 && installs[0].endsWith("clutch-android-v0.1.61.apk"), "the phone's own `clutchShell.installApk` is what receives the downloaded APK");
    check(bridge.calls.every((c) => c[0] !== "install"), "the node-side installer is never asked: on a phone it would have nothing to run");
    check(/the phone's installer is opening/.test(p.note().textContent), "and the line says the system installer is opening, not that the app is restarting (" + p.note().textContent + ")");
  }

  // --- the phone refuses for want of a permission, and the download is kept ---
  {
    let answer = '{"needsPermission":true}';
    const shell = { installApk: () => answer };
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "android-arm64", kind: "apk", asset: { name: "clutch-android-v0.1.61.apk", size: 52428800 } },
      download: { ok: true, path: "/files/updates/clutch-android-v0.1.61.apk", size: 52428800 },
      install: { ok: false, error: "unused" },
    });
    const p = panel({ version: "0.1.60", update: bridge, shell });
    await p.press();
    await p.press();
    check(p.button().textContent === "Install" && p.button().disabled === false, "a missing install permission comes back as a pressable Install");
    check(/allow installs from Clutch/.test(p.note().textContent), "the line names the setting, because the screen that just opened asks for it by name (" + p.note().textContent + ")");
    check(p.note().classes.has("error"), "in the alert tone: nothing has been installed");
    answer = '{"ok":true}';
    await p.press();
    check(bridge.calls.filter((c) => c[0] === "download").length === 1, "and the second press installs the KEPT file — the phone's 50 MB is not downloaded twice");
    check(bridge.calls.filter((c) => c[0] === "install").length === 0, "still through the phone's installer");
  }

  // --- an installer that does not start at all ---
  {
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "linux-x64", kind: "deb", asset: { name: "clutch-ui_0.1.61_amd64.deb", size: 1024 } },
      download: { ok: true, path: "/tmp/updates/clutch-ui_0.1.61_amd64.deb", size: 1024 },
      install: { ok: false, error: "no way to install a deb file from inside Clutch" },
    });
    const p = panel({ version: "0.1.60", update: bridge });
    await p.press();
    await p.press();
    check(/the installer did not start/.test(p.note().textContent), "an installer that refuses says so (" + p.note().textContent + ")");
    check(p.button().textContent === "Install", "and the file stays in hand, so the next press retries the install rather than the download");
    await p.press();
    check(bridge.calls.filter((c) => c[0] === "download").length === 1, "which it does not repeat");
    check(bridge.calls.filter((c) => c[0] === "install").length === 2, "the install is retried, though");
  }

  // --- an unreadable answer from the phone's bridge ---
  {
    const bridge = fakeBridge({
      check: { ok: true, available: true, current: "0.1.60", latest: "v0.1.61", key: "android-arm64", kind: "apk", asset: { name: "a.apk", size: 10 } },
      download: { ok: true, path: "/files/a.apk", size: 10 },
      install: { ok: true },
    });
    const p = panel({ version: "0.1.60", update: bridge, shell: { installApk: () => "not json" } });
    await p.press();
    await p.press();
    check(/unreadable/.test(p.note().textContent), "a bridge that answers something unreadable is reported as that, not as success");
    check(p.note().classes.has("error") && p.button().textContent === "Install", "and leaves the file in hand");
  }

  // --- a bridge that throws (an IPC that died) ---
  {
    const bridge = fakeBridge({});
    bridge.check = async () => {
      throw new Error("ipc channel closed");
    };
    const p = panel({ version: "0.1.60", update: bridge });
    await p.press();
    check(/the update failed: ipc channel closed/.test(p.note().textContent), "a rejected bridge call is caught and said out loud (" + p.note().textContent + ")");
    check(p.button().disabled === false, "and never leaves the button stuck disabled");
  }
}

// ---- 11. the page: markup, stylesheet and load order ----
{
  const html = read(UI, "index.html");
  const css = read(UI, "style.css");
  const paneAt = html.indexOf('id="settings-pane-about"');
  const paneEnd = html.indexOf('<div class="modal-actions">');
  const pane = paneAt >= 0 && paneEnd > paneAt ? html.slice(paneAt, paneEnd) : "";

  check(pane.includes('id="about-update-btn"'), "the About pane carries the update button");
  check(pane.includes('id="about-update-note"'), "and the line its states are written into");
  check(/id="about-update-note"[^>]*role="status"[^>]*aria-live="polite"/.test(pane), "which is announced as it changes, the way every other status line on this page is");
  check(/<button id="about-update-btn" type="button">/.test(pane), "the button is a plain type=button (a form submit would reload the page)");
  check(pane.indexOf('id="about-update-btn"') > pane.indexOf('<dl class="about-list">'), "and it sits under the facts, not inside them: it is a control, not a fact");

  check(
    html.indexOf('<script src="js/update-panel.js"></script>') > html.indexOf('<script src="js/settings.js"></script>'),
    "the panel loads after the file that paints the About pane (it reads the same build stamp)"
  );
  check(html.indexOf('<script src="js/update-panel.js"></script>') < html.indexOf('<script src="js/boot.js"></script>'), "and before boot.js, which starts the app");

  const rule = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  };
  check(/display: flex/.test(rule(".about-update")), "the update block is its own row under the facts");
  check(/min-height: 1\.5em/.test(rule(".about-update-note")), "and its status line reserves one line's height, so the button does not move under the pointer that just pressed it");
  check(/color: var\(--danger\)/.test(rule(".about-update-note.error")), "a failed step is drawn in the alert tone the rest of the page uses");
  check(
    !/\.about-update/.test(read(UI, "mobile.css")),
    "the phone sheet does not restate these rules: a button and a sentence fit a narrow box as they are"
  );
}

(async () => {
  await section5();
  await section6();
  await section7();
  await section9b();
  await section10();
  summary("update-core: the About pane's update button, from the release page to the installer");
})().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
