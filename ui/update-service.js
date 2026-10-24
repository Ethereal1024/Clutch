// In-app updating, the half that touches the network and the disk — the shell
// side of the About pane's button. What it decides (is the release newer? which
// file belongs to this machine?) is ui/update-core.js, which has no I/O at all;
// what it runs once the file is on disk is the shell's own business
// (ui/update-install.js for Electron, the WebView's `clutchShell` for Android).
// Splitting it there is what lets this file be driven in a test with a fake
// fetch and a temp directory, which is the only way any of it gets exercised
// without a device.
//
// The shape follows how open-source desktop apps do this outside a store, minus
// the machinery they carry for features this build does not have (no delta
// patches, no staged rollouts, no code signing yet):
//
//   * ask the release API once, cache the ANSWER, and let download() re-use it:
//     a check and the download that follows must describe the same release, or a
//     release published in between installs a file the UI never named;
//   * stream the bytes to `<name>.part` next to the destination and rename at the
//     end, so a killed download can never be mistaken for a complete one — and a
//     `.part` is never offered to the installer;
//   * weigh the result against what the release stated (the sha256 when GitHub
//     publishes a digest, the size always) before the file becomes installable.
//     The dmg and the installer are unsigned, so this is a check against a
//     man-in-the-middle rewriting the bytes, not against a malicious upstream;
//   * report progress as bytes, not as a spinner: a 100 MB APK on a phone's
//     connection is minutes, and a button that looks dead gets pressed again.
//
// The mirror this machine reads under (ui/net-fetch.js) applies here like it does
// to every other shipped source, and the accelerator list behind it
// (ui/mirrors.js) is tried in turn — but only when the failure is about the path
// to the bytes (a timeout, a gateway), never when the release host gave an
// answer. A 404 is the same 404 through every prefix; asking again only costs a
// request.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const core = require("./update-core");
const { netFetch, mirrorPrefix, mirrored } = require("./net-fetch");
const mirrors = require("./mirrors");

// A release answer is a few kilobytes: 20 seconds is already a broken network.
const CHECK_TIMEOUT_MS = 20000;
// A download may take minutes, so it is not bounded by total time — it is bounded
// by SILENCE. A link that delivers nothing for a minute is dead whether the file
// is 1 MB or 100 MB, and the abort is retryable (below), so a stalled line that
// comes back still installs.
const STALL_TIMEOUT_MS = 60000;

// --------------------------------------------------------------- the places --

// Every URL this read is worth trying, in order: the forced prefix alone when the
// user set one (`source_mirror` already moved every source, so there is nothing
// left to fall back to), otherwise the release host itself and then the
// accelerator list (ui/mirrors.js — the user's entries first, then the build's).
function sources(url) {
  const forced = mirrorPrefix();
  if (forced) return [mirrored(url, forced)];
  const out = [url];
  for (const prefix of mirrors.candidates()) {
    const place = mirrored(url, prefix);
    if (!out.includes(place)) out.push(place);
  }
  return out;
}

// Did the source ANSWER (and the answer was "no")? Then every other prefix says
// the same thing and trying it is a wasted request: 404 (no such release), 403
// (the unauthenticated rate limit), 401, 400 are verdicts about the request, not
// about this machine's road to it. A 5xx, a timeout, a socket error, a body that
// is not JSON — those are the road, and a different prefix is a different road.
function answered(err) {
  const m = String((err && err.message) || err).match(/HTTP (\d{3})\b/);
  return Boolean(m) && Number(m[1]) < 500;
}

// One read, through each place in turn until one of them does not fail for a
// reason about the path. `each` does the actual work and owns the error wording.
async function readThrough(url, each) {
  let last = null;
  const places = sources(url);
  for (let i = 0; i < places.length; i++) {
    try {
      return await each(places[i]);
    } catch (e) {
      last = e;
      if (answered(e)) throw e;
    }
  }
  // every place failed for a reason about the path: report the FIRST one, which
  // is the release host the user meant, not an accelerator's rephrasing of it
  throw last || new Error("no source to read " + url);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref && timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------- the names --

// An asset name is untrusted text that becomes a path, so only its basename
// survives — and only characters a filename can safely hold. The extension is
// what the installer picks its command from, so it is left as it is.
function safeName(name) {
  const base = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._+-]/g, "_");
  return base && base !== "." && base !== ".." ? base : "clutch-update";
}

// Is `file` inside `dir`? The renderer names the file it wants installed (it is
// the side that just downloaded it), so the check is what keeps a page — or a
// bug — from asking the shell to run something else on this machine.
function inside(dir, file) {
  if (!dir) return false;
  const root = path.resolve(dir);
  const target = path.resolve(String(file || ""));
  return target !== root && target.startsWith(root + path.sep);
}

// ------------------------------------------------------------------ service --

