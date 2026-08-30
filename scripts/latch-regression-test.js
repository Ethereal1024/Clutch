// Regression simulation for the grep+think latch-drop bug.
// Reproduces the scroll-event sequence of a long pinned stream (thinking +
// grep results pinning via isTrusted=false scrolls) followed by a huge fold
// collapse whose clamp fires a trusted scroll event.
//
// Old logic: baselines (prevScrollH/prevClientH) only refresh on trusted events
//   -> stale baseline -> fingerprint misses -> clamp misread as scroll-up.
// New logic: baselines refresh on every scroll + `up` guarded by nearBottom().

const JUMP_BOTTOM_GAP = 80;
const nearBottom = (H, S, C) => H - S - C < JUMP_BOTTOM_GAP;

// Returns followTail after one trusted scroll event. `refresh` toggles the
// isTrusted=false baseline refresh; `guard` toggles the nearBottom() guard.
function onTrustedScroll(st, refresh, guard) {
  const { H, C, S, lastScrollTop, prevScrollH, prevClientH, followTail } = st;
  const viewportShrank = C < prevClientH;
  const scrollShrank = H < prevScrollH;
  if (viewportShrank || scrollShrank) {
    st.lastScrollTop = S;
    st.prevScrollH = H;
    st.prevClientH = C;
    return followTail; // clamped: latch untouched
  }
  const up = S < lastScrollTop && (!guard || !nearBottom(H, S, C));
  if (up) st.followTail = false;
  else if (nearBottom(H, S, C)) st.followTail = true;
  st.lastScrollTop = S;
  st.prevScrollH = H;
  st.prevClientH = C;
  return st.followTail;
}

function onProgrammaticPin(st, refresh) {
  // autoScroll: pin to the tail, fire isTrusted=false scroll
  const { H, C } = st;
  st.S = H - C;
  st.lastScrollTop = st.S;
  if (refresh) { st.prevScrollH = H; st.prevClientH = C; }
}

function scenario() {
  const st = { H: 1000, C: 600, S: 400, lastScrollTop: 400, prevScrollH: 1000, prevClientH: 600, followTail: true };
  // 1. thinking streams in: 20 pins of +20px content (isTrusted=false)
  for (let i = 0; i < 20; i++) { st.H += 20; onProgrammaticPin(st, true); }
  // 2. grep result arrives: read-row +20px, huge fold hidden (0px) -> one more pin
  st.H += 20; onProgrammaticPin(st, true);
  // 3. user expands the grep fold: +400000px, followTailDuring pins each frame
  st.H += 400000; onProgrammaticPin(st, true);
  // 4. user collapses the fold: height shrinks in 4 frames; each clamp fires a
  //    trusted scroll event while the view is at the bottom
  let dropFrames = 0;
  for (let f = 0; f < 4; f++) {
    st.H -= 100000;
    const max = st.H - st.C;
    if (st.S > max) { st.S = max; } // browser clamps scrollTop
    const before = st.followTail;
    const after = onTrustedScroll(st, true, true);
    if (before && !after) dropFrames++;
  }
  return { followTail: st.followTail, dropFrames };
}

// Old logic: no baseline refresh, no nearBottom guard
function scenarioOld() {
  const st = { H: 1000, C: 600, S: 400, lastScrollTop: 400, prevScrollH: 1000, prevClientH: 600, followTail: true };
  for (let i = 0; i < 20; i++) { st.H += 20; onProgrammaticPin(st, false); }
  st.H += 20; onProgrammaticPin(st, false);
  st.H += 400000; onProgrammaticPin(st, false);
  let dropFrames = 0;
  for (let f = 0; f < 4; f++) {
    st.H -= 100000;
    const max = st.H - st.C;
    if (st.S > max) { st.S = max; }
    const before = st.followTail;
    const after = onTrustedScroll(st, false, false);
    if (before && !after) dropFrames++;
  }
  return { followTail: st.followTail, dropFrames };
}

// Guard-only variant (baseline refresh off, nearBottom guard on)
function scenarioGuardOnly() {
  const st = { H: 1000, C: 600, S: 400, lastScrollTop: 400, prevScrollH: 1000, prevClientH: 600, followTail: true };
  for (let i = 0; i < 20; i++) { st.H += 20; onProgrammaticPin(st, false); }
  st.H += 20; onProgrammaticPin(st, false);
  st.H += 400000; onProgrammaticPin(st, false);
  let dropFrames = 0;
  for (let f = 0; f < 4; f++) {
    st.H -= 100000;
    const max = st.H - st.C;
    if (st.S > max) { st.S = max; }
    const before = st.followTail;
    const after = onTrustedScroll(st, false, true);
    if (before && !after) dropFrames++;
  }
  return { followTail: st.followTail, dropFrames };
}

// A genuine user scroll-up away from the bottom must still break the latch.
function genuineScrollUp() {
  const st = { H: 1040, C: 600, S: 440, lastScrollTop: 440, prevScrollH: 1040, prevClientH: 600, followTail: true };
  st.S = 300; // user scrolled up 140px (well past the 80px gap)
  return onTrustedScroll(st, true, true);
}

const r = scenario(), o = scenarioOld(), g = scenarioGuardOnly(), u = genuineScrollUp();
console.log("new logic     : followTail=" + r.followTail + " (dropped on " + r.dropFrames + "/4 frames)");
console.log("old logic     : followTail=" + o.followTail + " (dropped on " + o.dropFrames + "/4 frames)");
console.log("guard-only    : followTail=" + g.followTail + " (dropped on " + g.dropFrames + "/4 frames)");
console.log("genuine scroll-up: followTail=" + u + " (must be false)");
const pass = r.followTail === true && r.dropFrames === 0
  && o.followTail === false && o.dropFrames > 0
  && g.followTail === true && g.dropFrames === 0
  && u === false;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
