// "Is there a newer build of this app, and which file is it for THIS machine?"
// — the pure half of in-app updating. No network, no disk, no spawn: everything
// here is a function of values, which is what makes it testable off-device and
// what lets ui/update-service.js (I/O) and the two shells stay thin.
//
// The reference this follows is the GitHub release itself: every open-source
// desktop app that is not in a store starts there. electron-updater reads a
// latest.yml from the release, VS Code and Obsidian ask an API shaped like the
// one below, and Signal/Electron's own docs all land on the same three facts —
// a tag, a body of release notes, and a list of assets with URLs. The release
// this project's .github/workflows/release.yml attaches already carries one
// asset per platform (deb, dmg, exe, apk), so nothing new has to be published:
// the version is `tag_name` and the file is `assets[]`.
//
// Two shapes are understood, because a self-hosted or mirrored index is worth
// having when the API is unreachable (ui/mirrors.js does the same for the
// component market):
//
//   GitHub release   {tag_name: "v0.1.60", body: "…", assets: [{name,
//                     browser_download_url, size, digest: "sha256:…"}]}
//   update.json      {version: "0.1.60", notes: "…", artifacts: {
//                     "win-x64": {name, url, size, sha256}, …}}
//
// The second names the platform outright, so it wins where it is used; the
// first is matched by the file names the release pipeline already produces.

"use strict";

// The newest release of this repository. One URL, no token: the API answers
// unauthenticated reads at 60 requests an hour per address, and an update check
// is a handful a day.
const RELEASE_URL = "https://api.github.com/repos/Ethereal1024/Clutch/releases/latest";

// ---- versions ----
// The build stamp is a plain `MAJOR.MINOR.PATCH` (VERSION, ui/package.json,
// ui/version.js all carry it), so a prerelease suffix is only ever compared
// when a tag carries one — `-rc1` sorts BELOW the release it precedes, which is
// what semver says and what "you are on 0.1.60-rc1, 0.1.60 is out" needs.
function parseVersion(text) {
  const m = String(text == null ? "" : text)
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" };
}

// -1 / 0 / 1, semver's own ordering. Unparseable input sorts lowest, so a tag
// nobody can read never claims to be newer than the build in hand.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release outranks its own prereleases
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

// ---- what this machine is, in the release's own terms ----
// The release publishes one artifact per (system, arch); the key is that pair.
// `mobile` is not a guess about the OS: the phone's WebView reports a Linux
// user agent, so the Android shell says so explicitly (android/host).
function platformKey({ platform, arch, mobile = false } = {}) {
  const a = String(arch || "").toLowerCase();
  const archKey = a === "arm64" || a === "aarch64" ? "arm64" : a === "x64" || a === "amd64" ? "x64" : a || "x64";
  if (mobile) return "android-" + archKey;
  const p = String(platform || "").toLowerCase();
  if (p === "win32" || p === "windows") return "win-" + archKey;
  if (p === "darwin" || p === "mac" || p === "macos") return "mac-" + archKey;
  return "linux-" + archKey;
}

// How the file is installed, once it is on disk. This is the one fact the UI
// needs to word its button honestly ("Install" is the same word everywhere, but
// what it opens is not) and the installer needs to pick a command.
function installKind(key) {
  const k = String(key || "");
  if (k.startsWith("win-")) return "nsis";
  if (k.startsWith("mac-")) return "dmg";
  if (k.startsWith("linux-")) return "deb";
  if (k.startsWith("android-")) return "apk";
  return "";
}

