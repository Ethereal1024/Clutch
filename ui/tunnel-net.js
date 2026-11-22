// GENERATED FILE — do not edit; edit src/host/tunnel-net.ts and run `npm run build:host`.
// source sha256: 784568b10c949bb48e000a5b4a8ac9a271de01aaa4f4d7f40ee6d4905d473722

"use strict";
// loopback plumbing — free ports, listening sockets, health polls
//
// Everything here talks to 127.0.0.1 only. It is the client end of the
// tunnel, not the ssh client: a free port for the forward, a socket to
// listen on it, and the polls that decide whether what answers on a port is
// a Clutch supervisor, a legacy shared server, or nothing at all. The
// connect flow is the only caller, and it never looks inside.
Object.defineProperty(exports, "__esModule", { value: true });
const http = require("http");
const net = require("net");
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}
function listen(srv, port) {
    return new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", () => {
            srv.removeListener("error", reject);
            resolve();
        });
    });
}
// The health poll, and — just as important — WHICH "no" it got. "Nothing
// answers" has three shapes on this wire and they call for three different
// answers: a REFUSAL is a local port nobody listens on (the forward is gone:
// re-open it now), a TIMEOUT is a listener that took the connection and never
// answered (a slow or blocked wire: a question, worth one patient re-ask), and
// running out of budget is the deadline. A caller that only gets a boolean has
// to treat the first and the second the same way, which is how a healer that
// could not hear an answer over a lossy link closed a listener that live
// streams were speaking through.
//
// `requestMs` is how long ONE attempt may take before it is abandoned. It
// defaults to the tight 2 s of a cold connect and is raised by the healer: a
// single lost retransmission on a mobile link outlives 2 s, and the answer that
// arrives at 2.4 s is the far side being fine.
//
//   "ok"       it answered
//   "refused"  the connection was refused: no listener on the local port
//   "timeout"  accepted and never answered before `requestMs`
//   "closed"   the attempt failed another way (a reset, a torn pipe, no route)
//   "deadline" the budget ran out before any of the above settled the question
function probeServer(url, timeoutMs, requestMs = 2000) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        let kind = "deadline";
        let settled = false;
        const finish = (up) => {
            if (settled)
                return;
            settled = true;
            resolve({ up, kind: up ? "ok" : kind });
        };
        const tick = () => {
            if (settled)
                return;
            if (Date.now() > deadline)
                return finish(false);
            let answered = false;
            const req = http.get(url, (res) => {
                answered = true;
                res.resume();
                finish(true);
            });
            req.on("error", (e) => {
                if (answered || settled)
                    return;
                // a destroyed request reports a reset; the reason was the clock above
                if (kind !== "timeout")
                    kind = e && e.code === "ECONNREFUSED" ? "refused" : "closed";
                if (Date.now() > deadline)
                    return finish(false);
                setTimeout(tick, 500);
            });
            req.setTimeout(requestMs, () => {
                kind = "timeout";
                req.destroy();
            });
        };
        tick();
    });
}
function waitForServer(url, timeoutMs, requestMs = 2000) {
    return probeServer(url, timeoutMs, requestMs).then((r) => r.up);
}
function httpGetBody(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    });
}
// Supervisor: {"status":"ok"} → "up"; legacy shared server → "foreign"; dead port → "down"
async function probeSupervisorShape(base) {
    try {
        const body = await httpGetBody(base + "/api/health", 3000);
        return String(body).includes('"status"') ? "up" : "foreign";
    }
    catch {
        return "down";
    }
}
module.exports = {
    freePort,
    listen,
    waitForServer,
    probeServer,
    probeSupervisorShape,
};
