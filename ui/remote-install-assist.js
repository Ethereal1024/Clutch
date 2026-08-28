// Client-side LLM-guided remote installer (the "skill" escape hatch).
//
// Runs entirely on the client: the model talks to the client's LLM proxy and its
// only tool is executing a shell command on the remote over the live SSH tunnel.
// Used when the deterministic bootstrap (bundle / pylibs / pip) can't decide,
// i.e. exotic environments: it can install python3 via any package manager,
// build a venv, pip-install the staged source, start the server, and iterate on
// errors. Bounded iterations; the server is verified before returning.

const http = require("http");

const MAX_STEPS = 30;

function parseAction(reply) {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]);
    return { command: o.command, done: Boolean(o.done), message: o.message };
  } catch (e) {
    return {};
  }
}

function llmTurn(llmUrl, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "deepseek-chat", messages });
    const req = http.request(
      llmUrl + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b).choices[0].message.content || "");
          } catch (e) {
            reject(new Error("bad LLM response: " + b.slice(0, 200)));
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function verify(remoteExec) {
  for (const probe of [
    `python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8890/api/health',timeout=3).read())"`,
    `curl -s --max-time 3 http://127.0.0.1:8890/api/health`,
    `wget -qO- --timeout=3 http://127.0.0.1:8890/api/health`,
  ]) {
    const r = await remoteExec(probe, 10000);
    if (r.code === 0 && r.stdout.includes("ok")) return true;
  }
  return false;
}

async function runInstallAssist({ remoteExec, llmUrl, probe }) {
  const sys =
    "You are a remote-install engineer. The client wants the 'clutch agent server' " +
    "running on a remote host reachable over SSH. You can ONLY run shell commands " +
    "on that remote (your single tool). Reply with STRICT JSON, no prose: " +
    '{"command":"<one shell command>"} for the next command, or {"done":true} when the server is up.\n' +
    "Goal: get the server running, bound to 127.0.0.1:8890, launched detached with " +
    "`nohup setsid ... >/tmp/clutch-server.log 2>&1 &`, with these args: " +
    "--base-url http://127.0.0.1:8892/v1 --port 8890. " +
    "The reverse SSH tunnel already maps remote 127.0.0.1:8892 to the client's LLM " +
    "proxy, so the server needs NO internet and NO API key of its own. " +
    "Success is: `http://127.0.0.1:8890/api/health` answers {\"ok\":true}.\n" +
    "The agent source tree is already staged at ~/.clutch-server/staged/src " +
    "(contains agent/ and pyproject.toml). Install python3 if missing (apt/opkg/yum/dnf), " +
    "create a venv, `pip install ~/.clutch-server/staged/src`, and start it. " +
    "Adapt to the environment; read errors and fix them. When you believe it is up, " +
    'reply {"done":true}.\n\n' +
    "Remote environment:\n" +
    JSON.stringify(probe, null, 1);

  const msgs = [
    { role: "system", content: sys },
    { role: "user", content: "Begin. Reply with your first action." },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    let reply;
    try {
      reply = await llmTurn(llmUrl, msgs);
    } catch (e) {
      return { ok: false, error: "assist LLM call failed: " + e.message };
    }
    const action = parseAction(reply);
    if (action.done) {
      return (await verify(remoteExec))
        ? { ok: true }
        : { ok: false, error: "assist finished but the server is not up" };
    }
    if (!action.command) {
      msgs.push({ role: "user", content: "Invalid reply (not an action JSON). Reply {\"command\":\"...\"} or {\"done\":true}." });
      continue;
    }
    let r;
    try {
      r = await remoteExec(action.command, 120000);
    } catch (e) {
      return { ok: false, error: "remote command failed: " + e.message };
    }
    msgs.push({ role: "assistant", content: reply });
    msgs.push({
      role: "user",
      content:
        `Command: ${action.command}\nexit=${r.code}\nSTDOUT:\n${r.stdout.slice(-3000)}\n` +
        `STDERR:\n${r.stderr.slice(-2000)}\nReply with the next action or {"done":true}.`,
    });
  }
  return { ok: false, error: "assist hit the step limit without success" };
}

module.exports = { runInstallAssist };
