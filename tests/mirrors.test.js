// The list behind the mirror (ui/mirrors.js), checked without a network:
//
//   1. the LIST — what this build ships, what a user's own file adds, and the
//      order they are tried in (the user's first, the build's behind it, one
//      entry per prefix);
//   2. the POLICY — when a failed install is worth trying somewhere else at all,
//      which is [] for a source that is not http(s), a source already under a
//      prefix, and any source at all while `source_mirror` is set (that knob
//      already moved every read);
//   3. the CLASSIFIER — the difference between "this machine could not reach it"
//      and "the source answered": the first is retried, the second never is.
//
// Everything happens under a throwaway HOME, so the real ~/.clutch is not read
// and a stray file there cannot make this runner pass or fail.
//
// Run: node tests/mirrors.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// A sandbox HOME BEFORE the require: mirrors.js resolves ~/.clutch at module load
// (USER_FILE), and net-fetch reads settings.json through it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-mirrors-home-"));
process.env.HOME = HOME;
delete process.env.CLUTCH_SOURCE_MIRROR;

const { check, summary } = require("./harness");
const mirrors = require("../ui/mirrors");

const ROOT = path.join(__dirname, "..");
const SHIPPED_FILE = path.join(ROOT, "ui", "components.mirrors.json");
const SHIPPED_RAW = fs.readFileSync(SHIPPED_FILE, "utf8");

// the shipped list as the module must report it: same order, no trailing slash
const SHIPPED = JSON.parse(SHIPPED_RAW).mirrors.map((m) => m.replace(/\/+$/, ""));

const SETTINGS = path.join(HOME, ".clutch", "settings.json");
const SRC = "https://github.com/Ethereal1024/clutch-skills/releases/latest/download/clutch-component.json";
const EXPLICIT = "https://explicit.invalid/";

