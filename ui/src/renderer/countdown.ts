// the countdown meter a declaration asks for — REAL seconds, never an animation
//
// A tool whose declaration sets `countdown: "<argument>"` waits for that many
// seconds, and its call row shows how much of the wait is left: a progress bar
// and the seconds still to go. The number is NOT a counter started when the row
// was drawn. The host emits `tool_started` as the loop really ENTERS the call
// (ui/src/host/run-host.ts), that instant rides on the meter, and every repaint
// subtracts it from the wall clock — so what the row says is what the wait is
// doing, and a page that was frozen, cached away or restored paints the truth it
// has (the same instant) instead of restarting a pretty count.
//
// The durable `tool_call` record cannot be that instant: run.js writes every call
// of a step BEFORE running the first of them, so its `timestamp` is when the
// calls were written, not when one began (three calls, and the third's stamp is
// minutes early). A row that has no `tool_started` frame — a replayed log, which
// records no start at all — therefore WAITS for one instead of inventing an
// anchor it does not have; it never counts down from the record's stamp.
//
// There is ONE timer for the page and the meters are the DOM's: each element
// carries its own `data-seconds` / `data-started`, a detached cached view costs
// nothing, and it is recomputed the moment it is back on the page
// (slots.ts restoreDomCache). No CSS transition on the fill, for the same reason
// the connection bars carry none: the width IS the number.

const TICK_MS = 250;
const METER = ".tool-countdown";

// tool_call_id -> the wall-clock instant (ms) the call really began. Written by
// the host's live `tool_started` frame; read when the row is drawn, which may be
// before OR after that frame (the two feeds are unordered).
const anchors = new Map<string, number>();

let timer: ReturnType<typeof setInterval> | null = null;

function meters() {
  return Array.prototype.slice.call(document.querySelectorAll(METER)) as HTMLElement[];
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTimer() {
  if (timer === null) timer = setInterval(tick, TICK_MS);
}

function tick() {
  const all = meters();
  for (const el of all) paintMeter(el);
  // nothing on the page is waiting any more: a timer that keeps firing would be
  // an animation of its own
  if (!all.length) stopTimer();
}

// one meter, from the instant it carries and the clock as it is NOW
export function paintMeter(el: HTMLElement) {
  const total = Number(el.dataset.seconds) || 0;
  const started = Number(el.dataset.started) || 0;
  const fill = el.querySelector(".tool-countdown-fill") as HTMLElement | null;
  const label = el.querySelector(".tool-countdown-text") as HTMLElement | null;
  if (!(total > 0)) return;
  if (!started) {
    // no real start yet (a row drawn before the call was entered, or a replayed
    // one): say so, and claim no seconds the row cannot know
    el.classList.add("waiting");
    if (fill) fill.style.width = "0%";
    if (label) label.textContent = "waiting…";
    el.setAttribute("aria-valuenow", "0");
    el.setAttribute("aria-valuetext", "waiting for the call to start");
    return;
  }
  el.classList.remove("waiting");
  const elapsed = Math.min(total, Math.max(0, (Date.now() - started) / 1000));
  const left = total - elapsed;
  if (fill) fill.style.width = (elapsed / total) * 100 + "%";
  if (label) label.textContent = Math.ceil(left) + "s left";
  el.setAttribute("aria-valuenow", String(Math.floor(elapsed)));
  el.setAttribute("aria-valuetext", Math.ceil(left) + " seconds left");
}

// The argument the declaration named, as a positive number; 0 means "this call
// has no wait to count" (absent, not a number, or not positive).
export function countdownSeconds(ui, raw) {
  const key = ui && typeof ui.countdown === "string" ? ui.countdown : "";
  if (!key) return 0;
  let args: any = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw || "{}");
    } catch (e) {
      return 0; // still streaming, or not JSON at all: nothing to count yet
    }
  }
  if (!args || typeof args !== "object") return 0;
  const value = args[key];
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

// The meter for one call, or null when the declaration asks for none. The row it
// goes in is the caller's; the anchor is the host's if it has arrived, and the
// meter waits otherwise (see the head of this file).
export function countdownMeter(ui, ev) {
  const seconds = countdownSeconds(ui, ev && ev.arguments);
  if (!(seconds > 0)) return null;
  const el = document.createElement("span");
  el.className = "tool-countdown";
  el.dataset.seconds = String(seconds);
  el.dataset.countdownId = String((ev && ev.tool_call_id) || "");
  const started = anchors.get(el.dataset.countdownId);
  if (started) el.dataset.started = String(started);
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", String(Math.round(seconds)));
  el.setAttribute("aria-label", "wait remaining");

  const track = document.createElement("span");
  track.className = "tool-countdown-track";
  const fill = document.createElement("span");
  fill.className = "tool-countdown-fill";
  track.appendChild(fill);
  const label = document.createElement("span");
  label.className = "tool-countdown-text";
  el.appendChild(track);
  el.appendChild(label);

  paintMeter(el);
  ensureTimer();
  return el;
}

// The host's live frame: this call is being entered NOW. It is also the answer a
// row drawn earlier (the durable record can land first) is waiting for.
export function noteToolStarted(ev) {
  const id = String((ev && ev.tool_call_id) || "");
  if (!id) return;
  const at = Number(ev.started_at);
  anchors.set(id, Number.isFinite(at) && at > 0 ? at : Date.now());
  for (const el of meters()) {
    if (el.dataset.countdownId === id) el.dataset.started = String(anchors.get(id));
  }
  resumeCountdowns();
}

// The call is over (its result landed): the row's own result line says what
// happened, so the meter goes — and with it the anchor, so nothing can count a
// finished wait again.
export function settleCountdown(id) {
  const key = String(id || "");
  if (!key) return;
  anchors.delete(key);
  let removed = false;
  for (const el of meters()) {
    if (el.dataset.countdownId !== key) continue;
    el.remove();
    removed = true;
  }
  if (removed && !meters().length) stopTimer();
}

// The run is over (a final): an aborted call never gets a result, and a meter
// left behind would keep claiming a wait nothing is doing.
export function settleAllCountdowns() {
  anchors.clear();
  for (const el of meters()) el.remove();
  stopTimer();
}

// Repaint now and make sure the clock is on. Called when a view comes BACK on the
// page (a cached tab restored, the window visible again): the meters were away
// while it was detached, and their numbers are derived from the wall clock, so
// one repaint is all they need.
export function resumeCountdowns() {
  const all = meters();
  for (const el of all) paintMeter(el);
  if (all.length) ensureTimer();
  else stopTimer();
}

// A page that was frozen (Android's WebView, a backgrounded window) comes back
// with a timer that fired late: repaint from the clock rather than wait.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") resumeCountdowns();
  });
}
