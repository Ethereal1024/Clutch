// GENERATED FILE — do not edit; edit src/host/run-session.ts and run `npm run build:host`.
// source sha256: 3a4c3bd6dc1875cd257efc4ccfb7dfeef444360a7fb7eba0b9136b3e9d76419f

// Composition root for one session's run loop (P3-2 wiring).
//
// The loop (ui/run-host.js) needs six ports: log, llm, tools, session,
// contextWindowBytes and limits. All six are now concrete: the log lives at the
// session's HTTP (ui/log-client.js), the model speaks one of two OpenAI wire
// protocols (ui/llm-client.js), the tools are read from the session's
// declarations (ui/tool-decl.js), and the session facts — including the numbers
// its loop must end a turn with — come from GET /api/session. This file is the
// ONE place that fetches those two endpoints and wires everything together.
//
//   createSessionRun({
//     base,            session base URL (http://127.0.0.1:<port>)
//     mode?,           "work" | "chat" — overrides the session's own mode when
//                      provided (for tests that do not start a real session)
//     project?,        the .clc path the caller believes it is running in. The
//                      session has ONE open project and the loop appends to it,
//                      so this is a claim to be CHECKED, not a destination: a
//                      mismatch is refused (code "project_mismatch") instead of
//                      writing this turn into another window's log.
//     onEvent?(event), forwarded to createRunHost as-is
//     warn?(msg),      forwarded to createRunHost and createTools as-is
//     onBusy?(busy),   "a turn is being driven on THIS device right now" — the
//                      native wake-lock signal (P5-2). Called true when the first
//                      entry point starts and false when the last one returns; a
//                      marker written from it is what the phone's foreground
//                      service polls, because the desktop has no such service and
//                      passes nothing.
//   }) -> Promise<{start, stop, step, drive, state}>
//
// Construction is async because it must fetch the two session endpoints before
// it can build the tools and LLM client. The returned object is createRunHost's
// own answer — there is one state machine and no second vocabulary — plus the
// LEASE on the session's run slot (P2-3): every entry point claims it before
// working and gives it back when the log holds no open turn, so /api/health, the
// status frame a reconnecting window is handed, and the project-switch gates all
// see the host's turn. See the block above the `return`.
//
// Desktop (ui/main.js) and Android (android/host/android-host.js) wire the
// same function to their respective `run:*` handlers. A test can drive it
// against a fake HTTP server that serves the two endpoints.
//
// LLM credentials come from ui/llm-proxy.js (getUpstream/getApiKey/
// readSettingsFile) — the same source the proxy itself reads, so a settings
// save is honored immediately on the next run.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { createRunHost } = require("./run-host");
const { createLogClient } = require("./log-client");
const { createToolClient } = require("./tool-client");
const { createTools } = require("./tool-decl");
const { createLlmClient } = require("./llm-client");
const { getUpstream, getApiKey } = require("./llm-proxy");
// readSettingsFile is not a named export of llm-proxy.js but we need it for
// model / api_protocol / reasoning_effort. Require it from settings-mirror,
// which is the shared settings reader on both desktop and Android.
const { readSettings } = require("./settings-mirror");
// One JSON GET from the session — no body, plain fetch with a timeout.
const FETCH_TIMEOUT_MS = 30_000;
async function fetchJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let r;
    let text;
    try {
        r = await fetch(url, { signal: ctl.signal });
        text = await r.text();
    }
    catch (e) {
        if (ctl.signal.aborted)
            throw new Error(`GET ${url}: no answer within ${FETCH_TIMEOUT_MS}ms`);
        throw e;
    }
    finally {
        clearTimeout(timer);
    }
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    }
    catch (e) {
        throw new Error(`GET ${url}: response is not JSON (${r.status})`);
    }
    if (!r.ok) {
        const why = (parsed && parsed.error) || `${r.status} ${r.statusText}`;
        const err = new Error(`GET ${url} answered ${r.status}: ${why}`);
        err.status = r.status;
        throw err;
    }
    return parsed;
}
function sessionBase(base) {
    if (typeof base !== "string" || !base.trim()) {
        throw new TypeError("run-session: base is required (http://127.0.0.1:<port>)");
    }
    return base.replace(/\/+$/, "");
}
/**
 * @param {{ base?: string, mode?: string, project?: string, onEvent?: (ev: any) => void, warn?: (msg: string) => void, onBusy?: (busy: boolean) => void }} [opts]
 */
