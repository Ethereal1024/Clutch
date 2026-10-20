// The one transport this plugin has: the client's exec bridge.
//
// While an ssh tunnel is up, the app process listens on a loopback port and runs
// whatever command it is handed on the far side of that tunnel
// (ui/exec-bridge.js: POST /exec -> remoteExec). That address reaches this
// plugin as CLUTCH_EXEC_BRIDGE, set by ui/plugin-host.js at every call
// (SSH_WORKSPACE_PLAN.md C9.1), and an empty value means "there is no tunnel
// right now" — a fact to answer with, not a port to guess at.
//
// What that means, stated where the code lives: holding this address is holding
// an arbitrary shell on the other machine. This plugin is trusted code the user
// installed (ui/plugin-child.js: the child has the app uid), so nothing here is
// a new privilege — but nothing here pretends to be a fence either.

"use strict";

const http = require("http");

// Named in lib/settings.js so every environment name this plugin reads is in one
// place; re-exported here for the modules that only speak HTTP.
const { BRIDGE_ENV, TIMEOUT_ENV } = require("./settings");

const DEFAULT_TIMEOUT_MS = 20000; // under the client's 30 s per-call kill (ui/plugin-host.js)
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function bridgeAddress() {
  return String(process.env[BRIDGE_ENV] || "").trim();
}

function timeoutMs() {
  const number = Number(process.env[TIMEOUT_ENV]);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : DEFAULT_TIMEOUT_MS;
}

// One POST, one JSON answer. Refusals are throws: they are this side's trouble
// (no bridge, a bridge that died, an address that is not one) and index.js turns
// them into the model-facing sentence.
function post(address, body, limit) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(address);
    } catch (e) {
      reject(new Error(`the exec bridge address is not a URL: ${JSON.stringify(address)}`));
      return;
    }
    // The bridge is the app's own loopback listener. An address that names a
    // host is either a stale value or someone pointing this plugin elsewhere;
    // neither is something to POST a shell command to.
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
      reject(new Error(`the exec bridge must be a loopback http address, got ${JSON.stringify(address)}`));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || 80,
        path: "/exec",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch (e) {
            parsed = null;
          }
          if (response.statusCode !== 200) {
            const why = (parsed && (parsed.error || parsed.content)) || `HTTP ${response.statusCode}`;
            reject(
              new Error(
                response.statusCode === 503
                  ? `the tunnel is not connected right now (${why})`
                  : `the exec bridge refused the command: ${why}`
              )
            );
            return;
          }
          if (!parsed || typeof parsed !== "object") {
            reject(new Error("the exec bridge answered with something that is not JSON"));
            return;
          }
          resolve(parsed);
        });
        response.on("error", (e) => reject(new Error(`the exec bridge answer broke off: ${e.message}`)));
      }
    );
    request.setTimeout(limit, () => {
      request.destroy(new Error(`the exec bridge did not answer within ${limit} ms`));
    });
    request.on("error", (e) => reject(new Error(`the exec bridge is unreachable (${address}): ${e.message}`)));
    request.end(payload);
  });
}

// Run ONE command on the far side. Answer shape: {code, stdout, stderr}
// (ui/exec-bridge.js). `code === -1` is the bridge's own timeout, not a verdict
// of the command — index.js reports it as one because a half-finished write is
// not something to parse an envelope out of.
async function runCommand(address, command, limit) {
  const answer = await post(address, { command, timeout: limit }, limit + 5000);
  if (typeof answer.code !== "number") {
    throw new Error("the exec bridge answered without an exit code");
  }
  if (answer.stdout_b64) {
    return { code: answer.code, stdout: Buffer.from(answer.stdout_b64, "base64").toString("utf8"), stderr: String(answer.stderr || "") };
  }
  return { code: answer.code, stdout: String(answer.stdout || ""), stderr: String(answer.stderr || "") };
}

module.exports = { bridgeAddress, runCommand, timeoutMs, DEFAULT_TIMEOUT_MS };