function writeUser(data) {
  fs.mkdirSync(path.dirname(mirrors.USER_FILE), { recursive: true });
  fs.writeFileSync(mirrors.USER_FILE, typeof data === "string" ? data : JSON.stringify(data));
}
function clearUser() {
  fs.rmSync(mirrors.USER_FILE, { force: true });
}
function writeSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, typeof data === "string" ? data : JSON.stringify(data));
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  // ---- 1. the shipped list ----------------------------------------------
  check(mirrors.BUILTIN_FILE === SHIPPED_FILE, "the shipped list is read from inside this build's ui/ (the bundle)");
  check(fs.existsSync(mirrors.BUILTIN_FILE), "and that file is in the tree, so a packaged build can carry it");
  check(
    mirrors.candidates().length === SHIPPED.length && same(mirrors.candidates(), SHIPPED),
    `with no user file the list is exactly what this build ships, in order (${SHIPPED.join(", ")})`
  );
  check(
    mirrors.entries().every((e) => e.source === "builtin"),
    "and every entry says it came with the build — a row nobody can remove has to look like one"
  );
  check(
    SHIPPED.every((m) => {
      try {
        return new URL(m).protocol === "https:";
      } catch (e) {
        return false;
      }
    }),
    "every shipped mirror is an https URL: a prefix a user cannot see must not be downgraded to http"
  );

  // ---- 2. the user's own list -------------------------------------------
  check(mirrors.USER_FILE !== mirrors.BUILTIN_FILE, "a user's entries live in ~/.clutch, never in the app bundle");
  check(mirrors.add("https://mine.invalid").ok === true, "a mirror can be added");
  check(
    same(mirrors.add("https://mine.invalid"), { ok: false, error: "https://mine.invalid is already in the list" }),
    "the same prefix twice is refused: it would be the same attempt twice"
  );
  check(
    mirrors.entries()[0].url === "https://mine.invalid" && mirrors.entries()[0].source === "user",
    "the user's entry leads the list"
  );
  check(
    same(mirrors.candidates(), ["https://mine.invalid", ...SHIPPED]),
    "and the shipped list is still behind it, entry for entry"
  );
  let dup = mirrors.add(SHIPPED[0]);
  check(
    dup.ok === false && /already in the list \(this build ships it\)/.test(dup.error),
    "adding a mirror this build already ships is refused, and says why"
  );
  check(mirrors.add("") .ok === false, "an empty value is not a mirror");
  check(mirrors.add("file:///srv/mirror") .ok === false, "a non-http(s) value is refused rather than obeyed");
  check(mirrors.add("/srv/mirror") .ok === false, "and so is a bare path: <prefix>/<url> is the only shape a mirror has");
  check(mirrors.add("https://") .ok === false, "a scheme with no host is a typo, not a prefix");

  // a bare host is how a user writes it; the scheme is the one thing a mirror
  // cannot have a preference about, so https is assumed
  check(mirrors.add("bare.invalid").ok === true, "a bare host is accepted");
  check(
    mirrors.entries()[1].url === "https://bare.invalid",
    "and is read as https, at the same place in the list"
  );

  // the file is a small JSON document, and the user's list is what survives a
  // restart: it has to be the shape the reader expects
  const written = JSON.parse(fs.readFileSync(mirrors.USER_FILE, "utf8"));
  check(
    written.schema === 1 && same(written.mirrors, ["https://mine.invalid", "https://bare.invalid"]),
    "the write is the documented shape: {schema: 1, mirrors: [...]}"
  );
  if (process.platform !== "win32") {
    check(
      (fs.statSync(mirrors.USER_FILE).mode & 0o777) === 0o600,
      "the user's file is 0600, like the settings mirror beside it"
    );
  }

  // a duplicate entry that got into the file by hand is still ONE entry, and the
  // user's spelling of it wins (it is the one they can remove)
  writeUser({ schema: 1, mirrors: [SHIPPED[1]] });
  check(
    mirrors.entries().length === SHIPPED.length &&
      mirrors.entries()[0].source === "user" &&
      mirrors.entries()[0].url === SHIPPED[1],
    "a hand-written copy of a shipped prefix is one entry, and the user's own row is the one kept"
  );

  // values a file cannot mean are dropped, not obeyed: obeying one would rewrite
  // every source into a URL nobody serves
  writeUser({ schema: 1, mirrors: ["/srv/mirror", "ghproxy.invalid", "", SHIPPED[0] + "///"] });
  check(
    same(mirrors.candidates(), ["https://ghproxy.invalid", ...SHIPPED]),
    "a file's unusable values are dropped, and a trailing slash is the same mirror"
  );
  writeUser({ schema: 2, mirrors: ["https://mine.invalid"] });
  check(same(mirrors.candidates(), SHIPPED), "a schema this build cannot read is not guessed at");
  writeUser("{not json at all");
  check(same(mirrors.candidates(), SHIPPED), "a mangled user file leaves the shipped list alone instead of throwing");

  // ---- 3. remove --------------------------------------------------------
  mirrors.add("https://mine.invalid");
  check(mirrors.remove(EXPLICIT).ok === false, "a prefix that is in neither list cannot be removed");
  check(mirrors.remove(EXPLICIT).error === `${EXPLICIT.replace(/\/$/, "")} is not in your list`, "and the refusal names it");
  let no = mirrors.remove(SHIPPED[0]);
  check(
    no.ok === false && /this build ships — it is always tried/.test(no.error),
    "a mirror this build ships cannot be removed: it is what the fallback is made of"
  );
  check(same(mirrors.candidates(), ["https://mine.invalid", ...SHIPPED]), "and the refusal changed nothing");
  check(mirrors.remove("mine.invalid").ok === true, "the user's own entry goes (spelled the way they added it)");
  check(same(mirrors.candidates(), SHIPPED), "leaving the shipped list exactly as it was");
  check(
    same(JSON.parse(fs.readFileSync(SHIPPED_FILE, "utf8")), JSON.parse(SHIPPED_RAW)),
    "no write in this runner touched the list in the bundle"
  );
  clearUser();

  // ---- 4. who gets a fallback at all ------------------------------------
  check(same(mirrors.fallbackFor(SRC), SHIPPED), "a plain https source gets this machine's list");
  check(same(mirrors.fallbackFor(SRC, false), []), "and a caller can say no fallback, ever");
  check(same(mirrors.fallbackFor(SRC, []), []), "or name an empty list of its own");
  check(
    same(mirrors.fallbackFor(SRC, [EXPLICIT, "ghproxy.invalid"]), [EXPLICIT.replace(/\/$/, ""), "https://ghproxy.invalid"]),
    "a caller's own array is taken literally, normalized the same way"
  );
  check(same(mirrors.fallbackFor("/opt/components/clutch-component.json"), []), "a source on disk has no mirror");
  check(same(mirrors.fallbackFor("file:///srv/index/clutch-component.json"), []), "and neither does a file: URL");
  check(
    same(mirrors.fallbackFor(SHIPPED[0] + "/" + SRC), []),
    "a URL already under a prefix is not prefixed again: <mirror>/<url> is served by nobody"
  );
  check(
    same(mirrors.viaPrefix(SHIPPED[0] + "/" + SRC), SHIPPED[0]) && mirrors.viaPrefix(SRC) === "",
    "viaPrefix names the prefix a URL is already read through, and nothing when there is none"
  );

  // `source_mirror` outranks all of it: it moves every read, manifest included,
  // so there is nothing left for a per-source fallback to do
  process.env.CLUTCH_SOURCE_MIRROR = "https://forced.invalid/";
  check(mirrors.forced() === "https://forced.invalid", "the environment's mirror is the forced one");
  check(same(mirrors.fallbackFor(SRC), []), "and while it is set, no source gets a fallback");
  check(same(mirrors.fallbackFor(SRC, [EXPLICIT]), [EXPLICIT.replace(/\/$/, "")]), "a caller's own list still stands: a test is not silenced by the machine's setting");
  check(mirrors.viaPrefix("https://forced.invalid/" + SRC) === "https://forced.invalid", "and a URL under it is read through it");
  delete process.env.CLUTCH_SOURCE_MIRROR;
  writeSettings({ source_mirror: "https://settings.invalid/" });
  check(mirrors.forced() === "https://settings.invalid", "source_mirror in settings.json forces it too (a GUI launch has no environment)");
  check(same(mirrors.fallbackFor(SRC), []), "with the same consequence for a fallback");
  writeSettings({ source_mirror: "not a url" });
  check(mirrors.forced() === "" && same(mirrors.fallbackFor(SRC), SHIPPED), "a settings value that is not http(s) forces nothing");
  fs.rmSync(SETTINGS);

  // ---- 5. what is worth trying again ------------------------------------
  const network = [
    ["<urlopen error timed out>", "the host quoting its own urllib, which is how a 504-less timeout arrives"],
    ["HTTP Error 504: Gateway Time-out", "a gateway that gave up on the asset"],
    ["HTTP Error 503", "a host refusing for the moment"],
    ["fetch failed", "node's own sentence for a socket that never carried anything"],
    ["connect ECONNREFUSED 127.0.0.1:443", "a proxy that is not there"],
    ["read ECONNRESET", "a connection that died mid-read"],
    ["socket hang up", "the same, said by http"],
    ["net::ERR_CONNECTION_TIMED_OUT", "the app's own Chromium error"],
    ["TLS handshake failed: certificate has expired", "a path that cannot be trusted as it stands"],
    ["getaddrinfo ENOTFOUND github.com", "a name that will not resolve"],
    ["connection reset by peer", "a middlebox hanging up"],
    ["the stream closed before the body was read", "a body that stopped arriving"],
  ];
  for (const [reason, why] of network) {
    check(mirrors.looksLikeNetwork(reason), `retried: ${why} — ${JSON.stringify(reason)}`);
  }
  const answers = [
    ["HTTP Error 404: Not Found", "the source's verdict on that path"],
    ["HTTP Error 403: Forbidden", "the source's verdict on this client"],
    ["HTTP Error 401: Unauthorized", "an answer about who is asking"],
    ["HTTP Error 400: Bad Request", "an answer about what was asked"],
    ["the artifact hashes to 608f3392dc1a3b, not the declared 48b52003a1c7f0", "bytes that do not match the pin"],
    ["declares no sha256 for linux-arm64", "a release that pins nothing to weigh"],
    ["this release publishes no artifact for win32-x64", "a platform the release never built"],
    ["unreadable component declaration: expected schema 1", "a body this client cannot read"],
    ["is already installed at 0.1.0", "the host's own state, which a mirror cannot change"],
    ["", "nothing said at all"],
  ];
  for (const [reason, why] of answers) {
    check(!mirrors.looksLikeNetwork(reason), `not retried: ${why} — ${JSON.stringify(reason)}`);
  }
  check(!mirrors.looksLikeNetwork(null) && !mirrors.looksLikeNetwork(undefined), "and a missing reason is not a network failure");
  // the statuses are read as whole numbers: a digest's own digits are not a status
  check(
    !mirrors.looksLikeNetwork("the artifact hashes to 608f3392dc1a3b11e0, not the declared 48b5200320dc1a3b"),
    "a 3-digit run inside a hex digest is not read as a retryable status"
  );
  check(
    mirrors.looksLikeNetwork("the target machine did not answer: HTTP Error 502: Bad Gateway"),
    "and a status in the middle of a sentence still counts"
  );

  clearUser();
  fs.rmSync(HOME, { recursive: true, force: true });
}

try {
  main();
  summary("mirrors");
} catch (e) {
  console.log("FAIL: uncaught: " + ((e && e.stack) || e));
  process.exit(1);
}
