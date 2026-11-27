"use strict";

// The countdown a declaration asks for: `ui: { countdown: "<argument>" }` puts a
// progress bar and the seconds still to wait on the call's row. The claim this
// runner guards is the whole point of the feature and the easiest thing to get
// wrong: the number is measured from the instant the call REALLY began — the
// host's live `tool_started` frame — and never from when the row was drawn nor
// from the durable call record's `timestamp` (run.js writes every call of a step
// before running the first, so that stamp can be minutes early). A row with no
// anchor says so ("waiting…") instead of counting from a number it does not have.
//
// The real module is extracted from the renderer source (harness rendererScript)
// and driven against a stub DOM, so an edit that turns the meter into a timer of
// its own, or that hides a missing anchor behind an invented start, fails here.
//
// Run: node tests/sleep-countdown-test.js
const fs = require("fs");
const path = require("path");
const { check, summary, rendererScript } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---- stub DOM: just enough for one meter and the nodes inside it ----
const created = [];
function hasClass(n, cls) {
  return String(n.className || "").split(/\s+/).includes(cls);
}
function node(tag) {
  const n = {
    tag,
    children: [],
    dataset: {},
    attrs: {},
    style: {},
    className: "",
    _text: "",
    _parent: null,
    classList: {
      add(...cls) {
        const set = new Set(String(n.className).split(/\s+/).filter(Boolean));
        for (const c of cls) set.add(c);
        n.className = [...set].join(" ");
      },
      remove(...cls) {
        const set = new Set(String(n.className).split(/\s+/).filter(Boolean));
        for (const c of cls) set.delete(c);
        n.className = [...set].join(" ");
      },
      contains: (cls) => hasClass(n, cls),
    },
    appendChild(ch) {
      ch._parent = n;
      n.children.push(ch);
      return ch;
    },
    remove() {
      n._removed = true;
      if (!n._parent) return;
      const i = n._parent.children.indexOf(n);
      if (i >= 0) n._parent.children.splice(i, 1);
      n._parent = null;
    },
    setAttribute(k, v) { n.attrs[k] = String(v); },
    getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
    get textContent() { return n._text; },
    set textContent(v) { n._text = String(v); },
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      for (const ch of n.children) {
        if (hasClass(ch, cls)) return ch;
        const deep = ch.querySelector && ch.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
  };
  return n;
}

global.document = {
  visibilityState: "visible",
  addEventListener() {},
  createElement(tag) {
    const n = node(tag);
    created.push(n);
    return n;
  },
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, "");
    return created.filter((n) => !n._removed && hasClass(n, cls));
  },
};

// the clock the meter reads, frozen so the arithmetic is checkable; the timer is
// counted, never run — the tick itself is driven by the test
const NOW0 = 1_700_000_000_000;
let NOW = NOW0;
Date.now = () => NOW;
let started = 0;
let stopped = 0;
global.setInterval = () => {
  started += 1;
  return started;
};
global.clearInterval = () => {
  stopped += 1;
};

// the real module, executed the way the page's bundle runs it
(0, eval)(rendererScript("countdown"));

const text = (el) => el.querySelector(".tool-countdown-text").textContent;
const width = (el) => el.querySelector(".tool-countdown-fill").style.width;
const ui = (key) => ({ countdown: key });

