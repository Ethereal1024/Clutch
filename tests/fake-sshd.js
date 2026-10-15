"use strict";

// A real far side for the tunnel runners: an ssh2 server on 127.0.0.1 that
// behaves like the sshds the field reports came from.
//
// Every other tunnel runner fakes the WIRE (a class in place of ssh2's Client),
// which is the right seam when the question is what this repo's code does with
// an answer. It is the wrong seam for the one fact all of this turns on: what an
// sshd does with the client's `tcpip-forward` global request is a fact about the
// far side, not about us — an sshd that takes the request and says NOTHING is
// exactly what a middlebox, a hardened or non-OpenSSH sshd, and a session whose
// request channel is wedged all look like from here. A real ssh2 server can be
// made to say nothing, so the test can stand on the real protocol instead of a
// hand-written stub that agrees with whatever the code under test assumes.
//
// What it does: authenticates anyone, runs commands through /bin/sh (the remote
// exec the bootstrap uses), forwards direct-tcpip to 127.0.0.1:<the port asked
// for> (the local forward that carries the health gate), and answers the reverse
// forward only as told:
//
//   forward: "silent"  → the request is taken and NOTHING comes back: no
//                        success, no failure, no disconnect (the shape that
//                        parked "Starting tunnel…" in the field)
//   forward: "held"    → every bind for the CONTRACT port is refused,
//                        "address already in use" (the orphaned listener the
//                        field log holds on 8892), while a port the far side
//                        picks itself (port 0 — RFC 4254) is granted: a held
//                        port is not a far side that cannot forward
//   forward: "reject"  → every bind is refused at all (a far side that really
//                        has no forwarding to give)
//   forward: "accept"  → accepted with the port asked for, or with `chosenPort`
//                        when the client asked the far side to pick one
//
// startFakeSshd({...}) -> Promise<{ port, events, connections, close() }>
//   port         the TCP port the client dials
//   events       what the far side was asked, in order (for assertions)
//   connections  the sessions still open (empty = the far side has seen the
//                client's wire close, which is the point at which everything the
//                client sent has already been recorded in `events`)
//   close()      stop listening (connected clients are ended)

const net = require("net");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { Server } = require("../ui/node_modules/ssh2");

let HOST_KEY = null;
function hostKey() {
  if (!HOST_KEY) {
    // the far side's identity. RSA/PKCS#1 is the one shape every ssh2 version
    // in this tree parses without a helper, and it is generated once per run.
    HOST_KEY = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" });
  }
  return HOST_KEY;
}

function startFakeSshd(opts = {}) {
  const mode = opts.forward || "accept";
  const chosenPort = opts.chosenPort || 46123;
  const events = [];
  const connections = new Set();

  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));

    // the remote shell has to work for the connect to get past its probe
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => {});

    // the reverse forward, and the only place this fake has an opinion
    client.on("request", (accept, reject, name, info) => {
      if (name !== "tcpip-forward" && name !== "cancel-tcpip-forward") {
        if (accept) accept();
        return;
      }
      events.push(name + ":" + (info && info.bindPort));
      if (mode === "silent") return; // no reply is the whole point
      if (mode === "reject") return reject();
      // a "held" far side: the port it was asked for is taken (by something this
      // window cannot reach or kill), so it says so — and grants a port of its
      // own when it is asked to pick one, which is what an sshd does.
      if (mode === "held" && info && info.bindPort !== 0) return reject();
      accept(info && info.bindPort === 0 ? chosenPort : undefined);
    });

    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, rejectExec, info) => {
        const ch = acceptExec();
        const child = execFile("/bin/sh", ["-c", info.command || "true"], { timeout: 20000 }, (err) => {
          ch.exit(err && typeof err.code === "number" ? err.code : 0);
          ch.end();
        });
        child.stdout.on("data", (d) => ch.write(d));
        child.stderr.on("data", (d) => ch.write(d));
      });
    });

    // the local forward: this is the far SSH server dialing the service it holds
    client.on("tcpip", (accept, reject, info) => {
      if (opts.forwardTo === false) return reject();
      const ch = accept();
      events.push("direct-tcpip:" + info.destPort);
      const sock = net.connect(info.destPort, "127.0.0.1");
      sock.on("connect", () => ch.pipe(sock).pipe(ch));
      sock.on("error", () => ch.close());
      ch.on("close", () => sock.destroy());
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        events,
        connections,
        close: () =>
          new Promise((done) => {
            for (const c of connections) {
              try {
                c.end();
              } catch (e) {
                /* already gone */
              }
            }
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startFakeSshd };