// ---- a release payload -> one shape ----
// `assets` entries always come out as {name, url, size, sha256}; a field the
// release did not state is "" (size 0), never a lie about the bytes.
function normalizeRelease(json) {
  const raw = json && typeof json === "object" ? json : {};
  const version = String(raw.tag_name || raw.version || "").trim();
  const notes = String(raw.body || raw.notes || "").trim();
  const artifacts = raw.artifacts && typeof raw.artifacts === "object" ? raw.artifacts : null;
  const assets = [];
  if (artifacts) {
    for (const [key, entry] of Object.entries(artifacts)) {
      const e = entry && typeof entry === "object" ? entry : { url: entry };
      const url = String(e.url || "");
      if (!url) continue;
      assets.push({
        platform: String(key), // named: pickAsset prefers this over any guess
        name: String(e.name || url.split("/").pop() || ""),
        url,
        size: Number(e.size || 0),
        sha256: String(e.sha256 || "").toLowerCase(),
      });
    }
  }
  const list = Array.isArray(raw.assets) ? raw.assets : [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const url = String(a.browser_download_url || a.url || "");
    if (!url) continue;
    // GitHub states the digest as "sha256:<hex>"; older releases state none
    const digest = String(a.digest || "");
    assets.push({
      platform: "",
      name: String(a.name || url.split("/").pop() || ""),
      url,
      size: Number(a.size || 0),
      sha256: (digest.startsWith("sha256:") ? digest.slice(7) : "").toLowerCase(),
    });
  }
  return { version, notes, assets };
}

// The artifact for one platform key, or null.
//
// An explicit `platform` entry (update.json) is taken as authoritative — that
// file exists precisely so a publisher can say "this machine gets this file".
// Otherwise the GitHub asset list is matched by the names the pipeline produces
// (.github/workflows/release.yml + ui/electron-builder.yml):
//
//   win-x64    "Clutch Setup 0.1.60.exe"        (NSIS)
//   mac-arm64  "Clutch-0.1.60-arm64.dmg"
//   linux-x64  "clutch-ui_0.1.60_amd64.deb"
//   android-*  "clutch-android-v0.1.60.apk"     (one universal APK)
//
// The arch hints are preferences, not requirements: a release that publishes a
// single dmg publishes it without "arm64" in the name, and refusing it would be
// a build nobody can update. What is never offered is a file that NAMES another
// architecture: the only thing that could come of it is an app the machine cannot
// launch (or a deb dpkg refuses to unpack), and "nothing was published for this
// machine" is the more useful answer — the release page is still one click away.
const _SUFFIX = { nsis: ".exe", dmg: ".dmg", deb: ".deb", apk: ".apk" };
const _ARCH_HINT = {
  "mac-arm64": ["arm64", "aarch64", "apple-silicon"],
  "mac-x64": ["x64", "intel", "amd64"],
  "linux-x64": ["amd64", "x86_64", "x64"],
  "linux-arm64": ["arm64", "aarch64"],
  "win-x64": ["x64", "amd64"],
  "win-arm64": ["arm64", "aarch64"],
  "android-arm64": ["arm64"],
  "android-x64": ["x86_64", "x64"],
};

function pickAsset(release, key) {
  const assets = (release && release.assets) || [];
  const named = assets.find((a) => a.platform && a.platform === key);
  if (named) return named;
  const kind = installKind(key);
  const suffix = _SUFFIX[kind];
  if (!suffix) return null;
  const candidates = assets.filter((a) => !a.platform && a.name.toLowerCase().endsWith(suffix));
  if (!candidates.length) return null;
  const hints = _ARCH_HINT[key] || [];
  const wanted = candidates.filter((a) => hints.some((h) => a.name.toLowerCase().includes(h)));
  if (wanted.length) return wanted[0];
  // nothing names OUR arch: accept a file that names none of the others'
  const others = Object.entries(_ARCH_HINT)
    .filter(([k]) => k !== key && installKind(k) === kind)
    .flatMap(([, hs]) => hs);
  const neutral = candidates.filter((a) => !others.some((h) => a.name.toLowerCase().includes(h)));
  return neutral[0] || null;
}

// The mirror prefix belongs to a URL, not to a manifest: an artifact URL under
// a prefix is the same file from somewhere else (ui/net-fetch.js `mirrored`
// does the work; this re-export keeps the call sites from importing two
// modules to ask one question).
function downloadPlan(release, key, { current = "" } = {}) {
  const asset = pickAsset(release, key);
  return {
    version: release ? release.version : "",
    available: Boolean(release && asset && isNewer(release.version, current)),
    kind: installKind(key),
    key,
    asset,
    notes: release ? release.notes : "",
  };
}

module.exports = {
  RELEASE_URL,
  parseVersion,
  compareVersions,
  isNewer,
  platformKey,
  installKind,
  normalizeRelease,
  pickAsset,
  downloadPlan,
};
