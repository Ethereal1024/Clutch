// The phone's wake policy, as a checked fact (P5-2/P5-3).
//
// The engine decides, the native shell only reads: android-host.js writes two
// one-word files under HOME, TunnelService holds the CPU awake while either of
// them says yes, and MainActivity offers the Doze exemption for the same two
// reasons. This suite pins the seam between those three files — the file names,
// the exact words, who writes and who only reads — because nothing here can be
// run: no device, no Android SDK, no Kotlin compiler in this checkout.
//
// The failure this guards against is a silent one: a renamed word on one side
// leaves the service reading a file that never says yes, and a phone that goes
// flat or freezes mid-turn with no error anywhere.
//
// Run: node tests/android-wake.test.js
const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const HOST = read("android/host/android-host.js");
const SERVICE = read("android/app/src/main/java/io/clutch/mobile/TunnelService.kt");
const ACTIVITY = read("android/app/src/main/java/io/clutch/mobile/MainActivity.kt");
const STRINGS = read("android/app/src/main/res/values/strings.xml");
const DESKTOP = read("ui/main.js");

const word = (how, text) => {
  const m = how.exec(text);
  return m ? m[1] : null;
};

// The JS function bodies this suite needs: the harness's own slicer, so a
// function that moves inside the file keeps working.
const jsBody = (src, name) => slicer(src).fnBody(name);

// Kotlin has no slicer here, and the files are read as text: cut from the
// declaration to the end of the block that follows its signature.
function ktBody(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  return src.slice(open, slicer(src).bodyEnd(open));
}

