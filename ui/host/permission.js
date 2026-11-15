// The permission engine: decide whether a tool call may proceed, and wait for the
// user when the answer is "ask".
//
// This is `agent/core/permission.py` (484 lines) moved to the far-root host with
// its vocabulary and its sentences intact. What it judges is unchanged: a call is
// classified by the POLICY its own declaration names (`access`: read / sweep /
// write / command) and by the argument that policy points at (`access_arg`), never
// by the tool's name — so a component installed later enters this engine without
// an edit here. The rules are the same five, in the same order, last match wins;
// the escaped-path verdict is the same walk over the same tokens.
//
// Two things are this port's own, and both are consequences of having no process
// to block:
//
//   * `require` is ASYNC. Python blocks the agent thread on a threading.Event;
//     here the run loop is a chain of promises, so the gate awaits a promise the
//     UI resolves with `resolve(id, allow)`. The observable behaviour is the same
//     — no timeout while a window is attached, a detached window denied after the
//     grace — because the wait is a poll loop in both (ATTACH_POLL_S).
//   * the id tag is `crypto.randomBytes(4).toString("hex")` instead of
//     `uuid.uuid4().hex[:8]`: still 8 hex characters, still unique per process,
//     still the thing that keeps a restarted host from reusing an id a window
//     remembers (`_ASK_IDS` / `_PROCESS_TAG` in the Python).
//
// Everything the two share is written down rather than re-derived: the rule
// regexes are the Python's own text, the reason sentences are its f-strings, and
// `splitCommand` is shlex.split — the far side is always a POSIX shell (plan §0:
// deployment B is an sshd and a stock sh), so the Windows tokenizer in
// tools/localshell.py has no counterpart here on purpose.
//
// createGate({evaluator, onAsk, autoAllow, isAttached, trust, ...}) -> gate
//   gate.require(tool, argsRepr, workspace, access, arg) -> Promise<undefined>
//   gate.resolve(requestId, allow) -> boolean
//   gate.pendingIds() / gate.pendingAsks()

"use strict";

const crypto = require("crypto");

// The host POLICY a declaration may put a tool under, and the argument that policy
// judges by default — `catalog.ACCESS_ARGS`, which `permission.GUARDED_ARG` copies.
// A declaration may rename the argument (`Tool.access_arg`); the word and its
// meaning stay the host's. "" = no host-side guard (the engine still judges).
const GUARDED_ARG = Object.freeze({
  read: "path",
  sweep: "path",
  write: "path",
  command: "command",
});

// ---- the rules ------------------------------------------------------------

// One rule of the ruleset. `access` is the declaration's word or "*"; `pattern` is
// a regex on the guarded argument (empty = any); `escape` means "only fires when
// the guarded paths really leave the workspace".
function Rule(action, access = "*", pattern = "", escape = false) {
  return { action, access, pattern, escape };
}

// The same five, in the same order (agent/core/permission.py: DEFAULT_RULES).
const DEFAULT_RULES = Object.freeze([
  // danger: destructive/irreversible commands always ask
  Rule("ask", "command", "\\brm\\s+-rf\\b|\\bsudo\\b|\\bshutdown\\b|\\breboot\\b|\\bmkfs\\b|\\bdd\\b\\s"),
  // commands that delete anything ask
  Rule("ask", "command", "^\\s*rm\\b"),
  // running outside the workspace asks — only when it really escapes (an
  // absolute path INSIDE the root is not an escape)
  Rule("ask", "command", "\\bmv\\s+.*\\s/\\s", true),
  Rule("ask", "command", "(\\.\\./|^/)", true),
  // and so does a write that names a path outside it
  Rule("ask", "write", "(\\.\\./|^/|~)", true),
]);

function matches(rule, guarded, access) {
  if (rule.access !== "*" && rule.access !== access) return false;
  if (!rule.pattern) return true;
  const text = typeof guarded === "string" ? guarded : JSON.stringify(guarded);
  try {
    return new RegExp(rule.pattern, "i").test(text);
  } catch (e) {
    return false;
  }
}

// ---- shlex.split (the POSIX flavor) ---------------------------------------

const WHITESPACE = " \t\r\n";

