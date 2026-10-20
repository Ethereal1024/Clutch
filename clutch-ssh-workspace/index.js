// The workspace's four file tools, executed on the machine that holds the
// workspace, over the client's ssh tunnel.
//
// The hole this fills: in an ssh session `run_command` works and `read_file` /
// `grep` / `write_file` / `edit_file` do not, because the component behind them
// (`clutch-workspace`, subject `workspace-fs`) only serves the machine the root
// is on, and the component for the other machine (`foreign-fs`) had never been
// written. SSH_WORKSPACE_PLAN.md is that specification; this directory is the
// implementation.
//
// ABI, exactly as every client plugin (ui/plugin-child.js):
//
//   exports.call = async (tool, args) => string | {content, error?}
//
// One forked process per call, so nothing here caches: every call asks the host
// for the bridge address again, because a tunnel that died a second ago has no
// far side and saying so is the answer.
//
// Errors are data, never throws. "No tunnel", "no component on the other
// machine", "the file is not there" are all ordinary states of the world the
// model should read and act on; a throw would reach the user as "the plugin
// failed", which says less.

"use strict";

const { bridgeAddress, runCommand, timeoutMs } = require("./lib/exec");
const { plan } = require("./lib/remote");

const TOOLS = Object.freeze(["read_file", "grep", "write_file", "edit_file"]);

const NO_BRIDGE =
  "this client has no exec bridge right now, so the far side of the workspace is out of reach: " +
  "the ssh tunnel to that machine is not up. Run the call again once the tunnel is connected.";

// The far side's answer is the CLI's own `--json` envelope on stdout: one line,
// {"content", "error", "diff"} (clutch_workspace/envelope.py). Anything printed
// before it (a python warning) is not the verdict, so the LAST line that reads
// as an envelope is the answer.
function envelopeOf(stdout) {
  const lines = String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[at]);
    } catch (e) {
      continue;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") return parsed;
  }
  return null;
}

// The envelope carries the diff BESIDE the content; a plugin's answer is one
// string. Appending it is the only way the model gets to see what a write did
// (`OK: wrote X (+1 -1 lines)` alone would tell it less than nothing).
function modelText(envelope) {
  const content = String(envelope.content || "");
  const diff = String(envelope.diff || "");
  const said = diff ? `${content}\n\n${diff}` : content;
  if (envelope.error) return said.startsWith("ERROR") ? said : `ERROR: ${said}`;
  return said;
}

function trimmed(value, cap = 600) {
  const text = String(value || "").trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

async function call(tool, args) {
  const name = String(tool || "");
  if (!TOOLS.includes(name)) {
    return {
      content: `ERROR: unknown tool ${JSON.stringify(name)}; this plugin publishes ${TOOLS.join(", ")}`,
      error: true,
    };
  }
  const input = args && typeof args === "object" ? args : {};

  const bridge = bridgeAddress();
  if (!bridge) return { content: `ERROR: ${NO_BRIDGE}`, error: true };

  const built = plan(name, input, process.env);
  if (built.error) return { content: `ERROR: ${built.error}`, error: true };

  const limit = timeoutMs();
  const steps = built.steps;
  try {
    for (let at = 0; at < steps.length; at += 1) {
      const last = at === steps.length - 1;
      const answer = await runCommand(bridge, steps[at], limit);
      if (!last) {
        // staging (a chunk, a decode): it either worked silently or nothing after
        // it is worth sending
        if (answer.code !== 0) {
          return {
            content: `ERROR: staging the payload on the far side failed (exit ${answer.code}): ${
              trimmed(answer.stderr || answer.stdout) || "nothing said"
            }`,
            error: true,
          };
        }
        continue;
      }
      const envelope = envelopeOf(answer.stdout);
      if (!envelope) {
        const said = trimmed(answer.stderr || answer.stdout) || "nothing said";
        return {
          content: `ERROR: the far side did not answer with a clutch-workspace envelope (exit ${answer.code}): ${said}`,
          error: true,
        };
      }
      if (!envelope.error && answer.code !== 0) {
        return {
          content: `ERROR: the far side reported success but exited ${answer.code}: ${modelText(envelope)}`,
          error: true,
        };
      }
      return { content: modelText(envelope), error: !!envelope.error };
    }
    return { content: "ERROR: this plugin built no command to run", error: true };
  } catch (e) {
    return { content: `ERROR: ${(e && e.message) || String(e)}`, error: true };
  }
}

module.exports = { call, TOOLS, envelopeOf, modelText };