function main() {
  // ---- 1. one word, three files: they have to agree ----
  {
    const written = word(/writeMarker\(runMarker,\s*busy\s*\?\s*"([^"]+)"\s*:\s*"[^"]+"\)/, HOST);
    const polled = word(/fun runBusy\(\)[\s\S]{0,240}?trim\(\)\s*==\s*"([^"]+)"/, SERVICE);
    const prompted = word(/markerSays\(RUN_STATE_MARKER,\s*"([^"]+)"\)/, ACTIVITY);
    check(written === "busy", `the host writes "busy" for a running turn (got ${written || "—"})`);
    check(Boolean(polled), "the service compares the marker to a literal word");
    check(Boolean(prompted), "the activity compares the marker to a literal word");
    check(
      written !== null && written === polled,
      `the service polls the word the host writes (host "${written || "—"}" / service "${polled || "—"}")`
    );
    check(
      written !== null && written === prompted,
      `the activity prompts on the word the host writes (host "${written || "—"}" / activity "${prompted || "—"}")`
    );
  }

  // ---- 2. the file names agree too, and only the host writes them ----
  {
    check(/"run\.state"/.test(HOST), 'the host names the file "run.state"');
    check(/RUN_STATE_MARKER\s*=\s*"run\.state"/.test(SERVICE), 'the service names the same file "run.state"');
    check(/RUN_STATE_MARKER\s*=\s*"run\.state"/.test(ACTIVITY), 'the activity names the same file "run.state"');
    // a marker the native side wrote would be native guessing: it reads, period
    check(!/runMarker\s*\.\s*writeText/.test(SERVICE), "the service never writes the run marker");
    check(!/\bRUN_STATE_MARKER\b[^=]*write/i.test(SERVICE), "and never opens it for writing");
    check(
      !/["']run\.state["']/.test(DESKTOP),
      "the desktop shell knows nothing about a wake marker (no service to tell)"
    );
  }

  // ---- 3. the host derives it from the loop's busy edges, and clears it at boot ----
  {
    check(/onBusy:\s*writeRunMarker\b/.test(HOST), "the android host hands the loop's busy edges to the marker writer");
    check(!/onBusy/.test(DESKTOP), "the desktop shell passes no onBusy: there is no native service there");
    const run = jsBody(HOST, "ensureRun");
    check(/onBusy:\s*writeRunMarker\b/.test(run), "and it does so on the ONE instance-building path");

    const boot = jsBody(HOST, "start");
    check(Boolean(boot), "the host has a start() body");
    const staleRun = boot.indexOf('fs.unlinkSync(path.join(os.homedir(), "run.state"))');
    const staleTunnel = boot.indexOf('fs.unlinkSync(path.join(os.homedir(), "tunnel.state"))');
    const bound = boot.indexOf("createBridgeServer");
    check(staleRun > 0, "boot clears a stale run marker from a previous process life");
    check(staleTunnel > 0 && staleRun > staleTunnel, "right beside the tunnel marker it mirrors");
    check(
      bound > 0 && staleRun < bound,
      "before the bridge is created: no window can drive a turn before that point"
    );
  }

  // ---- 4. the service holds the CPU for EITHER reason, and says which ----
  {
    const reason = ktBody(SERVICE, "private fun wakeReason()");
    check(Boolean(reason), "TunnelService answers a reason, not a boolean");
    check(/wantsTunnel\(\)/.test(reason), "it asks the tunnel marker");
    check(/runBusy\(\)/.test(reason), "and the run marker");
    check(/else\s*->\s*null/.test(reason), "with null as the one 'neither' answer");

    check(
      /applyWakeState\(wakeReason\(\)\)/.test(SERVICE),
      "the poll applies that answer (the two markers are ORed, in one place)"
    );
    check(
      /private fun acquireWakeLocks\(why:\s*String\)/.test(SERVICE),
      "acquiring takes the reason with it"
    );
    check(/\[wake\] CPU held: \$why/.test(SERVICE), "so the log names WHICH reason held the CPU");
    check(
      /\[wake\] CPU released: neither a tunnel nor a running turn wants it/.test(SERVICE),
      "and the release log says which two it let go"
    );
    check(
      !/acquireWakeLocks\(\)/.test(SERVICE),
      "no call site acquires without a reason (that is how the old hardcoded line came back)"
    );
  }

  // ---- 5. P5-3: the exemption offer follows the same two facts, once ----
  {
    const offer = ktBody(ACTIVITY, "private fun offerBatteryExemption()");
    check(Boolean(offer), "MainActivity has the Doze-exemption offer");
    check(/batteryExemptionAsked\(\)/.test(offer), "it is still gated on 'already asked'");
    check(/isIgnoringBatteryOptimizations/.test(offer), "and on the device not already exempt");
    check(
      /markerSays\(TUNNEL_STATE_MARKER,\s*"up"\)/.test(offer),
      "a standing tunnel intent is one reason"
    );
    check(
      /markerSays\(RUN_STATE_MARKER,\s*"busy"\)/.test(offer),
      "a turn being driven right now is the other"
    );
    check(/if\s*\(!tunnel\s*&&\s*!turn\)\s*return/.test(offer), "and neither one means no prompt at all");
    check(
      offer.indexOf("markBatteryExemptionAsked()") < offer.indexOf(".show()"),
      "the offer is remembered BEFORE it is shown: 'later' is an answer, and a dismiss is not a question again"
    );
    check(/R\.string\.battery_title_turn/.test(offer), "the turn case gets its own title");
    check(/R\.string\.battery_message_turn/.test(offer), "and its own message");
    check(
      /<string name="battery_title_turn">[^<]{4,}<\/string>/.test(STRINGS) &&
        /<string name="battery_message_turn">[^<]{20,}<\/string>/.test(STRINGS),
      "both strings exist, and are sentences rather than placeholders"
    );
    // the shared reader is one place, so a new marker cannot invent its own IO
    check(
      /private fun markerSays\(name:\s*String,\s*word:\s*String\)/.test(ACTIVITY),
      "one reader for both markers"
    );
    check(
      /file\.isFile\s*&&\s*file\.readText\(\)\.trim\(\)\s*==\s*word/.test(ACTIVITY),
      "which compares the exact word, never 'the file exists'"
    );
  }

  // ---- 6. the desktop host is untouched by all of this ----
  {
    check(!/["']tunnel\.state["']/.test(DESKTOP), "the desktop shell writes no wake marker either");
    check(
      /onBusy/.test(fs.readFileSync(path.join(ROOT, "ui/run-session.js"), "utf8")),
      "the port exists in the loop that both shells share"
    );
  }

  // ---- 7. the writer itself, driven: one word, written only when it changes ----
  //
  // The host's own marker plumbing, pulled out of the source and run against a
  // fake HOME. A marker is polled every 2s by a foreground service, so "write
  // only on a change" is the difference between a file the OS can cache and a
  // file rewritten 43 200 times a day; and a write that throws must never take
  // the engine down with it.
  {
    const { bodyEnd, sigBodyOpen } = slicer(HOST);
    const fnText = (name) => {
      const at = HOST.indexOf("function " + name + "(");
      if (at < 0) throw new Error("missing function: " + name);
      return HOST.slice(at, bodyEnd(sigBodyOpen(at)));
    };

    const files = new Map();
    const writes = [];
    const logs = [];
    let failWrites = false;
    const fakeFs = {
      readFileSync(p) {
        if (!files.has(p)) {
          const e = new Error(`ENOENT: no such file, open '${p}'`);
          e.code = "ENOENT";
          throw e;
        }
        return files.get(p);
      },
      writeFileSync(p, v) {
        if (failWrites) throw new Error("EACCES: permission denied");
        writes.push([p, String(v)]);
        files.set(p, String(v));
      },
    };
    const writeMarker = new Function(
      "fs",
      "log",
      `${fnText("writeMarker")}\nreturn writeMarker;`
    )(fakeFs, (m) => logs.push(m));

    check(writes.length === 0, "reading the source writes nothing by itself");
    writeMarker("/home/x/run.state", "busy");
    check(writes.length === 1 && files.get("/home/x/run.state") === "busy", "a missing marker is written");
    writeMarker("/home/x/run.state", "busy");
    writeMarker("/home/x/run.state", "busy");
    check(writes.length === 1, `the same word is not rewritten (polled every 2s: got ${writes.length} writes)`);
    writeMarker("/home/x/run.state", "idle");
    check(writes.length === 2 && files.get("/home/x/run.state") === "idle", "a changed word is written");
    failWrites = true;
    let threw = null;
    try {
      writeMarker("/home/x/run.state", "busy");
    } catch (e) {
      threw = e;
    }
    check(threw === null, "a write that fails does not throw into the caller");
    check(
      logs.length === 1 && /could not write \/home\/x\/run\.state/.test(logs[0]),
      `and it is logged with the file it could not write (got ${logs.join(" | ") || "—"})`
    );
  }

  // ---- 8. the busy edge becomes the word, and back ----
  {
    const { bodyEnd, sigBodyOpen } = slicer(HOST);
    const at = HOST.indexOf("function writeRunMarker(");
    check(at > 0, "the host has one run-marker writer");
    // the marker's own path constant, so the test drives the REAL destination
    const cut = HOST.lastIndexOf("const runMarker", at);
    check(cut > 0, "and the file it writes is a named constant above it");
    const chunk = HOST.slice(cut, bodyEnd(sigBodyOpen(at)));
    const seen = [];
    const writeRunMarker = new Function(
      "os",
      "path",
      "writeMarker",
      `${chunk}\nreturn writeRunMarker;`
    )(require("os"), require("path"), (file, want) => seen.push([file, want]));
    writeRunMarker(true);
    writeRunMarker(false);
    check(
      seen.length === 2 && seen[0][1] === "busy" && seen[1][1] === "idle",
      `true is "busy" and false is "idle" (got ${seen.map((s) => s[1]).join(",") || "—"})`
    );
    check(
      seen[0][0] === seen[1][0] && seen[0][0] === path.join(require("os").homedir(), "run.state"),
      `both edges write the same file under HOME (got ${seen[0][0]})`
    );
  }

  summary("android-wake: two markers under HOME, one reader each way");
}

main();
