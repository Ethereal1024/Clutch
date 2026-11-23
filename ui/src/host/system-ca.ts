// The OS certificate store, adopted by the main process — the same roots the
// window already trusts.
//
// Two certificate stores matter here and they are not the same one. The
// renderer is Chromium: it verifies against the operating system's store, so a
// page in it reached the network through a proxy that inspects HTTPS without
// complaint. The main process is Node: it verifies against the CA list bundled
// with the runtime, which on a machine behind such a proxy is missing the
// proxy's root — so the same request that the page made fine was refused with
// "self signed certificate", and the run failed. That report is what this
// module answers: NOT by relaxing verification, but by trusting the extra roots
// the machine itself already trusts.
//
// What is never done, in any tier: NODE_TLS_REJECT_UNAUTHORIZED=0, or
// rejectUnauthorized:false at a request site. Those turn verification OFF and
// would accept any certificate at all, which is a different and much worse
// bargain than "the roots the OS trusts". Every path below only ever ADDS
// certificates to the set that is checked against.
//
// Two tiers, tried in order, because the API that makes this a one-line fix is
// not in every Node that ships this code:
//
//   1. global — tls.setDefaultCACertificates([...bundled, ...system]) (Node
//      >= 22.15 / >= 23.0). Verified on v22.23.1: it reaches https.request even
//      through an agent constructed BEFORE the call, it AUGMENTS rather than
//      replaces (installing a list of one certificate still left
//      api.deepseek.com verifying, so the bundled roots are never lost), and it
//      covers every outbound TLS in the process, not just the model call —
//      update downloads go through the same proxy.
//   2. request — when the runtime has no setDefaultCACertificates, the merged
//      list is kept and handed to the model requests as an explicit `ca`.
//      Callers spread trustOptions() into their options; it is empty in tier 1.
//      The merged list carries Node's bundled roots as well as the system ones,
//      so it is correct whether or not an explicit `ca` replaces the default.
//      Measured on v22.23.1 through a real CONNECT proxy with proxy-agent, the
//      agent this app actually uses: refused without `ca`, 200 with it, and the
//      same with an agent ProxyAgent had already cached — the option reaches the
//      tunneled TLS session, not just a direct connection.
//
// A third case is not a failure: a machine with no system store at all (tier
// "none") keeps Node's bundled list and the run behaves exactly as before this
// module existed.
//
// NODE_EXTRA_CA_CERTS keeps working in both tiers, for free: Node's extra
// certificates are already inside getCACertificates("default") (measured — with
// the variable set, "default" grew by one and contained that certificate), so a
// user who followed the message df202c2 prints is not asked to stop.
//
// Scope: the desktop main process. The Android host runs on libnode 18, which
// has none of this API — there it classifies as "none" and nothing changes.

const tls = require("tls");

type TrustTier = "global" | "request" | "none";

interface TrustReport {
  tier: TrustTier;
  bundled: number;
  system: number;
  total: number;
}

// The last answer, so trustOptions() at a request site does not re-read (or
// re-merge) the stores per request. "none" until installSystemTrust runs: a
// process that never installed trusts exactly what it always did.
let state: { tier: TrustTier; ca: string[] } = { tier: "none", ca: [] };
let report: TrustReport | null = null;

// One store from the runtime, or an empty list. Every failure here is a
// "nothing to add": a runtime without the API, a store the platform cannot
// read, a getter that throws (an unsupported kind) — none of them may take the
// app down at startup over a certificate that was optional to begin with.
function certsOf(mod: any, kind: string): string[] {
  if (!mod || typeof mod.getCACertificates !== "function") return [];
  try {
    const list = mod.getCACertificates(kind);
    if (!Array.isArray(list)) return [];
    return list.filter((c: any) => typeof c === "string" && c.indexOf("BEGIN CERTIFICATE") !== -1);
  } catch (e) {
    return [];
  }
}

// Bundled first, then whatever the system adds, one copy of each. Order is
// kept (bundled roots stay the ones a lookup finds first); the dedupe is by
// exact PEM because that is the only identity the API hands back — the two
// stores do overlap, and handing the same certificate in twice is pointless
// work for every handshake.
function mergeCerts(bundled: string[], system: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cert of bundled.concat(system)) {
    if (seen.has(cert)) continue;
    seen.add(cert);
    out.push(cert);
  }
  return out;
}

// Adopt the OS store. Idempotent, and safe to call before anything else runs:
// opts.tlsModule exists so a test can hand in a runtime with or without the
// global API instead of depending on which Node it happens to be on.
function installSystemTrust(opts: any = {}): TrustReport {
  const mod = opts.tlsModule || tls;
  const bundled = certsOf(mod, "default");
  const system = certsOf(mod, "system");
  const merged = mergeCerts(bundled, system);

  let tier: TrustTier = "none";
  if (system.length && merged.length) {
    if (typeof mod.setDefaultCACertificates === "function") {
      try {
        mod.setDefaultCACertificates(merged);
        tier = "global";
      } catch (e) {
        // a runtime that has the function but refuses this list: fall through
        // to the per-request tier rather than silently trusting nothing extra
        tier = "request";
      }
    } else {
      tier = "request";
    }
  }

  state = { tier, ca: tier === "none" ? [] : merged };
  report = { tier, bundled: bundled.length, system: system.length, total: merged.length };
  return report;
}

// What a request site spreads into its options: nothing in tier 1 (the global
// store already carries them) and nothing on a machine with no system store.
function trustOptions(): { ca?: string[] } {
  if (state.tier === "request" && state.ca.length) return { ca: state.ca };
  return {};
}

// One sentence for the tunnel log, so a run's log says which tier it got
// instead of leaving the next certificate error to be re-diagnosed from zero.
function describeTrust(r?: TrustReport | null): string {
  const rep = r === undefined ? report : r;
  if (!rep) return "[tls] system certificate store not adopted (installSystemTrust has not run)";
  if (rep.tier === "global") {
    return (
      `[tls] ${rep.system} system CAs merged beside Node's bundled ${rep.bundled} ` +
      `(${rep.total} total), installed globally: every https request in this process verifies against both`
    );
  }
  if (rep.tier === "request") {
    return (
      `[tls] ${rep.system} system CAs merged beside Node's bundled ${rep.bundled} ` +
      `(${rep.total} total), handed per request: this runtime has no tls.setDefaultCACertificates`
    );
  }
  return "[tls] no system certificate store found: Node's bundled CAs only (NODE_EXTRA_CA_CERTS still adds to them)";
}

module.exports = {
  installSystemTrust,
  trustOptions,
  describeTrust,
};
