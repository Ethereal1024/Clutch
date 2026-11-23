// The workspace whose files live on the FAR host.
//
// This is the deployment-B answer to `agent/tools/workspace.py`'s
// RemoteWorkspace + `agent/browsing.py`'s remote half: a root, path safety, the
// six file operations, and the two payloads the UI renders (the workspace tree
// and the project-picker directory listing). It never touches this machine's
// filesystem — every question about the far side is one exec — and it never
// answers about a LOCAL root: that would be a second implementation of what the
// Python host already does for deployments A and C (plan §7 X1).
//
// Three rules, inherited from RemoteWorkspace and worth repeating because each
// one was learned the hard way:
//
// - paths are POSIX and LEXICAL. `realpath` here is `posixpath.normpath`, not a
//   filesystem call: on the app host, resolving `/home/u/p` spelled it through
//   the local autofs layout (`/System/Volumes/Data/home/u/p`) and the project
//   write then ran `mkdir -p /System/...` on the Linux remote. Remote-side
//   symlinks are invisible from here, so containment is lexical too.
// - every exec starts a fresh shell in an unknown cwd, so file ops use ABSOLUTE
//   paths (nothing is remembered between calls) and `run()` states its own `cd`.
// - payloads never ride argv of a tool call: a write is a sequence of
//   `printf '%s'` chunks (a POSIX sh builtin, byte-exact, no base64 needed on a
//   host that may not have a base64 binary).
//
// One deliberate difference from the Python ssh path: the ORDER of a listing is
// the local host's rule (directories first, then names case-insensitively), not
// `ls` order. A/C have always rendered the tree in that order, and B renders the
// same UI, so the far-root host sorts like the near-root one instead of letting
// `ls` decide. (Python's remote walk sorted by code point, which put `sub/`
// after `gamma.txt` — the same project looked different depending on which
// machine served it.)
//
// createWorkspace({root, exec | transport, remoteRoot}) -> workspace

"use strict";

const { createExec, shq, utf8, snippet, EXEC_CHUNK_BYTES, EXEC_MAX_COMMAND_BYTES } = require("./exec");
const { createJournal } = require("./journal");

// generous per-op timeout for internal file ops (read/write/list/append)
const IO_TIMEOUT = 60;
// per-exec timeout for remote directory browsing (one ls / echo $HOME)
const FS_LIST_TIMEOUT = 30;
// never split a write finer than this, or the per-command overhead eats it
const MIN_CHUNK = 64;
// scratch dirs that are harmless to write to (test logs, /dev/null redirects)
const POSIX_SCRATCH_DIRS = ["/tmp", "/var/tmp", "/dev"];

// Thrown by resolve() for an unapproved escape — the same split Python makes by
// raising ValueError, so a caller can tell "you asked for outside the workspace"
// from "the far side failed". OSError/FileNotFoundError mirror the same split for
// the file operations (Python's exception names are the class names here on
// purpose: the port is a port, not a re-invention).
class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}

class FileNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

class OSError extends Error {
  constructor(message) {
    super(message);
    this.name = "OSError";
  }
}

// ---- POSIX path spells, all lexical --------------------------------------