// opts:
//   platform / arch / mobile   what this machine is (node's own by default; the
//                              Android host passes mobile: true explicitly)
//   releaseUrl                 the release API (ui/update-core.js RELEASE_URL)
//   updatesDir                 where downloads land — the ONLY directory this
//                              service will hand to an installer
//   install                    (file, {kind, version}) -> {ok, ...} | throws; the
//                              shell's installer, or null when there is none
//   fetchImpl                  the fetch to use (tests); defaults to netFetch()
//   onProgress                 default sink for `{phase, …}` stage objects
//   log                        one-line log sink
function createUpdateService(opts = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    mobile = false,
    releaseUrl = core.RELEASE_URL,
    updatesDir = "",
    install = null,
    fetchImpl = null,
    onProgress = null,
    log = () => {},
  } = opts;

  const key = core.platformKey({ platform, arch, mobile });
  const kind = core.installKind(key);
  let plan = null; // the last successful check, and what download() installs

  function emit(sink, stage) {
    const fn = sink || onProgress;
    if (typeof fn !== "function") return;
    try {
      fn(stage);
    } catch (e) {
      /* a progress sink must never take a download down with it */
    }
  }

  function theFetch() {
    return fetchImpl || netFetch();
  }

  // The release JSON. `current` comes from the page: the stamp it is showing is
  // the version the user is reading, and comparing against anything else would
  // let the button say "up to date" over an About row that says otherwise.
  async function check({ current = "" } = {}) {
    const version = String(current || "").trim();
    emit(null, { phase: "check", current: version });
    if (!version) {
      // no stamp: a checkout served plainly. Comparing against nothing would make
      // every release "newer" and offer an install of a build this tree is not,
      // so the button says it cannot tell instead.
      plan = { ok: false, current: "", key, kind, error: "this build does not state its own version" };
      return plan;
    }
    try {
      const json = await readThrough(releaseUrl, async (place) => {
        const { signal, done } = timeoutSignal(CHECK_TIMEOUT_MS);
        try {
          const res = await theFetch()(place, {
            headers: { Accept: "application/vnd.github+json" },
            signal,
          });
          if (!res || !res.ok) throw new Error(`HTTP ${(res && res.status) || 0} from ${place}`);
          try {
            return await res.json();
          } catch (e) {
            throw new Error(`the release answer from ${place} is not JSON (${(e && e.message) || e})`);
          }
        } finally {
          done();
        }
      });
      const release = core.normalizeRelease(json);
      if (!release.version) throw new Error("the release names no version");
      const decided = core.downloadPlan(release, key, { current: version });
      // "newer, but nothing published for this machine" is a different sentence
      // from "up to date", and a person reading the pane deserves the difference:
      // it is the difference between waiting and reporting the release.
      const newer = core.isNewer(decided.version, version);
      const reason = decided.available
        ? ""
        : decided.asset
          ? "up to date"
          : `the latest release (${decided.version}) publishes no ${key} build`;
      plan = {
        ok: true,
        current: version,
        latest: decided.version,
        available: decided.available,
        reason,
        key: decided.key,
        kind: decided.kind,
        asset: decided.asset,
        notes: decided.notes,
        newer,
      };
      return plan;
    } catch (e) {
      // a failed check is NOT cached: it is the answer to this attempt, and the
      // next press must be a new attempt (a network came back, a mirror was set)
      plan = null;
      const error = String((e && e.message) || e || "the update check failed");
      log(`[update] check failed: ${error}`);
      return { ok: false, current: version, key, kind, error };
    }
  }

  // The bytes, into updatesDir. Uses the plan check() settled on: a download is
  // the second half of one decision, never a new one.
  async function download({ onProgress: sink = null } = {}) {
    if (!plan || !plan.ok) {
      const error =
        plan && plan.error ? plan.error : "there is no checked update to download — check first";
      return { ok: false, error };
    }
    if (!plan.available || !plan.asset) {
      return { ok: false, error: plan.reason || "no update is available for this build" };
    }
    if (!updatesDir) return { ok: false, error: "this build has no directory to download into" };

    const asset = plan.asset;
    const name = safeName(asset.name || String(asset.url || "").split("/").pop());
    const dest = path.join(updatesDir, name);
    const part = `${dest}.part`;
    const expectSize = Number(asset.size) || 0;

    try {
      fs.mkdirSync(updatesDir, { recursive: true });
    } catch (e) {
      return { ok: false, error: `could not create ${updatesDir}: ${(e && e.message) || e}` };
    }

    emit(sink, { phase: "download", file: name, received: 0, total: expectSize, percent: 0 });
    // Progress is a UI fact, not a log: emit on each whole percent (or every 1 MB
    // when the release stated no size), so a phone's IPC is not flooded by a
    // fast link's chunk rate.
    let lastPercent = -1;
    let lastBytes = 0;
    const onBytes = (received, total) => {
      const percent = total ? Math.min(100, Math.floor((received * 100) / total)) : 0;
      if (total ? percent === lastPercent : received - lastBytes < 1024 * 1024) return;
      lastPercent = percent;
      lastBytes = received;
      emit(sink, { phase: "download", file: name, received, total, percent });
    };

    let got;
    try {
      got = await readThrough(asset.url, async (place) => {
        // A download is bounded by SILENCE, not by total time: the timer is
        // re-armed on every chunk below, so a slow link that keeps delivering
        // finishes and a link that goes quiet for a minute is abandoned (and
        // retried through the next place, which restarts it from nothing — a
        // partial file is never resumed).
        const controller = new AbortController();
        const { signal } = controller;
        let stall = null;
        const bump = () => {
          clearTimeout(stall);
          stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
          stall.unref && stall.unref();
        };
        bump();
        const done = () => clearTimeout(stall);
        try {
          const res = await theFetch()(place, { signal });
          if (!res || !res.ok) throw new Error(`HTTP ${(res && res.status) || 0} from ${place}`);
          const header = (name) =>
            Number((res.headers && typeof res.headers.get === "function" && res.headers.get(name)) || 0);
          const total = expectSize || header("content-length") || 0;
          const hash = crypto.createHash("sha256");
          const fd = fs.openSync(part, "w");
          let received = 0;
          try {
            if (res.body && typeof res.body.getReader === "function") {
              const reader = res.body.getReader();
              for (;;) {
                const { done: end, value } = await reader.read();
                if (end) break;
                if (!value || !value.length) continue;
                fs.writeSync(fd, value);
                hash.update(value);
                received += value.length;
                bump();
                onBytes(received, total);
              }
            } else {
              // no stream on this response (an older shell, a test's stub): the
              // whole body at once. Progress then arrives in one step, which is
              // honest — the bytes really did arrive together.
              const buf = Buffer.from(await res.arrayBuffer());
              fs.writeSync(fd, buf);
              hash.update(buf);
              received = buf.length;
              onBytes(received, total);
            }
          } finally {
            fs.closeSync(fd);
          }
          return { received, total, sha256: hash.digest("hex"), place };
        } finally {
          done();
        }
      });
    } catch (e) {
      try {
        fs.unlinkSync(part);
      } catch (_e) {
        /* nothing to clean up */
      }
      const error = `download failed: ${(e && e.message) || e}`;
      log(`[update] ${error}`);
      return { ok: false, error };
    }

    // What the release said, weighed against what arrived. Size always (GitHub
    // states it for every asset), sha256 when the release pinned one — GitHub
    // only started publishing `digest` recently, so an older release states
    // none and the size is all there is to check against. The installer is
    // unsigned, so this is the only integrity fact in the path.
    const expectedSize = expectSize || got.total || 0;
    const problems = [];
    if (expectedSize && got.received !== expectedSize) {
      problems.push(`${got.received} bytes, not the ${expectedSize} the release states`);
    }
    if (asset.sha256 && got.sha256 !== asset.sha256) {
      problems.push(`sha256 ${got.sha256}, not the ${asset.sha256} the release pins`);
    }
    if (problems.length) {
      try {
        fs.unlinkSync(part);
      } catch (_e) {
        /* already gone */
      }
      const error = `${name} did not match the release: ${problems.join("; ")}`;
      log(`[update] ${error}`);
      return { ok: false, error };
    }

    try {
      fs.renameSync(part, dest); // the rename is what makes the file installable
    } catch (e) {
      return { ok: false, error: `could not finish ${name}: ${(e && e.message) || e}` };
    }
    emit(sink, { phase: "verified", file: name, received: got.received, total: expectedSize, percent: 100 });
    return {
      ok: true,
      path: dest,
      name,
      size: got.received,
      sha256: got.sha256,
      verified: Boolean(asset.sha256),
      version: plan.latest,
      key: plan.key,
      kind: plan.kind,
      notes: plan.notes,
    };
  }

  // The shell's installer, behind one check: only a file this service downloaded
  // is a file worth installing. The desktop installer also quits the app (its
  // command replaces the running build); the phone's installer is the WebView's
  // own `clutchShell`, which the page calls instead — this is the honest refusal.
  async function installUpdate(file) {
    if (typeof install !== "function") {
      return { ok: false, error: "this build cannot install an update by itself" };
    }
    if (!inside(updatesDir, file)) {
      return { ok: false, error: "that file is not a downloaded update" };
    }
    if (!plan || !plan.ok) return { ok: false, error: "no update has been checked" };
    try {
      const result = await install(file, { kind: plan.kind, version: plan.latest });
      return result && typeof result === "object" ? result : { ok: true };
    } catch (e) {
      const error = String((e && e.message) || e || "the installer could not be started");
      log(`[update] install failed: ${error}`);
      return { ok: false, error };
    }
  }

  return {
    check,
    download,
    install: installUpdate,
    key,
    kind,
    // the plan as it stands, for a page that reopens the pane mid-download
    plan: () => (plan ? { ...plan } : null),
  };
}

module.exports = { createUpdateService, sources, safeName, inside };
