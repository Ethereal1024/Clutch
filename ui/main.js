// Electron shell for the decoupled Clutch UI.
//
// The shell holds no agent logic and does NOT spawn the backend: it loads the
// local static frontend and talks to a separately-running clutch-server over
// HTTP. Two ways to reach a backend:
//   - local / direct: CLUTCH_API_URL or the default http://127.0.0.1:8890
//   - remote over SSH: spawn a system `ssh` tunnel (-L for the API, -R for the
//     client-side LLM proxy) so the remote backend needs no internet or key.
//
// The embedded LLM proxy is a transparent reverse proxy: it injects the client's
// API key and streams the upstream response (SSE, tools, reasoning_content)
// byte-for-byte. The remote server points --base-url at http://127.0.0.1:8892/v1,
// which the -R reverse tunnel maps back here.

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const { startLlmProxy, stopLlmProxy } = require("./llm-proxy");

const API_BASE = process.env.CLUTCH_API_URL || "http://127.0.0.1:8890";

// ---- SSH tunnel ----
let sshProc = null;
let llmProxyPort = null;

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

function waitForServer(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 500);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

async function killTunnel() {
  if (sshProc) sshProc.kill();
  sshProc = null;
  stopLlmProxy();
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Clutch",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  ipcMain.handle("tunnel:connect", async (_e, { host, user, port }) => {
    if (sshProc) return { ok: false, error: "already connected" };
    try {
      const localPort = await freePort();
      llmProxyPort = await startLlmProxy();
      sshProc = spawn(
        "ssh",
        [
          "-N",
          "-L", localPort + ":127.0.0.1:8890",
          "-R", "8892:127.0.0.1:" + llmProxyPort,
          "-o", "ServerAliveInterval=30",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "StrictHostKeyChecking=accept-new",
          "-p", String(port || 22),
          (user || "") + "@" + host,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      sshProc.stderr.on("data", (d) => {
        stderr += d;
      });
      sshProc.on("exit", () => {
        sshProc = null;
        stopLlmProxy();
      });
      const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", 15000);
      if (!up) {
        const err = (stderr.trim().split("\n").pop()) || "backend not reachable on the remote host";
        if (sshProc) sshProc.kill();
        sshProc = null;
        stopLlmProxy();
        return { ok: false, error: err };
      }
      return { ok: true, url: "http://127.0.0.1:" + localPort };
    } catch (e) {
      if (sshProc) sshProc.kill();
      sshProc = null;
      stopLlmProxy();
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("tunnel:disconnect", async () => {
    await killTunnel();
    return { ok: true };
  });
});

app.on("window-all-closed", () => {
  if (sshProc) sshProc.kill();
  app.quit();
});
