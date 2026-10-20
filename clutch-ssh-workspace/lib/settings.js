// Every environment name this plugin reads, in one place.
//
// Three of them are the HOST's to set (ui/plugin-host.js hands them to the child
// at every call, SSH_WORKSPACE_PLAN.md C9.1) and two are the operator's, for the
// cases the host cannot know: where the workspace root is on that machine, and
// which interpreter to use there.

"use strict";

// the app's loopback exec bridge — "" means no tunnel, so no far side at all.
const BRIDGE_ENV = "CLUTCH_EXEC_BRIDGE";
// how a single far-side command may be before it must be chunked, and how much
// one chunk may carry. Handed down from ui/transport_defaults.json through the
// host, so the plugin never invents a number the sshd does not agree with.
const CHUNK_ENV = "CLUTCH_EXEC_CHUNK_BYTES";
const MAX_ENV = "CLUTCH_EXEC_MAX_COMMAND_BYTES";
// the far side's workspace root (default: that machine's login home — the root
// a degraded ssh session is started on, ui/js/backend-lifecycle.js).
const ROOT_ENV = "CLUTCH_SSH_WORKSPACE";
// the far side's interpreter (default: python3).
const PYTHON_ENV = "CLUTCH_SSH_PYTHON";
// this plugin's own deadline for one far-side command (default 20 s, under the
// client's 30 s per-call kill).
const TIMEOUT_ENV = "CLUTCH_SSH_TIMEOUT_MS";

module.exports = { BRIDGE_ENV, CHUNK_ENV, MAX_ENV, ROOT_ENV, PYTHON_ENV, TIMEOUT_ENV };
