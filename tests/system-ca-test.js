// ui/system-ca.js is the desktop main process adopting the OS certificate store
// — the store the renderer (Chromium) already verified against, and the reason a
// page reached the network while the model request was refused with "self signed
// certificate". Two things have to hold and they are tested separately here:
//
//   * the TIERS: every runtime this code runs on picks the strongest install it
//     can (global → per request → none), and no tier ever relaxes verification;
//   * the SHAPE of what is installed: Node's bundled roots stay, the system ones
//     are added beside them, and the same certificate is not handed in twice.
//
// All of it against an injected runtime, so the result does not depend on which
// Node this happens to be (and so a machine with no system store is testable at
// all). The socket end — "a root installed this way is actually accepted" — is
// in tests/llm-client.test.js, where a real HTTPS peer can be minted.
// Run: node tests/system-ca-test.js
"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness");
const { installSystemTrust, trustOptions, describeTrust } = require("../ui/system-ca.js");

const ROOT = path.join(__dirname, "..");
const BUNDLED = ["-----BEGIN CERTIFICATE-----\nBUNDLED-1\n-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\nBUNDLED-2\n-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\nSHARED\n-----END CERTIFICATE-----"];
const SYSTEM = ["-----BEGIN CERTIFICATE-----\nSHARED\n-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\nSYSTEM-1\n-----END CERTIFICATE-----"];

// a runtime, spelled the way node spells it: stores by name, and (optionally)
// the global install
function runtime({ bundled = BUNDLED.slice(), system = SYSTEM.slice(), install = "ok", throwsOn } = {}) {
  const state = { installed: null, calls: 0 };
  const mod = {
    getCACertificates(kind) {
      if (throwsOn === kind) throw new Error("no such store");
      if (kind === "default") return bundled;
      if (kind === "system") return system;
      return [];
    },
  };
  if (install === "ok") {
    mod.setDefaultCACertificates = (list) => {
      state.calls++;
      state.installed = list;
    };
  } else if (install === "throw") {
    mod.setDefaultCACertificates = () => {
      state.calls++;
      throw new Error("refused");
    };
  }
  return { mod, state };
}