(async () => {
  // ---- 1) the protocol: whose declaration asks, and the argument it names ----
  {
    const decl = require("../ui/tool-decl.js");
    const sleepDecl = decl.CLIENT_NATIVE_DECLARATIONS.find((d) => d.name === "sleep");
    check(!!sleepDecl, "the client declares sleep");
    check(
      sleepDecl && sleepDecl.ui && sleepDecl.ui.countdown === "seconds",
      "and its row counts down the `seconds` argument"
    );
    check(decl.DEFAULT_UI.countdown === "", "a declaration that says nothing counts nothing");
    check(decl.UI_KEYS.includes("countdown"), "the renderer's vocabulary accepts the key (UI_KEYS)");

    // the Python half is the same protocol: the key exists in the normative
    // table, and the client-native declaration there names the same argument
    const catalog = read("agent", "tools", "catalog.py");
    const defaults = catalog.slice(catalog.indexOf("DEFAULT_UI"), catalog.indexOf("UI_KEYS"));
    check(/"countdown": ""/.test(defaults), "catalog.DEFAULT_UI carries the key (the normative table)");
    const hostpy = read("agent", "tools", "host.py");
    const declsAt = hostpy.indexOf("_CLIENT_NATIVE_DECLARATIONS");
    const sleepDeclText = hostpy.slice(
      hostpy.indexOf('"sleep"', declsAt),
      hostpy.indexOf('"start_tick"', declsAt)
    );
    check(
      /"countdown": "seconds"/.test(sleepDeclText),
      "host.py's sleep declaration names the same argument"
    );

    // ...and a call that waits for a DEADLINE it was given counts that deadline:
    // `trigger`'s timeout is required, so the wait it must state is the number
    // its row shows, in both halves of the declaration
    const triggerDecl = decl.HOST_DECLARATIONS.find((d) => d.name === "trigger");
    check(!!triggerDecl, "the host declares trigger");
    check(
      triggerDecl && triggerDecl.ui && triggerDecl.ui.countdown === "timeout",
      "and its row counts down the `timeout` the call was required to give"
    );
    check(
      triggerDecl && triggerDecl.parameters && triggerDecl.parameters.required.includes("timeout"),
      "the argument it counts is the one its schema requires"
    );
    const hostDeclsAt = hostpy.indexOf("_DECLARATIONS");
    const triggerDeclText = hostpy.slice(
      hostpy.indexOf('"trigger"', hostDeclsAt),
      hostpy.indexOf("shell.run_trigger", hostDeclsAt)
    );
    check(
      /"countdown": "timeout"/.test(triggerDeclText),
      "host.py's trigger declaration names the same argument"
    );
    check(
      /"required": \["command", "timeout"\]/.test(triggerDeclText),
      "and requires the same argument its row counts"
    );

    // the renderer knows no tool name at all: the meter is driven by the
    // declaration, so every module that mounts it is free of the word (other
    // modules may name a tool in passing prose — auto-fold's comment does)
    const meterSources = ["countdown", "tool-render", "stream-events", "slots", "boot"]
      .map((name) => read("ui", "src", "renderer", name + ".ts"))
      .join("\n");
    check(!/\bsleep\b/i.test(meterSources), "no tool name appears in the meter's renderer sources");
    check(/countdownMeter/.test(meterSources), "the row builders ask the meter module");
  }

  // ---- 2) which argument, and when there is nothing to count ----
  {
    check(countdownSeconds(ui("seconds"), '{"seconds":300}') === 300, "the named argument is the wait");
    check(countdownSeconds(ui("seconds"), { seconds: 12 }) === 12, "a parsed payload answers the same");
    check(countdownSeconds(ui("seconds"), '{"seconds":"12"}') === 12, "a numeric string is a number");
    check(countdownSeconds(ui("seconds"), '{"seconds":0}') === 0, "zero is not a wait");
    check(countdownSeconds(ui("seconds"), '{"seconds":-5}') === 0, "nor is a negative one");
    check(countdownSeconds(ui("seconds"), '{"seconds":"soon"}') === 0, "nor is a word");
    check(countdownSeconds(ui("seconds"), '{"second":300}') === 0, "a different argument is not the wait");
    check(countdownSeconds(ui(""), '{"seconds":300}') === 0, "a declaration that names none counts nothing");
    check(countdownSeconds({}, '{"seconds":300}') === 0, "a declaration without the key counts nothing");
    check(countdownSeconds(ui("seconds"), '{"seconds":3') === 0, "arguments still arriving are not a number yet");
  }

  // ---- 3) no real start: the row waits, and invents nothing ----
  {
    // a durable call record from ten minutes ago says nothing about when the call
    // began — with no anchor the meter must NOT read 0s or the full wait
    const ev = {
      tool_call_id: "c-old",
      arguments: '{"seconds":300}',
      timestamp: (NOW - 600_000) / 1000,
    };
    const meter = countdownMeter(ui("seconds"), ev);
    check(!!meter, "the declaration asks for a meter");
    check(text(meter) === "waiting…", `a row with no start says so, not a time (got "${text(meter)}")`);
    check(width(meter) === "0%", "and its bar is empty: a wait that has not begun is not in motion");
    check(meter.classList.contains("waiting"), "the waiting state is worn by the element");
    check(meter.attrs["aria-valuetext"] === "waiting for the call to start", "and it is said to a screen reader too");
  }

  // ---- 4) the real instant: seconds left, bar grown, and it moves with the clock
  {
    const ev = { tool_call_id: "c1", arguments: '{"seconds":300}', timestamp: (NOW - 600_000) / 1000 };
    const meter = countdownMeter(ui("seconds"), ev);
    noteToolStarted({ tool_call_id: "c1", name: "sleep", started_at: NOW - 60_000 });
    check(text(meter) === "240s left", `one minute in, the row says 240s left (got "${text(meter)}")`);
    check(width(meter) === "20%", `and its bar is one fifth full (got "${width(meter)}")`);
    check(meter.attrs["aria-valuenow"] === "60", "the progressbar reports the elapsed seconds");
    check(meter.attrs["aria-valuemax"] === "300", "against the whole wait");
    check(!meter.classList.contains("waiting"), "the waiting state is gone once the call really began");

    // time passes on the wall clock: the next paint is derived, never counted
    NOW += 90_000;
    paintMeter(meter);
    check(text(meter) === "150s left", `two and a half minutes in: 150s left (got "${text(meter)}")`);
    check(width(meter) === "50%", `and the bar is half full (got "${width(meter)}")`);

    NOW += 200_000; // past the end: a result may be a moment late, the row must not go negative
    paintMeter(meter);
    check(text(meter) === "0s left", "past the wait it reads 0s left, never a negative number");
    check(width(meter) === "100%", "and the bar cannot grow past its track");

    // a row drawn AFTER the frame takes the anchor the frame left behind
    const late = countdownMeter(ui("seconds"), { tool_call_id: "c1", arguments: '{"seconds":300}' });
    check(text(late) === "0s left", "a row drawn after the start counts from that same instant, not from paint");
    settleCountdown("c1");
  }

  // ---- 5) the call is over: the meter leaves, and nothing counts it again ----
  {
    const row = node("div");
    const meter = countdownMeter(ui("seconds"), { tool_call_id: "c2", arguments: '{"seconds":5}' });
    row.appendChild(meter);
    noteToolStarted({ tool_call_id: "c2", started_at: NOW - 1_000 });
    check(row.children.length === 1, "the meter lives in the call's row");
    settleCountdown("c2");
    check(row.children.length === 0, "the result settles it: the row keeps no finished clock");
    check(meter._removed === true, "and the element is off the page, not merely hidden");
    const again = countdownMeter(ui("seconds"), { tool_call_id: "c2", arguments: '{"seconds":5}' });
    check(text(again) === "waiting…", "its anchor went with it: a later row starts waiting again, not at 1s");
  }

  // ---- 6) one clock for the page, and it stops when nothing is waiting ----
  {
    // earlier sections left meters behind: a clean page first, so "one timer"
    // is about these two meters and not about a timer already on
    settleAllCountdowns();
    const before = started;
    const a = countdownMeter(ui("seconds"), { tool_call_id: "c3", arguments: '{"seconds":30}' });
    const b = countdownMeter(ui("seconds"), { tool_call_id: "c4", arguments: '{"seconds":60}' });
    check(started === before + 1, `two meters, ONE timer (started ${started - before})`);
    noteToolStarted({ tool_call_id: "c3", started_at: NOW });
    noteToolStarted({ tool_call_id: "c4", started_at: NOW });
    resumeCountdowns();
    check(text(a) === "30s left" && text(b) === "60s left", "each row counts its own wait");
    const stoppedBefore = stopped;
    settleAllCountdowns();
    check(a._removed && b._removed, "a finished run takes every meter with it");
    check(stopped === stoppedBefore + 1, "and the page's timer stops: no meter, no clock");
  }

  // ---- 7) the feed's routes: started → anchor, result → settle, final → all ----
  {
    const stream = read("ui", "src", "renderer", "stream-events.ts");
    check(
      /if \(ev\.type === "tool_started"\) \{[\s\S]{0,400}?noteToolStarted\(ev\)/.test(stream),
      "applyStreamEvent routes the live tool_started frame to the anchor"
    );
    check(
      /ev\.type === "tool_result" && ev\.tool_call_id\) \{[\s\S]{0,300}?settleCountdown\(ev\.tool_call_id\)/.test(stream),
      "a result settles its call's meter"
    );
    check(
      /final[\s\S]{0,900}?settleAllCountdowns\(\)/.test(stream),
      "a final settles every meter, including a call Stop aborted"
    );
    const host = read("ui", "src", "host", "run-host.ts");
    check(
      /runTool: async[\s\S]{0,900}?type: "tool_started"[\s\S]{0,200}?started_at: Date\.now\(\)/.test(host),
      "the host announces the anchor as it ENTERS the call, with its own clock"
    );
    const slots = read("ui", "src", "renderer", "slots.ts");
    check(
      /replaceChildren\(cache\.nodes\);[\s\S]{0,700}?resumeCountdowns\(\)/.test(slots),
      "a restored tab repaints its meters from the clock they carry"
    );
    const css = read("ui", "style.css");
    const rule = css.slice(css.indexOf(".tool-countdown-fill {"), css.indexOf(".tool-countdown-text {"));
    check(!!rule && !/transition/.test(rule), "the bar's fill has no CSS transition: its width IS the number");
  }

  summary("sleep countdown: a real wait, counted from the instant the call began");
})();