// `shlex.split(command)` with posix=True: quotes group, `\` escapes the next
// character outside single quotes, and an unbalanced quote is null (Python raises
// ValueError, and every caller takes its conservative unparseable path).
//
// Deliberate scope: no `commenters`, no punctuation_chars — the two are not in
// shlex.split, and the tool face's own tokenizer (tools/shell.py `_tokenize`) is
// a different function that asks for punctuation on top of this one.
function splitCommand(command) {
  const text = String(command == null ? "" : command);
  const out = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && WHITESPACE.includes(text[i])) i += 1;
    if (i >= text.length) break;
    let token = "";
    let single = false;
    let double = false;
    while (i < text.length) {
      const ch = text[i];
      if (single) {
        if (ch === "'") {
          single = false;
          i += 1;
        } else {
          token += ch;
          i += 1;
        }
        continue;
      }
      if (double) {
        if (ch === '"') {
          double = false;
          i += 1;
        } else if (ch === "\\") {
          const next = text[i + 1];
          if (next === undefined) {
            // "No escaped character": Python raises, and an unparseable command is
            // the conservative verdict the callers want
            return null;
          }
          // In a POSIX shell only the quote itself and the escape character may be
          // escaped INSIDE double quotes; anything else keeps its backslash
          // (`"C:\x"` is a path with a backslash, not an escape).
          if (next !== '"' && next !== "\\") token += "\\";
          token += next;
          i += 2;
        } else {
          token += ch;
          i += 1;
        }
        continue;
      }
      if (WHITESPACE.includes(ch)) break;
      if (ch === "'") {
        single = true;
        i += 1;
      } else if (ch === '"') {
        double = true;
        i += 1;
      } else if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) return null;
        // outside quotes the backslash escapes any character — including a
        // newline, which Python's shlex KEEPS rather than reading as a
        // continuation (there is no `\`-newline rule in shlex)
        token += next;
        i += 2;
      } else {
        token += ch;
        i += 1;
      }
    }
    if (single || double) return null;
    out.push(token);
  }
  return out;
}

// ---- the evaluator --------------------------------------------------------

// `_parse_args`: a payload that is not a JSON object judges as no arguments.
function parseArgs(repr) {
  try {
    const parsed = JSON.parse(String(repr));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Sort helper: Python sorts the string forms of the paths it found.
function sortedStrings(paths) {
  return [...paths].sort();
}

function createEvaluator(rules = DEFAULT_RULES) {
  const table = Array.isArray(rules) ? rules : [...DEFAULT_RULES];

  // allow | ask | deny for one call. `argsRepr` is the model's raw JSON text, as
  // the loop holds it; `access`/`arg` come from the tool's own declaration.
  //
  // Async for one reason only: an escape rule's verdict needs the escape set, and
  // the escape set needs the far user's home (`~`). The decision table itself is
  // pure.
  async function evaluate(argsRepr, workspace, access, arg = "") {
    // Judge the guarded argument (the command, the path) rather than the whole
    // JSON: content is data, not a path, and must never prompt a write it does
    // not touch. WHICH argument that is comes from the declaration.
    const key = arg || GUARDED_ARG[access] || "";
    let guarded = argsRepr;
    if (key) {
      const value = parseArgs(argsRepr)[key];
      if (value !== undefined && value !== null) guarded = value;
    }
    // last matching rule wins
    let decision = null;
    for (const rule of table) {
      if (matches(rule, guarded, access)) decision = rule;
    }
    if (decision === null) return "allow";
    if (decision.escape && !(await escapedPaths(argsRepr, workspace, access, arg)).size) return "allow";
    return decision.action;
  }

  // Resolved absolute paths outside the workspace root this call references.
  //
  // Async where the Python is sync, and only because `~` needs the far user's home
  // (one cached `echo $HOME`, fs.js `home()`); everything else is lexical.
  async function escapedPaths(argsRepr, workspace, access, arg = "") {
    if (!(access in GUARDED_ARG)) return new Set();
    const args = parseArgs(argsRepr);
    let tokens;
    if (access === "command") {
      // the flavor of the shell that will RUN the text: the far side is always
      // POSIX (plan §0), so this is shlex, never the cmd lexer
      tokens = splitCommand(String(args.command || "").trim());
      if (tokens === null) return new Set();
    } else {
      const path = args[arg || GUARDED_ARG[access] || ""];
      if (path === undefined || path === null) return new Set();
      tokens = [path];
    }

    const out = new Set();
    if (access === "command") {
      // track `cd <dir>` so a following `../` is judged against that subdir
      let cwd = null; // null => anchor at the workspace root
      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === "cd" && i + 1 < tokens.length) {
          let next = tokens[i + 1];
          if (next.startsWith("~")) {
            // workspace.home(), not expanduser: `~` is the REMOTE user's home
            next = String(await workspace.home()) + next.slice(1);
          }
          const base = cwd !== null ? cwd : workspace.realpath(workspace.root);
          cwd = workspace.normJoin(String(base), shellPath(next));
          i += 2;
          continue;
        }
        const path = await workspace.escapePath(shellPath(tok), cwd);
        if (path !== null && path !== undefined) out.add(String(path));
        i += 1;
      }
    } else {
      for (const tok of tokens) {
        const path = await workspace.escapePath(tok);
        if (path !== null && path !== undefined) out.add(String(path));
      }
    }
    return out;
  }

  return { rules: table, evaluate, escapedPaths };
}

