// loopback plumbing — free ports, listening sockets, health polls
//
// Everything here talks to 127.0.0.1 only. It is the client end of the
// tunnel, not the ssh client: a free port for the forward, a socket to
// listen on it, and the polls that decide whether what answers on a port is
// a Clutch supervisor, a legacy shared server, or nothing at all. The
// connect flow is the only caller, and it never looks inside.

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
    return body.includes('"status"') ? "up" : "foreign";
  } catch {
    return "down";
  }
}

module.exports = {
  freePort,
  listen,
  waitForServer,
  probeSupervisorShape,
};
