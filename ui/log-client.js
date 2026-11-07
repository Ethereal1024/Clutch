// GENERATED FILE — do not edit; edit src/host/log-client.ts and run `npm run build:host`.
// source sha256: 5c18748e1ba0a3d5650ec273ec0ea9d334defc8222fe76698227c21486933070

// The session machine's .clc, seen from here: ui/run.js's log ports over HTTP (P2).
//
// The loop and the compactor (ui/run.js, ui/compaction.js) speak one vocabulary:
//
//   read()             -> {items, windowBytes, cprStart, lastCompaction}
//   append(event)      -> the event AS PERSISTED (it carries `log_offset`)
//   slideWindow(off)   -> persist a new window start (a header write)
//
// The execution layer's endpoints (agent/api/log.py) answer the same three
// facts in the wire's own shape. This file is the ONE place the two shapes meet,
// and it adds exactly one thing: `POST /api/log` answers `{offset, event}` —
// the stamp BESIDE the record, because the record's fields are the line on disk
// and the offset is where that line starts — while the loop wants the stamp ON
// the record (`written.log_offset`, which is what compaction slides to). Folding
// it here keeps the .clc's own shape untouched and the loop free of the wire.
//
// Nothing is cached and nothing is retried. A read is the log as it is right
// now (the loop re-reads every step: a cached copy would be a second truth whose
// tail a `kill -9` loses, TODO.md I6), and a failed read is an ERROR, never an
// empty log — an empty log reads as "the turn finished", which is the one wrong
// answer a lost connection could produce (I3: no degradation).
//
// The session is 127.0.0.1 on both sides of the SSH tunnel, so these calls keep
// the plain global fetch (ui/net-fetch.js says so); a proxy belongs to the
// machine, and a hop to our own loopback is not one.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// A read is the resident window (up to the model's context), a few hundred KB at
// worst, over loopback or a tunnel. Long enough for a bad link, short enough that
// a dead session does not hang a turn forever.
const LOG_TIMEOUT_MS = 60_000;
/**
 * The session's base URL, normalized. `unknown` in, `string` out: this IS the
 * validator (it throws on a non-URL), so the gate can type the callers' option
 * bags as optional without a cast at every call site.
 * @param {unknown} base
 * @returns {string}
 */
function sessionBase(base) {
    if (typeof base !== "string" || !base.trim()) {
        throw new TypeError("log-client: base is required (http://127.0.0.1:<port>)");
    }
    return base.replace(/\/+$/, "");
}
/**
 * One JSON call to the session, with the host's own sentence on a refusal.
 * Every endpoint here answers `{error: …}` (with an optional `code`) when it
 * refuses; that sentence is what the caller shows, and a bare status code would
 * leave the host guessing which refusal it got.
 *
 * @param {string} url
 * @param {{ method: string, body?: unknown, timeoutMs: number }} opts
 * @returns {Promise<any>} the parsed answer (the endpoints' own shapes are
 *   checked by each port below, where the port's contract lives)
 */
async function call(url, { method, body, timeoutMs }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    let text;
    try {
        r = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctl.signal,
        });
        text = await r.text();
    }
    catch (e) {
        if (ctl.signal.aborted) {
            throw new Error(`${method} ${url}: no answer within ${timeoutMs}ms`);
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
        /* a non-JSON answer is reported as the status below */
    }
    if (!r.ok) {
        const why = (parsed && parsed.error) || `${r.status} ${r.statusText}`;
        // the refusal's two machine-readable facts ride ON the Error: `status` is
        // always there, `code` only when the session named one ("read_only",
        // "not_durable", "project_open_conflict"). Annotated rather than classed so
        // the caller's `e.status` / `e.code` is checked instead of guessed.
        const err = new Error(`${method} ${url} answered ${r.status}: ${why}`);
        err.status = r.status;
        if (parsed && parsed.code)
            err.code = parsed.code;
        throw err;
    }
    return parsed;
}
/**
 * The loop's three ports, over that.
 */
function createLogClient({ base, timeoutMs = LOG_TIMEOUT_MS } = {}) {
    const root = sessionBase(base);
    return {
        async read() {
            const body = await call(`${root}/api/log`, { method: "GET", timeoutMs });
            if (!Array.isArray(body.items) || typeof body.windowBytes !== "number" || typeof body.cprStart !== "number") {
                throw new TypeError("log-client: GET /api/log must answer {items, windowBytes, cprStart, lastCompaction}");
            }
            return body;
        },
        async append(event) {
            if (!event || typeof event !== "object" || typeof event.type !== "string") {
                throw new TypeError("log-client: append needs an event with a type");
            }
            const body = await call(`${root}/api/log`, { method: "POST", body: { event }, timeoutMs });
            if (!body.event || typeof body.event !== "object" || typeof body.offset !== "number") {
                throw new TypeError("log-client: POST /api/log must answer {offset, event}");
            }
            return { ...body.event, log_offset: body.offset };
        },
        async slideWindow(offset) {
            if (typeof offset !== "number" || !Number.isFinite(offset)) {
                throw new TypeError("log-client: slideWindow needs a byte offset");
            }
            const body = await call(`${root}/api/log/window`, { method: "POST", body: { offset }, timeoutMs });
            if (typeof body.cprStart !== "number" || typeof body.windowBytes !== "number") {
                throw new TypeError("log-client: POST /api/log/window must answer {cprStart, windowBytes}");
            }
            return body;
        },
    };
}
module.exports = { createLogClient, LOG_TIMEOUT_MS };