async function createSessionRun({ base, mode: modeOverride, project, onEvent, warn, onBusy, } = {}) {
    const root = sessionBase(base);
    // Fetch the two session endpoints in parallel — both are cheap GETs that
    // answer in milliseconds on loopback; nothing in the loop can proceed until
    // both arrive.
    const [declsData, sessionData] = await Promise.all([
        fetchJson(`${root}/api/declarations`),
        fetchJson(`${root}/api/session`),
    ]);
    // Validate the session response — these are the six keys the loop's ports
    // need; a missing contextWindowBytes is a session that cannot be driven safely.
    if (!sessionData || typeof sessionData !== "object") {
        throw new TypeError("run-session: GET /api/session must answer an object");
    }
    const { mode, shell, components, contextWindowBytes, memory } = sessionData;
    if (typeof contextWindowBytes !== "number" || !Number.isFinite(contextWindowBytes) || contextWindowBytes <= 0) {
        throw new TypeError("run-session: GET /api/session must answer a positive contextWindowBytes");
    }
    // The session's termination numbers (`limits`, agent/api/session.py): the turn
    // budget and the doom-loop guard used to be the backend loop's checks, and the
    // loop is this half's now (P4-3), so the work happens where the turns are
    // taken. The wire speaks the config's own snake_case names; the loop speaks
    // camelCase, and this is the one place that translates. A session that serves
    // no `limits` imposes none (both off), which is what a build older than the key
    // means; a value of the wrong type is "absent", like every other tolerant
    // default in this file.
    const rawLimits = sessionData.limits && typeof sessionData.limits === "object" ? sessionData.limits : null;
    const limits = rawLimits
        ? {
            maxTurns: Number.isInteger(rawLimits.max_turns) ? rawLimits.max_turns : 0,
            doomLoopLimit: Number.isInteger(rawLimits.doom_loop_limit) ? rawLimits.doom_loop_limit : 0,
            abortOnDoomLoop: Boolean(rawLimits.abort_on_doom_loop),
        }
        : undefined;
    // Which .clc this loop would actually append to. The session has ONE open
    // project and every port addresses it implicitly (`GET/POST /api/log`, the
    // execution endpoint) — there is no path in an append. So a caller that names
    // a project makes a claim to be checked, not a destination to honor: with two
    // windows on two projects sharing one session, a run that quietly landed in
    // the other one's .clc would paint a stranger's transcript into this page.
    // memory.path IS that open project (agent/api/session.py); null means none is
    // open, which is a refusal too — there is nowhere to append.
    if (typeof project === "string" && project) {
        const openProject = memory && typeof memory.path === "string" ? memory.path : null;
        if (openProject !== project) {
            const why = openProject === null
                ? `the session has no project open, but this run names ${project}`
                : `this session has ${openProject} open, not ${project}`;
            const err = new Error(`run-session: ${why}`);
            err.code = "project_mismatch";
            throw err;
        }
    }
    // mode: caller override wins (allows chat sessions from the same endpoint),
    // otherwise trust the session.
    const resolvedMode = typeof modeOverride === "string" ? modeOverride : (typeof mode === "string" ? mode : "work");
    // Tool surface: the declarations data, the session mode, and the log's open
    // state (whether a project is open) all feed createTools. The session's own
    // `project` flag is encoded in the declarations response.
    const tools = createTools({
        declarations: Array.isArray(declsData.declarations) ? declsData.declarations : [],
        available: declsData.available && typeof declsData.available === "object" ? declsData.available : {},
        config: declsData.config && typeof declsData.config === "object" ? declsData.config : {},
        backends: Array.isArray(declsData.backends) ? declsData.backends : [],
        facts: declsData.facts && typeof declsData.facts === "object" ? declsData.facts : {},
        host: declsData.host && typeof declsData.host === "object" ? declsData.host : {},
        project: Boolean(declsData.project),
        mode: resolvedMode,
        warn: typeof warn === "function" ? warn : undefined,
    });
    // LLM client: credentials from the local settings file — the same source the
    // proxy reads — so a settings save is honored on the next run without restarting.
    const settings = readSettings();
    const llm = createLlmClient({
        baseUrl: getUpstream(),
        apiKey: getApiKey(),
        model: settings.model || "",
        protocol: settings.api_protocol || "chat",
        reasoningEffort: settings.reasoning_effort || undefined,
    });
    // Log and tool clients: one base URL, the mode from the resolved session.
    const logClient = createLogClient({ base: root });
    const toolClient = createToolClient({ base: root, mode: resolvedMode });
    // createRunHost is synchronous; all async work is above.
    const loop = createRunHost({
        log: logClient,
        llm,
        tools: {
            schemas: () => tools.schemas(),
            ui: (name) => tools.ui(name),
            pathArg: (name) => tools.pathArg(name),
            run: ({ call, signal }) => toolClient.run({ call, signal }),
        },
        session: {
            mode: resolvedMode,
            components: typeof components === "string" ? components : "",
            shell: typeof shell === "string" ? shell : "",
            memory: memory || null,
        },
        contextWindowBytes,
        limits,
        onEvent,
        warn: typeof warn === "function" ? warn : undefined,
    });
    // ---- the lease on the run slot (P2-3) --------------------------------------
    //
    // The loop lives here now, so "a run is in flight" has to be said from here.
    // Every other reader on the session side asks that one flag — /api/health's
    // in_flight (what the supervisor's reaping and the ready-check read), the
    // status frame a window gets when it reconnects, the project-switch gates,
    // the rollback gate, and the release handler's "write this run a final".
    // Until this existed only the retired backend loop (POST /api/run) wrote it,
    // so a window reconnecting mid-turn was told "idle" and a session could be
    // reaped under a live turn (TODO.md P2-3).
    //
    // It is a LEASE, not a latch. We renew it every HEARTBEAT_MS while a turn is
    // open, and a host that dies — kill -9, an OS reclaiming a phone, a tunnel cut
    // mid-turn — cannot renew, so the claim expires instead of locking the
    // session's project forever. The deadline is six heartbeats long on purpose:
    // the two wrong answers do not cost the same. A wrong "busy" delays a project
    // switch; a wrong "idle" paints a live run idle and can have the session
    // reaped under the turn that is using its .clc.
    //
    // A claim is AWAITED: "another driver holds this turn" (409 run_active) has to
    // stop this loop before it writes anything, or two drivers write one turn
    // twice. Everything else about the lease is bookkeeping and never refuses the
    // work: a session build without the endpoint (404) is remembered and never
    // asked again, and a transport failure is warned once — the turn can run, the
    // session will just report the wrong status until the next claim.
    const LEASE_MS = 120_000;
    const HEARTBEAT_MS = 20_000;
    const LEASE_TIMEOUT_MS = 10_000;
    const leaseProject = typeof project === "string" && project ? project : undefined;
    const say = typeof warn === "function" ? warn : () => { };
    let leaseHeld = false;
    let leaseTimer = null;
    let leaseUnsupported = false; // the session has no /api/run/state (older build)
    let leaseWarned = false; // one warning per loss, not one per heartbeat
    async function leasePost(busy) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), LEASE_TIMEOUT_MS);
        let r;
        let text;
        try {
            r = await fetch(`${root}/api/run/state`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    busy,
                    ...(leaseProject ? { project: leaseProject } : {}),
                    ttl_ms: LEASE_MS,
                }),
                signal: ctl.signal,
            });
            text = await r.text();
        }
        catch (e) {
            if (ctl.signal.aborted) {
                throw new Error(`POST /api/run/state: no answer within ${LEASE_TIMEOUT_MS}ms`);
            }
            throw e;
        }
        finally {
            clearTimeout(timer);
        }
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch (e) {
            parsed = {};
        }
        if (r.ok)
            return parsed;
        const err = new Error(`POST /api/run/state answered ${r.status}: ${(parsed && parsed.error) || r.statusText}`);
        err.status = r.status;
        err.code = (parsed && parsed.code) || null;
        // a refusal about somebody ELSE carries their own statement about themselves
        // (pid, session, since): the page names them, and knows which session's run
        // to wait for
        err.owner = (parsed && parsed.owner) || null;
        throw err;
    }
    // A lease that could not be renewed or released is not the turn's failure: it
    // only means the session's status may be stale. Said ONCE per loss, and never
    // thrown from a timer — a dead session must not fill the log every 20 s.
    function leaseTrouble(e) {
        if (leaseUnsupported)
            return;
        if (e && e.status === 404) {
            leaseUnsupported = true;
            say(`the session has no run-state endpoint (older build): ${e.message}`);
            return;
        }
        if (leaseWarned)
            return;
        leaseWarned = true;
        say(`run state not reported (${e && e.message ? e.message : e})`);
    }
    function heartbeat() {
        if (leaseTimer)
            return;
        leaseTimer = setInterval(() => {
            leasePost(true).catch((e) => leaseTrouble(e));
        }, HEARTBEAT_MS);
        // the heartbeat must not be a reason for the host process to stay alive
        if (typeof leaseTimer.unref === "function")
            leaseTimer.unref();
    }
    // Claim the run (or renew the claim we already hold). Throws only when the RUN
    // is somebody else's — the one answer the work must not ignore. That refusal
    // is `run_elsewhere`, never `run_active`: `run_active` already means "this
    // window is driving this turn" (ui/src/host/main.ts refuseIfDriving), which
    // the page treats as a fact and stays on, while this one is another window's
    // run on the same .clc, which the page must show as read-only instead.
    async function hold() {
        if (leaseUnsupported)
            return;
        let answer;
        try {
            answer = await leasePost(true);
        }
        catch (e) {
            if (e && e.code === "run_active") {
                const err = new Error("another window is running this project");
                err.status = e.status;
                err.code = "run_elsewhere";
                err.owner = e.owner || null;
                throw err;
            }
            leaseTrouble(e);
            return;
        }
        if (answer && answer.busy === false) {
            // a claim that answers "not busy" is not a claim: a session build that
            // accepts the request but does not know the field is not one we can lean on
            leaseTrouble(new Error("the session did not take the claim"));
            return;
        }
        leaseHeld = true;
        leaseWarned = false;
        heartbeat();
    }
    // Give the slot back. Always safe to call: Stop can arrive twice, a step can
    // fail after the lease already expired, and the session answers the release
    // with "I was not holding it" rather than an error.
    function release() {
        const held = leaseHeld;
        leaseHeld = false;
        if (leaseTimer) {
            clearInterval(leaseTimer);
            leaseTimer = null;
        }
        if (leaseUnsupported)
            return Promise.resolve();
        return leasePost(false).then((answer) => {
            if (held && answer && answer.released === false) {
                // our claim was gone before we released it: it expired, or another
                // driver took the slot while this turn was still writing to the log
                say("the run slot was no longer ours when the turn ended (the lease expired or another driver took it)");
            }
        }, (e) => leaseTrouble(e));
    }
    // Does the log still hold an open turn? Open keeps the lease and the
    // heartbeat; closed (a final was written, Stop was flushed, or there was
    // nothing to drive) gives it back. Asking the LOG rather than trusting this
    // file's own memory is the same rule the loop follows (TODO.md I6).
    async function settle() {
        let phase = null;
        try {
            const st = await loop.state();
            phase = st && typeof st.phase === "string" ? st.phase : null;
        }
        catch (e) {
            // a log we cannot read is not proof the turn ended: keep the claim and let
            // it expire if this really was the end
            heartbeat();
            return;
        }
        if (phase === "idle") {
            await release();
            return;
        }
        heartbeat();
    }
    // A rejected entry point is not always the end of the turn. `run_active` is
    // the exception that matters: it means this window's OTHER wheel is already
    // driving the same turn (the Stop flush that arrives before the drive under it
    // unwinds — ui/src/host/main.ts stopAndFlush), and releasing here took the
    // claim away from that wheel while it was still writing its `aborted` final.
    // The append then answered 409 `not_running` (agent/api/base.py) and the page
    // painted the server's refusal as "run failed: POST …/api/log answered 409".
    // So that one case asks the LOG instead (settle): open keeps the claim, idle
    // gives it back. Every other failure gives the slot back at once — a start on
    // an already open turn, or a session that went away, wrote nothing and must
    // not leave the session reporting busy (section 19 of tests/run-session).
    async function settleFailure(e) {
        if (e && e.code === "run_active")
            await settle();
        else
            await release();
    }
    // "A turn is being driven on this device right now" (P5-2). Not the same fact
    // as the lease: the lease also stays held between two page calls while the turn
    // is open (settle keeps the heartbeat), and a phone must not keep its CPU awake
    // for a turn nobody is stepping. What the wake lock may follow is work that is
    // actually pending, so this counts the entry points themselves: true when the
    // first one enters, false when the last one returns. A counter, not a boolean,
    // because Stop's flush can arrive while a drive is still unwinding — the outer
    // call must not clear a marker the inner one still needs.
    let inflight = 0;
    function noteBusy(delta) {
        const was = inflight > 0;
        inflight += delta;
        const now = inflight > 0;
        if (was === now)
            return;
        if (typeof onBusy !== "function")
            return;
        try {
            onBusy(now);
        }
        catch (e) {
            // the marker is a courtesy to a native service, never the turn's business
            say(`could not report ${now ? "busy" : "idle"}: ${(e && e.message) || e}`);
        }
    }
    async function start(task) {
        noteBusy(1);
        try {
            await hold();
            try {
                const out = await loop.start(task);
                await settle();
                return out;
            }
            catch (e) {
                await settleFailure(e); // run_active keeps the claim: the other wheel is still writing
                throw e;
            }
        }
        finally {
            noteBusy(-1);
        }
    }
    async function step() {
        noteBusy(1);
        try {
            await hold();
            try {
                const out = await loop.step();
                await settle();
                return out;
            }
            catch (e) {
                await settleFailure(e); // run_active keeps the claim: the other wheel is still writing
                throw e;
            }
        }
        finally {
            noteBusy(-1);
        }
    }
    async function drive() {
        noteBusy(1);
        try {
            await hold();
            try {
                const out = await loop.drive();
                await settle();
                return out;
            }
            catch (e) {
                await settleFailure(e); // run_active keeps the claim: the other wheel is still writing
                throw e;
            }
        }
        finally {
            noteBusy(-1);
        }
    }
    async function run(task) {
        noteBusy(1);
        try {
            await hold();
            try {
                const out = await loop.run(task);
                await settle();
                return out;
            }
            catch (e) {
                await settleFailure(e); // run_active keeps the claim: the other wheel is still writing
                throw e;
            }
        }
        finally {
            noteBusy(-1);
        }
    }
    // Stop stays SYNCHRONOUS: ui/main.js's stopAndFlush() calls it and then steps,
    // which is where the aborted final is written and settle() sees idle — but
    // only when no drive of this instance is in flight. With one in flight, that
    // wheel writes the final itself and the flush must not drive again
    // (ui/src/host/main.ts stopAndFlush, `driving`). A stop that never gets that
    // step leaves the turn open on disk and lets the lease expire by itself — the
    // honest picture either way.
    function stop() {
        loop.stop();
    }
    async function state() {
        return loop.state();
    }
    return { start, stop, step, drive, run, state };
}
// The LLM facts a run instance is BUILT from. A settings save must reach the
// next turn of an existing tab, so callers compare this before reusing a cached
// instance; the key is part of the fingerprint but never logged.
function llmSettingsRev() {
    const s = readSettings() || {};
    return JSON.stringify({
        upstream: getUpstream(),
        key: getApiKey(),
        model: s.model || "",
        protocol: s.api_protocol || "",
        effort: s.reasoning_effort || "",
    });
}
module.exports = { createSessionRun, FETCH_TIMEOUT_MS, llmSettingsRev };