// `Workspace.shell_path` is the Windows + Git Bash translation of the POSIX
// scratch spellings; on this host the far side IS POSIX, so it is the identity.
// Kept as a named function so the call sites read like the Python's.
function shellPath(token) {
  return token;
}

// ---- the gate -------------------------------------------------------------

// How often a waiting ask re-checks that a UI is still attached, and how long the
// UI must be GONE before the ask is given up on. The grace is the point: an
// EventSource retry or a tunnel redial drops the SSE subscriber for a few seconds
// while the renderer's dialog is still on screen — a gap must not deny a prompt
// the user is about to answer. The same grace covers the moment the prompt is
// HANDED OVER (a subscriber count of zero is a fact about one instant).
const ATTACH_POLL_S = 1.0;
const DETACH_GRACE_S = 30.0;
// How often a waiting ask is re-announced to the UI: what arrives once can be
// lost forever, and what is lost leaves the run blocked on a prompt nobody saw.
const REANNOUNCE_S = 15.0;
// Trust mode: the seconds an armed prompt waits before answering itself with
// allow. The countdown lives HERE, in the gate; the renderer's own timer is
// display (ui/js/permissions.js TRUST_COUNTDOWN_S is the same number).
const TRUST_COUNTDOWN_S = 10.0;

// The loop's `permission_required` error: what the model reads is `.reason`, and
// the run loop turns it into an error envelope without ever running the tool
// (`core/permission.py: PermissionRequired`).
class PermissionRequired extends Error {
  constructor(requestId, tool, argsRepr, reason) {
    super(reason);
    this.name = "PermissionRequired";
    this.code = "permission_required";
    this.requestId = requestId;
    this.tool = tool;
    this.argsRepr = argsRepr;
    this.reason = reason;
  }
}

const NO_UI = "no user interface connected to confirm this action";

// Request ids are unique for the LIFE OF THE PROCESS, not just inside one gate
// (a gate is built per run): an id is the only thing a window has to tell "the
// ask I just answered" from "a new ask", and the renderer remembers the ids it
// answered for as long as the page lives.
let askCounter = 0;
const PROCESS_TAG = crypto.randomBytes(4).toString("hex");

const now = () => Date.now() / 1000;