// posixpath.normpath: collapse `.`, `..` and duplicate slashes without
// consulting any filesystem.
function normalise(value) {
  const text = String(value == null ? "" : value);
  const absolute = text.startsWith("/");
  const parts = [];
  for (const part of text.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const body = parts.join("/");
  if (absolute) return `/${body}`;
  return body || ".";
}

function dirname(path) {
  const text = String(path);
  const cut = text.lastIndexOf("/");
  if (cut < 0) return ".";
  if (cut === 0) return "/";
  return text.slice(0, cut);
}

function basename(path) {
  const text = String(path);
  const cut = text.lastIndexOf("/");
  return cut < 0 ? text : text.slice(cut + 1);
}

// PurePosixPath(base) / token: an absolute token REPLACES the base, which is
// what makes the journal's absolute paths (and a caller's `/etc/hosts` escape
// attempt) mean what they say.
function joinPath(base, token) {
  const part = String(token == null ? "" : token);
  if (part.startsWith("/")) return part;
  const head = String(base == null ? "" : base);
  if (!part) return head;
  return head.endsWith("/") ? `${head}${part}` : `${head}/${part}`;
}

// posix containment, one verdict shared by resolve() and escapePath().
function isInside(path, root) {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

function insideOrScratch(path, root, scratches) {
  if (isInside(path, root)) return true;
  for (const scratch of scratches) {
    if (isInside(path, scratch) && !isInside(root, scratch)) return true;
  }
  return false;
}

// Python's repr() for a plain string, which is the spelling the API's error
// message uses (`path escapes workspace: '../escape'`). Single quotes unless the
// text contains one and no double quote, exactly like repr.
function repr(value) {
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = "";
  for (const ch of text) {
    if (ch === "\\") body += "\\\\";
    else if (ch === quote) body += `\\${ch}`;
    else if (ch === "\n") body += "\\n";
    else if (ch === "\t") body += "\\t";
    else if (ch === "\r") body += "\\r";
    else body += ch;
  }
  return `${quote}${body}${quote}`;
}

// `ls -1AF` marks directories with "/", executables with "*", symlinks with "@";
// only the "/" is information here. Hidden filtering is deliberate NOT done here:
// one rule (below) applies it, so the picker and the tree cannot disagree.
function parseEntries(stdout) {
  const out = [];
  for (const line of String(stdout == null ? "" : stdout).split("\n")) {
    if (!line) continue;
    if (line.endsWith("/")) {
      out.push({ name: line.slice(0, -1), isDir: true });
      continue;
    }
    out.push({ name: "*@=|".includes(line[line.length - 1]) ? line.slice(0, -1) : line, isDir: false });
  }
  return out;
}

// `show_hidden or not name.startswith(".")` — the one hidden-item policy:
// with the toggle off NOTHING dot-prefixed is listed, file or directory.
function visible(name, showHidden) {
  return Boolean(showHidden) || !String(name).startsWith(".");
}

// `agent/browsing.py: valid_name` — why `name` cannot be ONE file or folder
// name, or null when it can. One policy for the picker's create row and mkdir,
// so what the UI accepts is exactly what the host accepts: one path segment, no
// separator, no control character (a newline would end an `ls -1` line early and
// split one remote entry into two), and neither "." nor "..".
function validName(name) {
  const text = String(name == null ? "" : name);
  if (!text.trim()) return "a name is required";
  if (text === "." || text === "..") return "that name is reserved";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "/" || ch === "\\" || ch === "\u0000" || code < 32 || code === 127) {
      return "a name cannot contain a path separator or a control character";
    }
  }
  return null;
}

// The listing order A/C have always used: directories first, then by lowercased
// name. The final code-point tiebreak is this port's own (Python's sort was
// stable over the OS's arbitrary iteration order, so `Alpha` vs `alpha` was
// never specified; B states it).
//
// The same comparator orders two shapes: a parser entry (`{name, isDir}`) and a
// tree node (`{name, dir, path, link}`). Reading only one of the two spellings
// silently sorted FILES FIRST — a defect the tree goldens caught, which is what
// they are for.
function isDirectoryEntry(entry) {
  return entry.isDir === undefined ? Boolean(entry.dir) : Boolean(entry.isDir);
}

