# clutch-ssh-workspace

The workspace's four file tools — `read_file`, `grep`, `write_file`, `edit_file` —
run on the machine that holds the workspace, over the ssh tunnel the client already
has open.

A **client plugin** (`interface: plugin`, `runs_on: other`, `subject: foreign-fs`).
It runs where the user sits and implements nothing itself: each call becomes one
`ssh exec` on the far side, running *that machine's* `clutch-workspace` component
(`python3 -m clutch_workspace --json <tool> …`). Line numbers, continuation hints,
unified diffs, `(no matches)` and the sysexits codes are that component's — one
implementation of the filesystem, on the machine that owns it. What lives in this
directory is argv translation, POSIX quoting, and a payload path past the one thing
an ssh exec channel does not have: stdin.

Why it exists: `agent/tools/catalog.py` has five `subject` words, and
`foreign-fs` — "the other machine's filesystem" — had no component until this one
(`SSH_WORKSPACE_PLAN.md`, `COMPONENTS.md` §二). Without it an ssh session can run
commands but cannot read, search or write files: the component behind those tools
(`clutch-workspace`, `workspace-fs`) serves only the machine the root is on, and
refuses the rest with a sentence.

## Install

Through the components page. `plugin` + `runs_on: other` places it in the **client**
domain (`%LOCALAPPDATA%\clutch\client` on Windows, `~/.clutch/client` elsewhere),
which is where a component that serves another machine belongs.

Two facts about the declaration, both deliberate:

- the declared name is `clutch-ssh-workspace`; the **tools keep their plain
  names**. The model's usage of `read_file`/`grep`/`write_file`/`edit_file` is
  already written in the system prompt, and an `ssh_` prefix would mean writing a
  second set of instructions for the same act.
- it declares `subject: foreign-fs` and no `launch`, and its interface forces
  `runs_on: other` (`catalog.component_diagnostics` treats `plugin` + `runs_on:
  self` as fatal: for the one interface whose implementation the host cannot see,
  "it runs here" is a claim with nothing behind it).

Far side requirements, checked at every call:

1. a `clutch-workspace` beside the workspace root (`<root>/clutch-workspace/`), or
   installed under `~/.clutch/components/clutch-workspace/<version>/` — the
   checkout wins, because it is the version the user is working on;
2. an interpreter: `python3` by default.

Neither is there? The call fails with a sentence naming what was looked for, and
never falls back to this machine.

## What the host hands it

`CLUTCH_EXEC_BRIDGE` — the loopback `http://127.0.0.1:<port>` address of the app's
exec bridge (`ui/exec-bridge.js`, `POST /exec` → `remoteExec`), set by
`ui/plugin-host.js` at every call, because the port only exists while a tunnel is
up. Empty means **there is no far side right now**, which is answered with a
sentence the model can act on — not a guess, not a timeout.

Also set at every call: `CLUTCH_EXEC_MAX_COMMAND_BYTES` and
`CLUTCH_EXEC_CHUNK_BYTES`, both from `ui/transport_defaults.json` (the same two
numbers the session's own exec path obeys). They are handed down rather than
rediscovered so the plugin cannot drift from sshd's own limit; a host that says
nothing gets the plugin's conservative defaults (4000 / 2000 bytes).

**Holding that address is holding an arbitrary shell on the other machine.** The
bridge is loopback with no token. That is consistent with client plugins being
trusted code the user installed (`ui/plugin-child.js`: the child has the app uid),
but it is worth stating plainly: this is not a read-only file tool, and nothing
here pretends to be a fence.

## Environment

| name | default | set by | meaning |
|---|---|---|---|
| `CLUTCH_EXEC_BRIDGE` | *(empty)* | the host, per call | where the far side is; empty = no tunnel |
| `CLUTCH_EXEC_MAX_COMMAND_BYTES` | `4000` | the host, per call | one far-side command's budget (ssh exec has no stdin) |
| `CLUTCH_EXEC_CHUNK_BYTES` | `2000` | the host, per call | how much one chunk of a payload may carry |
| `CLUTCH_SSH_WORKSPACE` | that machine's `$HOME` | the operator | the far side's workspace root (the root a degraded ssh session is started on, `ui/js/backend-lifecycle.js`) |
| `CLUTCH_SSH_PYTHON` | `python3` | the operator | the far side's interpreter |
| `CLUTCH_SSH_TIMEOUT_MS` | `20000` | the operator | this plugin's own deadline for one far-side command (under the client's 30 s per-call kill) |

## Differences from the local `clutch-workspace`

Same tools, same arguments, same `{content, error, diff}` envelope — with the
differences the shape of a plugin forces:

- **the diff is appended to the answer.** A plugin's answer is one string, and
  `write_file`'s content alone (`OK: wrote X (+1 -1 lines)`) would tell the model
  less than nothing about what it wrote. The envelope still carries the two
  fields; this plugin joins them with a blank line.
- **one process per call, no cache.** Every call is a fresh `ssh exec` in a fresh
  shell, so the far side is re-located (a couple of `stat`/`ls`) and no state
  crosses calls. That is the ABI the host chose — a call can be killed and cannot
  block the window — and the cost is recorded here rather than hidden behind
  global state.
- **payloads never ride in argv and never use a heredoc.** `write_file`'s content
  and `edit_file`'s two strings are base64'd here and decoded there
  (`"$PY" -m base64 -d > "$HOME/.clutch-ssh-workspace"/p-<token>.payload`), so a
  body with quotes, backticks, `$`, CRLF or **a missing trailing newline** arrives
  byte for byte. A heredoc would append the newline it is missing.
- **past the command budget the payload is chunked**: `mkdir -p … && : > b64`,
  N × `printf %s '<b64>' >> b64`, decode, then the tool — each step its own `ssh
  exec`, and the same command that uses the payload removes it. This mirrors
  what `agent/tools/workspace.py` (`RemoteWorkspace.write`) already does.
- **`edit_file` uses exactly one stdin flag.** Both strings inline is the cheapest
  form and is tried first; then the old string on stdin, then the new one. Two
  stdin flags would drain the same stream twice (`clutch_workspace/cli.py`), and a
  string that still overflows is refused in a sentence rather than truncated.
- **a far-side failure is an `ERROR: …` text with `error: true`**, including the
  far side's own words; a non-envelope answer is never mistaken for a result.
- **no fence.** See below.

## The fence (C9.5)

This plugin does not start a daemon on the far side; it uses that machine's CLI. A
daemon's fence is spawn-time policy handed down by the host (`rendezvous.py`), and
a fistful of globs computed by the host is not something a client plugin can
honestly reproduce. So, in phase 1:

- the **host-side** guards still apply — `guard_read` / `guard_write` wrap the tool
  call on the session side, before the plugin is ever reached;
- what is missing is the *inside-the-component* fence, exactly as with
  `scripts/ws-stopgap` before it: a write lands with that machine's own
  permissions and nothing finer.

Two routes to a fence exist and neither is taken here (see `SSH_WORKSPACE_PLAN.md`
Q3): extend `/call`'s body with a `fence` field (a contract change that deserves
its own decision), or move "start the daemon" back to the host (S1), which needs a
repackaged app and overlaps this component's job.

## Tests

```
node tests/ssh-workspace.test.js
```

A fake loopback `/exec` bridge records every command line and replays fixtures, so
the suite pins the argv shape of all four tools, the envelope passthrough, the
error mapping (66 / 74 / non-envelope / 503), the base64 chunking (64 KB written
and read back byte for byte) and the `CLUTCH_SSH_PYTHON` override — with no ssh,
no network and no real fork.