// setTimeout that does not keep the process alive: a pending ask is state, not a
// reason for the host to stay up on its own.
function delay(seconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

// `onAsk(requestId, tool, argsRepr, reason)` -> nothing to block, `false` when no
// UI is attached to confirm (the gate then denies after the grace instead of
// hanging), or a promise of either.
function createGate(options = {}) {
  const evaluator = options.evaluator || createEvaluator();
  const onAsk = typeof options.onAsk === "function" ? options.onAsk : null;
  const autoAllow = Boolean(options.autoAllow);
  // is a UI that can answer still there? null = no probe (the wait is the plain
  // blocking one)
  const isAttached = typeof options.isAttached === "function" ? options.isAttached : null;
  const detachGraceS = numberOr(options.detachGraceS, DETACH_GRACE_S);
  const attachPollS = numberOr(options.attachPollS, ATTACH_POLL_S);
  const reannounceS = numberOr(options.reannounceS, REANNOUNCE_S);
  // trust mode: while this reads true an ask answers itself with allow after
  // `trustS`; null = the mode does not exist on this host
  const trust = typeof options.trust === "function" ? options.trust : null;
  const trustS = numberOr(options.trustS, TRUST_COUNTDOWN_S);

  const pending = new Map(); // requestId -> {done, resolve, tool, argsRepr, reason}
  const decisions = new Map(); // requestId -> boolean

  // Raise PermissionRequired if the user must confirm (or deny).
  //
  // `tool` is only what the prompt calls the call; the POLICY reads `access` and
  // `arg`. Approved escapes are recorded on the workspace for the one call;
  // autoAllow (unattended) denies escapes rather than silently opening the
  // sandbox.
  async function require(tool, argsRepr, workspace, access, arg = "") {
    const action = await evaluator.evaluate(argsRepr, workspace, access, arg);
    const escapes = await evaluator.escapedPaths(argsRepr, workspace, access, arg);
    const escaped = sortedStrings(escapes);
    if (action === "deny") throw new PermissionRequired("", tool, argsRepr, "denied by permission rules");
    if (action === "allow" && escaped.length === 0) return;
    let reason;
    if (escaped.length) {
      reason = `access outside the workspace: ${escaped.join(", ")}`;
    } else {
      // no args here: the UI renders args_repr in a dedicated args box, and the
      // tool is already in the dialog's "Tool:" header
      reason = `permission ${action}`;
    }
    if (autoAllow) {
      if (escaped.length) throw new PermissionRequired("", tool, argsRepr, "sandbox escape requires user approval");
      return; // non-escape rule ask auto-allowed (eval harness behavior)
    }

    askCounter += 1;
    const requestId = `perm-${PROCESS_TAG}-${askCounter}`;
    let settled = false;
    let settle = () => {};
    const done = new Promise((finish) => {
      settle = (allow) => {
        settled = true;
        finish(allow);
      };
    });
    pending.set(requestId, { done, settle, tool, argsRepr, reason });
    decisions.set(requestId, false);

    // the same ask again, under the same request_id: a window that missed the
    // first publish (a reload mid-ask, a reconnect, a renderer still
    // reconstructing history) finally sees the prompt
    const remind = () => {
      onAsk(requestId, tool, argsRepr, reason);
    };

    let unattachedSince = null;
    try {
      if (onAsk) {
        const answer = await onAsk(requestId, tool, argsRepr, reason);
        if (answer === false) {
          // nobody to publish to right now. With no probe the refusal is final;
          // WITH one it is not a verdict — the zero it reads is a fact about one
          // instant — so it only starts the clock.
          if (isAttached === null) throw new PermissionRequired(requestId, tool, argsRepr, NO_UI);
          unattachedSince = now();
        }
      }
      const answered = await awaitDecision({
        done,
        isSettled: () => settled,
        remind: onAsk ? remind : null,
        goneSince: unattachedSince,
        requestId,
      });
      if (!answered) throw new PermissionRequired(requestId, tool, argsRepr, NO_UI);
      const allowed = Boolean(decisions.get(requestId));
      if (!allowed) throw new PermissionRequired(requestId, tool, argsRepr, "denied by user");
      workspace.allow(escapes);
    } finally {
      pending.delete(requestId);
      decisions.delete(requestId);
    }
  }

  // Wait for the user's answer; false when the audience is gone for good.
  //
  // No timeout while a UI is attached: the prompt stays up until the user
  // confirms, however long that takes. What must NOT be waited out is a UI that
  // is gone. This loop is also where trust mode counts down — on this side, which
  // is the side that keeps running when the page does not (Android freezes the
  // WebView and its timers with it).
  async function awaitDecision({ done, isSettled, remind, goneSince, requestId }) {
    let announced = now();
    let trustDeadline = trust !== null && requestId && trust() ? now() + trustS : null;
    for (;;) {
      if (isSettled()) return true;
      const answered = await Promise.race([done.then(() => true), delay(attachPollS).then(() => false)]);
      if (answered) return true;
      const t = now();
      if (trust !== null && requestId) {
        if (trust()) {
          if (trustDeadline === null) trustDeadline = t + trustS;
          else if (t >= trustDeadline) {
            resolve(requestId, true);
            return true;
          }
        } else {
          trustDeadline = null; // disarming cancels the clock
        }
      }
      if (remind && t - announced >= reannounceS) {
        announced = t;
        try {
          remind();
        } catch (e) {
          // a reminder never ends the wait
        }
      }
      if (isAttached === null) continue;
      if (isAttached()) {
        goneSince = null;
        continue;
      }
      if (goneSince === null) {
        goneSince = t;
      } else if (t - goneSince >= detachGraceS) {
        return false;
      }
    }
  }

  // Called by the server when the UI responds. True if the ask was still waiting:
  // a resolved ask leaves `pending` at once, so it is never re-announced again
  // (the decision stays until `require` reads it on its way out).
  function resolve(requestId, allow) {
    const ask = pending.get(requestId);
    if (!ask) return false;
    pending.delete(requestId);
    decisions.set(requestId, Boolean(allow));
    ask.settle(Boolean(allow));
    return true;
  }

  function pendingIds() {
    return [...pending.keys()];
  }

  // Every prompt still waiting: (requestId, tool, argsRepr, reason) — what a
  // (re)connecting window is owed the moment its stream opens (an ask is STATE
  // while it waits, not a frame that was sent once).
  function pendingAsks() {
    return [...pending.entries()].map(([id, ask]) => [id, ask.tool, ask.argsRepr, ask.reason]);
  }

  return {
    evaluator,
    require,
    resolve,
    pendingIds,
    pendingAsks,
    get autoAllow() {
      return autoAllow;
    },
  };
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

module.exports = {
  GUARDED_ARG,
  DEFAULT_RULES,
  Rule,
  splitCommand,
  shellPath,
  parseArgs,
  createEvaluator,
  createGate,
  PermissionRequired,
  ATTACH_POLL_S,
  DETACH_GRACE_S,
  REANNOUNCE_S,
  TRUST_COUNTDOWN_S,
};