function compareEntries(left, right) {
  const leftDir = isDirectoryEntry(left);
  const rightDir = isDirectoryEntry(right);
  if (leftDir !== rightDir) return leftDir ? -1 : 1;
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

// ---- the workspace ------------------------------------------------------

function shellOf(options) {
  if (options.exec && typeof options.exec.run === "function") return options.exec;
  return createExec(options.exec || options.transport);
}

// The directory browser the project picker talks to. It deliberately does NOT
// need a workspace: picking a project is what creates one, so requiring a root
// here would leave the picker with nothing to browse. It shares the exec seam
// with whatever workspace the host builds, so `echo $HOME` is asked once and the
// picker and the tree agree on where the session starts.
function createBrowser(options = {}) {
  const shell = shellOf(options);
  let remoteHome = null;
  // the root the picker starts from once a project is open; null before that,
  // when the far user's home is the only sensible place to start
  let remoteRoot = options.remoteRoot ? normalise(options.remoteRoot) : null;

  // The home a leading `~` expands to: the REMOTE user's home, cached for the
  // life of this host (one exec). On failure the literal `~` — a path that reads
  // as an escape and asks the user, never one that silently maps a remote path
  // onto this machine.
  async function home() {
    if (remoteHome === null) {
      const answer = await shell.run("echo $HOME", { timeout: IO_TIMEOUT });
      remoteHome = answer.code === 0 && answer.stdout.trim() ? answer.stdout.trim() : "~";
    }
    return remoteHome;
  }

  // The directory a picker request names: empty = the browse root, absolute =
  // as spelled, relative = under the root, and a leading `~` expanded by the
  // remote's own shell (one cached echo). Shared by the listing and by mkdir so
  // a folder created from what is on screen lands in exactly that directory.
  async function dirFor(raw) {
    const base = remoteRoot || (await home());
    let target;
    if (raw) target = String(raw).startsWith("/") ? normalise(String(raw).replace(/\\/g, "/")) : realpath(`${base}/${raw}`);
    else target = base;
    if (target === "~" || target.startsWith("~/")) {
      const at = await home();
      target = target === "~" ? at : at + target.slice(1);
    }
    return target;
  }

  // One-level directory listing. The payload envelope is built in exactly one
  // place (here) so a listing cannot drift from the tree.
  async function fsList(raw = "", showHidden = false) {
    const target = await dirFor(raw);
    // `test -d` first: `ls` on a FILE exits 0 and prints the name, which would
    // render a file as a one-entry directory. The local host answers this case
    // with its own is_dir() guard; the two hosts must agree on the answer.
    const command = `if test -d ${shq(target)}; then ls -1AF ${shq(target)}; else exit 3; fi`;
    const answer = await shell.run(command, { timeout: FS_LIST_TIMEOUT });
    if (answer.code !== 0) return { error: `not a directory: ${target}` };
    const entries = parseEntries(answer.stdout)
      .filter((entry) => visible(entry.name, showHidden))
      .sort(compareEntries)
      .map((entry) => ({
        name: entry.name,
        path: `${target.replace(/\/$/, "")}/${entry.name}`,
        dir: entry.isDir,
        // link targets would need one readlink exec per symlink; the tree leaves
        // them null too, and the UI only labels them
        link: null,
      }));
    return {
      path: target,
      parent: target === "/" ? null : dirname(target),
      entries,
      error: null,
    };
  }

  function realpath(path) {
    return normalise(String(path).replace(/\\/g, "/"));
  }

  // ---- the picker's write side: one folder ----

  // Create ONE folder inside the directory on screen. `mkdir` without `-p` is
  // the point, not an accident: the browser names a directory that is visible,
  // so a missing parent is a stale listing, not an instruction to build a tree.
  // A name already taken is an ANSWER (`{path, error}`) and not a throw — the
  // create row shows the sentence in place and the picker stays usable.
  async function fsMkdir(rawDir = "", name = "") {
    const reason = validName(name);
    if (reason !== null) return { path: null, error: reason };
    const parent = await dirFor(rawDir);
    const target = `${parent.replace(/\/$/, "")}/${name}`;
    const answer = await shell.run(`mkdir ${shq(target)}`, { timeout: FS_LIST_TIMEOUT });
    if (answer.code === 0) return { path: target, error: null };
    // busybox/GNU/BSD all say "File exists" for the one case the UI words
    // itself; anything else is the remote's own sentence, passed through
    const msg = String(answer.stderr || answer.stdout || "").trim();
    if (msg.toLowerCase().includes("exists")) return { path: target, error: `already exists: ${name}` };
    const lines = msg.split("\n").filter((line) => line.trim());
    return { path: target, error: lines.length ? lines[lines.length - 1] : "cannot create folder" };
  }

  // Stat a path: does it exist, and is it a directory, a file, or nothing?
  // The UI uses this to route an address-bar input: a directory → navigate,
  // a .clc file → open, absent → offer to create. One `test` pipeline so the
  // round trip is a single exec.
  async function fsStat(raw = "") {
    const target = await dirFor(raw);
    // test -d → directory; test -f → regular file; else → absent (or special)
    const answer = await shell.run(
      `if test -d ${shq(target)}; then echo dir; elif test -f ${shq(target)}; then echo file; else echo none; fi`,
      { timeout: FS_LIST_TIMEOUT }
    );
    const kind = answer.code === 0 ? String(answer.stdout).trim() : "none";
    return { path: target, type: kind === "dir" || kind === "file" ? kind : "none", error: null };
  }

  return {
    shell,
    home,
    fsList,
    fsMkdir,
    fsStat,
    exec: shell.run,
    get remoteRoot() {
      return remoteRoot;
    },
    set remoteRoot(value) {
      remoteRoot = value ? normalise(value) : null;
    },
  };
}

function createWorkspace(options = {}) {
  const root = normalise(options.root);
  const browser = options.browser || createBrowser(options);
  const shell = browser.shell;
  const { max: maxCommandBytes, chunk: chunkBytes } = shell.limits || {
    max: EXEC_MAX_COMMAND_BYTES,
    chunk: EXEC_CHUNK_BYTES,
  };

  // absolute paths outside the root the CURRENT tool call may touch; granted by
  // the permission gate, cleared after every tool call
  let allowedEscapes = new Set();

  const scratchDirs = () => POSIX_SCRATCH_DIRS.map(normalise);

  // LEXICAL normalization only — never a local filesystem call. See the header.
  function realpath(path) {
    return normalise(String(path).replace(/\\/g, "/"));
  }

  async function resolve(relPath) {
    const at = realpath(root);
    const base = joinPath(at, relPath);
    const name = basename(base);
    let path;
    try {
      path = name ? joinPath(realpath(dirname(base)), name) : realpath(base);
    } catch (error) {
      path = realpath(base);
    }
    if (allowedEscapes.has(path) || insideOrScratch(path, at, scratchDirs())) return path;
    throw new ValueError(`path escapes workspace: ${repr(relPath)}`);
  }

  // The same browser the picker uses: one `echo $HOME`, one notion of where the
  // session starts.
  const home = () => browser.home();

  // Lexical base+token join for escape verdicts and the `cd` tracker.
  function normJoin(base, token) {
    return normalise(joinPath(String(base), String(token)));
  }

  // The absolute path a shell token denotes OUTSIDE the workspace, or null when
  // it stays inside (or in a harmless scratch dir). `anchor` is the directory
  // the token is relative to — the root by default, or the `cd`'d dir.
  async function escapePath(token, anchor = null) {
    if (!token) return null;
    let text = String(token);
    if (text.startsWith("~")) text = String(await home()) + text.slice(1);
    const base = anchor === null || anchor === undefined ? root : String(anchor);
    const at = realpath(root);
    const path = normJoin(base, text);
    if (insideOrScratch(path, at, scratchDirs())) return null;
    return path;
  }

  function allow(paths) {
    for (const path of paths || []) allowedEscapes.add(realpath(String(path)));
  }

  function clearAllowed() {
    allowedEscapes = new Set();
  }

  // ---- reads -------------------------------------------------------------

  async function read(path) {
    const at = await resolve(path);
    const answer = await shell.run(`cat ${shq(at)}`, { timeout: IO_TIMEOUT });
    if (answer.code !== 0) throw new FileNotFoundError(String(at));
    return answer.stdout;
  }

  // Byte range [lo, hi) as RAW bytes. The channel's binary mode base64-encodes
  // the slice CLIENT-side, so every byte round-trips even when the range cuts
  // mid-multibyte-character — and the far side needs no base64 (just tail/head).
  async function readRange(path, lo, hi) {
    const at = await resolve(path);
    const from = Math.trunc(Number(lo));
    const count = Math.trunc(Number(hi)) - from;
    const answer = await shell.run(`tail -c +${from + 1} ${shq(at)} | head -c ${count}`, {
      timeout: IO_TIMEOUT,
      binary: true,
    });
    ensureOk(answer, `cannot read ${at}`);
    return answer.bytes;
  }

  // Total size in bytes: `wc -c` stats a regular file (O(1)), no content moves.
  async function size(path) {
    const at = await resolve(path);
    const answer = await shell.run(`wc -c < ${shq(at)}`, { timeout: IO_TIMEOUT });
    if (answer.code !== 0) throw new FileNotFoundError(String(at));
    const total = Number(answer.stdout.trim());
    if (!Number.isFinite(total)) throw new FileNotFoundError(String(at));
    return Math.trunc(total);
  }

  // ---- writes ------------------------------------------------------------

  // A failed exec becomes the OSError the tool face shows the model, carrying the
  // far shell's own words (stderr first: it is the far side's own complaint).
  // `what` is the verb phrase (`cannot delete /p/x`); the exit code and the
  // snippet are appended the same way at every call site, so they are appended in
  // one place.
  function ensureOk(answer, what) {
    if (answer.code !== 0) {
      throw new OSError(`${what} (exit ${answer.code}): ${snippet(answer && (answer.stderr || answer.stdout))}`);
    }
    return answer;
  }

  // Split into pieces whose ON-WIRE size (after quoting) stays under the
  // channel's chunk limit. A single quote inflates to the 4-char sequence '\''
  // in the command, so it is budgeted at 4; multibyte chars are never split
  // mid-character.
  function chunkContent(content, budget) {
    const chunks = [];
    let current = [];
    let used = 0; // on-wire bytes in `current`
    for (const ch of String(content)) {
      const cost = ch === "'" ? 4 : utf8(ch);
      if (current.length && used + cost > budget) {
        chunks.push(current.join(""));
        current = [];
        used = 0;
      }
      current.push(ch);
      used += cost;
    }
    if (current.length) chunks.push(current.join(""));
    return chunks;
  }

  // Write/append via one small `printf '%s'` per chunk: printf is a POSIX sh
  // builtin, `%s` emits its argument byte for byte with no added newline, so
  // chunks can be cut anywhere and the file stays byte-exact. The last chunk
  // optionally uses `%s\n` to restore a JSONL terminator.
  async function execAppend(path, content, { firstOp, trailingNewline = false, ensureDir = false }) {
    const target = shq(path);
    const mkdir = ensureDir ? `mkdir -p ${shq(dirname(path))} && ` : "";
    const tail = ` ${firstOp} ${target}`;
    // the prefix of the first command is longer (it carries the mkdir), so it
    // sets the budget every later chunk is measured against
    const overhead = utf8(`printf '%s\\n' `) + 2 + utf8(tail) + utf8(mkdir);
    const budget = Math.max(
      MIN_CHUNK,
      Math.min(chunkBytes, Math.max(MIN_CHUNK, maxCommandBytes - overhead))
    );
    const chunks = chunkContent(content, budget);
    if (!chunks.length) chunks.push(""); // an empty body still truncates the file
    for (let at = 0; at < chunks.length; at += 1) {
      const first = at === 0;
      const format = trailingNewline && at === chunks.length - 1 ? "%s\\n" : "%s";
      const command = `${first ? mkdir : ""}printf '${format}' ${shq(chunks[at])} ${first ? firstOp : ">>"} ${target}`;
      const answer = await shell.run(command, { timeout: IO_TIMEOUT });
      ensureOk(answer, "write failed");
    }
  }

  async function write(path, content) {
    const at = await resolve(path);
    await execAppend(at, content, { firstOp: ">", ensureDir: true });
  }

  // One LF terminator per line, like the remote `printf '%s\n'` shape: the .clc
  // JSONL offsets count exactly one newline byte per event.
  async function appendLine(path, line) {
    const at = await resolve(path);
    await execAppend(at, line, { firstOp: ">>", trailingNewline: true });
  }

  // In-place overwrite at a byte offset (the .clc memory index header line). The
  // bytes travel as POSIX octal escapes through `printf %b` (a sh builtin — the
  // far side needs no base64); `dd conv=notrunc` writes over the range without
  // truncating the file or touching anything past it.
  async function writeAt(path, offset, data) {
    const at = await resolve(path);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const octal = [...raw].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
    const command = `printf '%b' '${octal}' | dd of=${shq(at)} bs=1 seek=${Math.trunc(Number(offset))} conv=notrunc`;
    const answer = await shell.run(command, { timeout: IO_TIMEOUT });
    ensureOk(answer, `cannot write_at ${at}`);
  }

  // `rm -f`: a path that is already gone is NOT an error — the rollback that
  // un-creates a file must survive the user having deleted it by hand.
  async function deleteFile(path) {
    const at = await resolve(path);
    const answer = await shell.run(`rm -f ${shq(at)}`, { timeout: IO_TIMEOUT });
    ensureOk(answer, `cannot delete ${at}`);
  }

  // ---- listings ----------------------------------------------------------

  // `ls -1AF` output -> the names this workspace is willing to show, in the
  // render order above. Protected files (the .clc) are dropped here, which is
  // the ONE place that knows a name is hidden from the agent; protected
  // DIRECTORIES stay listed (the agent sees the dir, cannot read inside it).
  // `base` is the directory that was listed: the protected set is keyed by
  // absolute path, so a file called `demo.clc` three levels down must not be
  // filtered because the project's own `demo.clc` is.
  function listing(entries, base) {
    const out = [];
    for (const entry of entries) {
      if (!entry.isDir && bookkeeping.isProtected(joinPath(realpath(base), entry.name))) continue;
      out.push(entry);
    }
    return out.sort(compareEntries);
  }

  // list several directories in ONE exec (one round trip); missing/non-dir paths
  // map to []. The tree walk depends on this: without it a whole level costs one
  // exec per directory, which is the difference between ~depth round trips and
  // one per folder (plan §3 P1 — the only real capability gap in the JS port).
  async function listMany(paths) {
    const keyed = [];
    for (const rel of paths || []) keyed.push({ rel: String(rel), path: await resolve(rel) });
    const result = {};
    for (const item of keyed) result[item.rel] = [];
    if (!keyed.length) return result;

    const marker = `CLUTCH_LIST_${Date.now().toString(36)}_${(listMany.calls = (listMany.calls || 0) + 1)}`;
    const groups = [];
    let current = [];
    let currentItems = [];
    const flush = () => {
      if (!current.length) return;
      // keep each exec under the sshd's command-size limit, with room for shell
      groups.push({ items: currentItems, command: current.join("; ") });
      current = [];
      currentItems = [];
    };
    keyed.forEach((item) => {
      // The tag is the item's index INSIDE its group, because the parser below
      // looks the reply up in `group.items`. A GLOBAL index looked right while a
      // level fit in one exec and silently dropped every later group's entries
      // (the first group's local index equals the global one) — `tests/
      // host-remote-path.test.js` splits a 60-directory level to pin this.
      const build = (tag) =>
        `if test -d ${shq(item.path)}; then echo '${tag}'; ls -1AF ${shq(item.path)}; else echo '${tag}:MISSING'; fi`;
      // the fragment is measured with a same-length placeholder, then tagged:
      // the tag has to wait for the flush decision above it
      const projected = current.reduce((sum, one) => sum + utf8(one) + 2, 0) + utf8(build(`${marker}_00`));
      if (current.length && projected > maxCommandBytes - 200) flush();
      const tag = `${marker}_${currentItems.length}`;
      current.push(build(tag));
      currentItems.push({ ...item, tag });
    });
    flush();

    for (const group of groups) {
      const answer = await shell.run(group.command, { timeout: IO_TIMEOUT });
      ensureOk(answer, "list failed");
      const raw = {};
      let active = null;
      for (const line of answer.stdout.split("\n")) {
        if (!line) continue;
        if (line.startsWith(marker)) {
          const at = Number(line.slice(marker.length + 1).split(":", 1)[0]);
          active = Number.isInteger(at) && group.items[at] ? group.items[at].rel : null;
          continue;
        }
        if (active === null) continue;
        raw[active] = raw[active] || [];
        raw[active].push(line);
      }
      for (const item of group.items) {
        const entries = listing(parseEntries((raw[item.rel] || []).join("\n")), item.path);
        result[item.rel] = entries.map((entry) => (entry.isDir ? `${entry.name}/` : entry.name));
      }
    }
    return result;
  }

  // The directories one walk lists, root first: "" plus the expanded paths that
  // are plain relative paths under an expanded parent. Mirrors the Python host
  // (agent/browsing.py: `_expanded_dirs`), because both answer the same golden.
  // A path that is absolute, climbs out with `..`, or sits under a dir the panel
  // is not showing is dropped: the tree only hangs a listing under a parent node
  // it discovered, so such a path could never be rendered — and it would
  // otherwise be handed to `ls`.
  function expandedDirs(expanded) {
    const wanted = new Set();
    for (const raw of expanded || []) {
      const text = String(raw)
        .replace(/\\/g, "/")
        .trim();
      if (!text || text.startsWith("/") || text.split("/")[0].includes(":")) continue;
      const parts = text.split("/").filter((p) => p !== "" && p !== ".");
      if (!parts.length || parts.includes("..")) continue;
      wanted.add(parts.join("/"));
    }
    const depth = (rel) => rel.split("/").length - 1;
    // shallow first: a parent's node exists before its children are attached
    return [""].concat(
      [...wanted]
        .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
        .filter((rel) => {
          const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
          return parent === "" || wanted.has(parent);
        }),
    );
  }

  // The whole walk in ONE round trip. The directories to list are known before
  // the first exec — the root plus the dirs the reader has OPEN — so `listMany`
  // batches them; there used to be a walk of one level per exec, and level N's
  // command could not even be built until level N-1's names came back (on the
  // tunnel that is 0.3–0.9 s per level). Nothing else is read: with no lookahead
  // an opened dir's children arrive on the walk its toggle asks for at once
  // (workspace-panel.ts: `scheduleTreeRefresh(0)`).
  async function tree(expanded = [], showHidden = false) {
    const dirs = expandedDirs(expanded);
    const listed = await listMany(dirs); // the whole tree, one round trip
    const children = new Map();
    const byPath = new Map();
    for (const rel of dirs) {
      // depth order: a parent's node exists when its children attach
      const out = [];
      for (const entry of parseEntries((listed[rel] || []).join("\n"))) {
        if (!visible(entry.name, showHidden)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const node = { name: entry.name, path: childRel, dir: entry.isDir, link: null };
        out.push(node);
        if (entry.isDir) byPath.set(childRel, node);
      }
      children.set(rel, out.sort(compareEntries));
    }
    // attach each listed level under its parent dir node
    for (const [rel, out] of children) {
      if (rel === "") continue;
      const parent = byPath.get(rel);
      if (parent) parent.children = out;
    }
    return children.get("") || [];
  }

  // ---- shell -------------------------------------------------------------

  // Run a command IN the workspace: every exec starts in an unknown cwd, so the
  // `cd` is stated here for the same semantics the local host gets by spawning
  // in its root.
  async function run(command, timeout = IO_TIMEOUT, overrides = {}) {
    return shell.run(`cd ${shq(root)} && ${command}`, { timeout, ...overrides });
  }

  const bookkeeping = createJournal({ realpath, write: (path, content) => write(path, content), delete: deleteFile });

  const workspace = {
    // identity
    root,
    // the picker shares this browser with the workspace: after a project opens
    // the picker must start from the project, not from the far user's home.
    // Both go through one cached `echo $HOME` and one listing envelope.
    get remoteRoot() {
      return browser.remoteRoot;
    },
    set remoteRoot(value) {
      browser.remoteRoot = value;
    },
    browser,
    // path safety
    realpath,
    resolve,
    escapePath,
    normJoin,
    home,
    allow,
    clearAllowed,
    // file operations
    read,
    readRange,
    size,
    write,
    appendLine,
    writeAt,
    delete: deleteFile,
    exec: shell.run,
    // listings
    listMany,
    tree,
    fsList: browser.fsList,
    // shell
    run,
    // bookkeeping (journal.js)
    ...bookkeeping,
  };
  return workspace;
}

module.exports = {
  createWorkspace,
  createBrowser,
  // path spells, exported so the conformance test asserts them directly
  normalise,
  dirname,
  basename,
  joinPath,
  isInside,
  insideOrScratch,
  parseEntries,
  compareEntries,
  visible,
  validName,
  repr,
  POSIX_SCRATCH_DIRS,
  IO_TIMEOUT,
  FS_LIST_TIMEOUT,
  ValueError,
  FileNotFoundError,
  OSError,
};