function main() {
  // ---- 1. tier 1: a runtime with the global install uses it, once ----
  {
    const { mod, state } = runtime();
    const report = installSystemTrust({ tlsModule: mod });
    check(report.tier === "global", "a runtime with tls.setDefaultCACertificates installs globally");
    check(state.installed !== null, "…by actually calling it");
    check(report.bundled === 3 && report.system === 2, "the report counts what each store offered");
    check(
      JSON.stringify(state.installed) ===
        JSON.stringify([
          BUNDLED[0],
          BUNDLED[1],
          BUNDLED[2],
          "-----BEGIN CERTIFICATE-----\nSYSTEM-1\n-----END CERTIFICATE-----",
        ]),
      "what it installs is bundled first, then the system roots, deduped by the certificate itself"
    );
    check(report.total === state.installed.length, "the report's total is the list it installed");
    check(JSON.stringify(trustOptions()) === "{}", "in tier 1 a request site adds nothing: the global store already carries them");
    installSystemTrust({ tlsModule: mod });
    check(state.calls === 2, "installing again is allowed (it is called from ready and from nothing else)");
  }

  // ---- 2. tier 2: no global API (older runtime) → the list rides on the request ----
  {
    const { mod } = runtime({ install: "absent" });
    const report = installSystemTrust({ tlsModule: mod });
    check(report.tier === "request", "a runtime with no tls.setDefaultCACertificates installs per request");
    const opts = trustOptions();
    check(Array.isArray(opts.ca) && opts.ca.length === report.total, "trustOptions() hands over the whole merged list");
    check(opts.ca.indexOf(BUNDLED[0]) !== -1 && opts.ca.some((c) => /SYSTEM-1/.test(c)), "…both stores, because the bundled roots stay trusted too");
    check(opts.ca.filter((c) => /SHARED/.test(c)).length === 1, "…with no certificate in it twice");
  }

  // ---- 3. a global API that refuses this list falls back, it does not give up ----
  {
    const { mod } = runtime({ install: "throw" });
    const report = installSystemTrust({ tlsModule: mod });
    check(report.tier === "request", "a global install that throws falls back to the per-request tier");
    check(Array.isArray(trustOptions().ca) && trustOptions().ca.length > 0, "…so the roots still reach the request");
  }

  // ---- 4. no system store / no API at all: nothing changes, and nothing throws ----
  {
    const { mod } = runtime({ system: [] });
    check(installSystemTrust({ tlsModule: mod }).tier === "none", "an empty system store is not an install");
    check(JSON.stringify(trustOptions()) === "{}", "…and a request site adds nothing");

    const { mod: blind } = runtime({ install: "absent" });
    check(installSystemTrust({ tlsModule: { getCACertificates: undefined } }).tier === "none", "a runtime with no getCACertificates at all is not an install");
    check(blind && typeof blind.setDefaultCACertificates === "undefined", "…and the fixture itself had no global API either");

    const { mod: throwing } = runtime({ throwsOn: "system" });
    const report = installSystemTrust({ tlsModule: throwing });
    check(report.tier === "none" && report.system === 0, "a store that throws while being read is treated as absent");
  }

  // ---- 5. the report is a sentence, and the sentence names the tier ----
  {
    const global = installSystemTrust({ tlsModule: runtime().mod });
    check(/^\[tls\] 2 system CAs .*\(4 total\).*globally/.test(describeTrust(global)), "the log line says how many roots and that they are global");
    const perRequest = installSystemTrust({ tlsModule: runtime({ install: "absent" }).mod });
    check(/handed per request/.test(describeTrust(perRequest)), "…or that they are handed per request, so a reader knows which tier ran");
    const none = installSystemTrust({ tlsModule: runtime({ system: [] }).mod });
    check(/no system certificate store found/.test(describeTrust(none)), "…or that this machine has no system store");
    check(/NODE_EXTRA_CA_CERTS/.test(describeTrust(none)), "…still naming the knob that adds to the bundled list");
    check(/has not run/.test(describeTrust(null)), "a process that never installed says exactly that");
  }

  // ---- 6. the install is the real runtime's, in the real runtime ----
  {
    const tls = require("tls");
    const report = installSystemTrust();
    const hasApi = typeof tls.setDefaultCACertificates === "function";
    const hasSystem = Array.isArray(tls.getCACertificates("system")) && tls.getCACertificates("system").length > 0;
    if (!hasSystem) {
      check(report.tier === "none", "this machine has no system store, so the real install is tier none");
    } else if (hasApi) {
      check(report.tier === "global", "the real runtime has the global API, so the real install is tier global");
      check(report.total >= report.bundled, "…and the merged list still carries every bundled root, plus the system ones");
    } else {
      check(report.tier === "request", "this runtime has no global API, so the real install is tier request");
    }
  }

  // ---- 7. verification is never turned off, in any file that can reach a socket ----
  //
  // The words themselves appear in these files — in the comments that say they
  // are never used — so the check runs on the CODE: comments stripped first.
  {
    const codeOf = (rel) =>
      fs
        .readFileSync(path.join(ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const rel of ["ui/system-ca.js", "ui/llm-client.js", "ui/llm-proxy.js"]) {
      const code = codeOf(rel);
      check(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(code), `${rel} never sets NODE_TLS_REJECT_UNAUTHORIZED`);
      check(!/rejectUnauthorized\s*:\s*false/.test(code), `${rel} never passes rejectUnauthorized:false`);
    }
    const src = codeOf("ui/system-ca.js");
    check(/"system"/.test(src) && /"default"/.test(src), "the module reads both stores by name");
    check(!/createSecureContext|checkServerIdentity|hostname/i.test(src), "it adds roots; it does not re-implement identity checking");
  }

  summary("system-ca", "all checks passed");
}

main();
