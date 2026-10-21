"""The channel to the client that runs part of this session's tool face.

A component whose `runs_on` is `other` does not run on this machine: its bytes,
its keys and its network belong to the CLIENT — the app the user is looking at.
The contract keeps that honest from both directions. This host never launches
such a component, and it never pretends it could (rendezvous.unavailable_reason
refuses every `other` before it asks the install layer, so "not installed" is
never said about the wrong thing). What used to be missing was the other half of
the sentence: a way for the client to say WHAT it runs and WHERE this session may
call it. That is this module.

It holds exactly one thing — the declarations the client last pushed — plus the
three facts a call needs: a loopback port, a bearer token, and the generation
number that tells the rest of the host something changed.

Why the declarations live HERE and not in the install root: `tools/components.py`
is the machine's table of installed ARTIFACTS (a directory, a version, a digest)
and the components page reads it. A pushed declaration is not an artifact. It
describes a process on the client that exists while the user has this session
open, and the moment the app goes away it means nothing. Writing it down would
put two writers on one table and leave a component behind that nobody can fix by
deleting a file (PLUGIN_PLAN.md 零之四.1/3). So it is memory, and the push is a
REPLACEMENT rather than a merge: the client is the source of truth for what the
client runs, and a push of one component means "this is the whole set".

Nothing here decides what the model is offered. `catalog.table()` folds the held
declarations in, so the ordinary diagnostics, gates, modes and policy words apply
to a plugin exactly as they do to an installed component; and
`rendezvous.unavailable_reason` opens its one door for a component this channel
holds, and no other. This file is the transport and the bookkeeping.

The call itself: `POST http://127.0.0.1:<port>/call`, `Authorization: Bearer
<token>`, body `{component, command, args}`, answer `{content, error?}` — the same
`{content}` the envelope carries to the model, because the client's plugin
returns model-facing text by contract (ui/plugin-host.js).

Why the body carries a `command` and not a tool name (D3 step ③): a tool call has
one form — a template plus its arguments — and for a component the CLIENT runs the
template is the client's own: it declared that statement with the component, so it
is the protocol unit both sides agree on. The host sends it VERBATIM (it renders
nothing: the client's shell is not this host's) and the client refuses any
template it did not declare, so a session can ask for a tool the client offered
and cannot invent one. 127.0.0.1 is the port a reverse forward of the client's own
listening on THIS machine; the listener behind it is the client's, never the
supervisor's /api/components port (which can install code and must not be the
thing a session is allowed to dial).
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from . import catalog

# The one URL a held declaration is called at. The client's listener owns the
# rest of its surface; a call is a POST here and nothing else.
CALL_PATH = "/call"

# A push is a handful of declarations, each the size of the component.json a
# component already ships, so anything approaching a megabyte is a client bug (or
# a body that is not a push at all) and is refused before it is parsed.
MAX_PUSH_BYTES = 1 << 20
MAX_COMPONENTS = 64

# What comes back is MODEL-FACING TEXT, and a search answer or a fetched page can
# be large. Capped so a runaway answer is not held twice — once by the client,
# once here — and the model is told why instead of the session growing a copy.
MAX_ANSWER_BYTES = 4 << 20

# The token the client generates for its listener. This is not a length that
# makes a secret; it is one that rules out `"token": "x"` reaching production.
# Generating the value, and keeping it, is the client's business.
MIN_TOKEN = 16

# How much longer than the caller's own deadline this side waits. The client
# kills its fork at its own CALL_TIMEOUT_MS (ui/plugin-host.js, 30 s) and answers
# the call itself, so what the model reads is the client's sentence — "the plugin
# did not finish in 30 s" — instead of a bare socket timeout raised here.
GRACE_S = 5.0

# The only addresses a push may name. The call always goes to the loopback
# literal below; a declaration that names a host is either confusion or an
# attempt to make this session dial somewhere else, and both are refused.
LOOPBACK = frozenset({"", "127.0.0.1", "localhost", "::1"})
DIAL_HOST = "127.0.0.1"


class ChannelError(RuntimeError):
    """A push this host will not take, or a call it cannot make — one sentence.

    Raised rather than returned because both callers answer with the text: the
    endpoint as a 400 body, the registry as the model's error envelope. The
    sentence is written to be read by whoever is looking — the user in the
    components page, or the model deciding what to do next.
    """


@dataclass(frozen=True)
class Reply:
    """One answer from the client's plugin: the model-facing text, and whether the
    plugin itself called it a failure (its `{content, error}` return)."""

    content: str
    error: bool = False


@dataclass(frozen=True)
class Channel:
    """One push, held whole: where to dial, with what, and what the client runs.

    Immutable and swapped as a unit (see `_swap`), so a call in flight reads one
    consistent set and a reader can never see the port of one push next to the
    components of another. `token` is `repr=False` on purpose: this object reaches
    log lines and test failure output, and the secret has no business there.
    """

    port: int = 0
    token: str = field(default="", repr=False)
    components: Mapping[str, catalog.Component] = field(default_factory=dict)
    generation: int = 0
    since: float = 0.0

    def live(self) -> bool:
        """Whether this session can dial a client at all (a port AND its token)."""
        return bool(self.port and self.token)

    def holds(self, name: str) -> bool:
        """Whether the client declared `name` in the push this channel holds."""
        return name in self.components

    def reason_for(self, name: str) -> str:
        """Why `name` cannot be called through this channel ("" when it can)."""
        if not self.live():
            return f"this session has no channel to the client that runs {name}"
        if name not in self.components:
            return f"the client's channel does not hold {name} (the last push did not name it)"
        return ""


_LOCK = threading.RLock()
# The channel is one value, replaced whole. Reads are lock-free on purpose: a
# reference assignment is atomic in CPython, and a caller holding the old value
# gets a coherent old answer rather than a half-updated one.
_CHANNEL = Channel()


def _swap(next_: Channel) -> None:
    global _CHANNEL
    _CHANNEL = next_


def current() -> Channel:
    """The push this session holds right now (the zero value: no client at all)."""
    return _CHANNEL


def generation() -> int:
    """A number that changes on every push and every clear.

    What makes a declaration's ARRIVAL visible to a memo that watches the disk:
    catalog.source_signature folds this in, so the next table lookup re-reads
    without anyone having to remember to invalidate (the client's push and a
    component being installed are the same kind of event to the table).
    """
    return _CHANNEL.generation


def declarations() -> dict[str, catalog.Component]:
    """The components the client declared, by name — a copy, nobody owns it."""
    return dict(_CHANNEL.components)


def holds(name: str) -> bool:
    """Whether the live channel holds `name` — the door rendezvous opens."""
    return _CHANNEL.reason_for(name) == ""


def register(payload: Any) -> Channel:
    """Take the client's whole set of declarations, or refuse the push.

    Refusal is all-or-nothing: a push with one unreadable component leaves the
    previous set in place, because a session that silently dropped half of what
    the client says it runs would offer a tool surface nobody declared. The port
    and token are the client's own reverse-forward coordinates; nothing here
    guesses at them, and nothing here writes anything to disk.
    """
    port, token, declared = _validated(payload)
    with _LOCK:
        held = Channel(
            port=port,
            token=token,
            components=declared,
            generation=_CHANNEL.generation + 1,
            since=time.time(),
        )
        _swap(held)
    return held


def clear() -> Channel:
    """Forget the client's declarations — the client went away, or said so.

    Still a new GENERATION: "nothing is declared" is a state the table has to
    notice as much as "this component is declared" is.
    """
    with _LOCK:
        held = Channel(generation=_CHANNEL.generation + 1, since=time.time())
        _swap(held)
    return held


def _validated(payload: Any) -> tuple[int, str, dict[str, catalog.Component]]:
    """One push body -> (port, token, declarations), or ChannelError."""
    if not isinstance(payload, Mapping):
        raise ChannelError("a channel push must be a JSON object")
    port = payload.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ChannelError(f"the channel's port must be a whole number between 1 and 65535, got {port!r}")
    host = payload.get("host", "")
    if host not in LOOPBACK:
        raise ChannelError(
            f"the channel may only name a loopback address (this session dials {DIAL_HOST}), got {host!r}"
        )
    token = payload.get("token")
    if not isinstance(token, str) or len(token) < MIN_TOKEN:
        raise ChannelError(f"the channel's token must be at least {MIN_TOKEN} characters")
    if any(char.isspace() or ord(char) < 32 for char in token):
        raise ChannelError("the channel's token may not contain spaces or control characters")
    raw = payload.get("components")
    if not isinstance(raw, list) or not raw:
        raise ChannelError("a channel push must name at least one component")
    if len(raw) > MAX_COMPONENTS:
        raise ChannelError(f"a channel push may name at most {MAX_COMPONENTS} components")
    declared: dict[str, catalog.Component] = {}
    for index, data in enumerate(raw):
        component = _plugin_of(data, index)
        if component.name in declared:
            raise ChannelError(f"the channel push names {component.name!r} twice")
        declared[component.name] = component
    return port, token, declared


def _plugin_of(data: Any, index: int) -> catalog.Component:
    """One declared component, read through the SAME parser a manifest goes
    through, then held to what a plugin is allowed to be.

    The parser is shared on purpose: a plugin's declaration is a declaration — the
    same vocabulary, the same diagnostics — and a second reader here would be a
    second place for the two to disagree. What is added is the two words this
    interface fixes: `interface: "plugin"` (the client implements it) and
    `runs_on: "other"` (it runs there, never here), plus the ordinary fatal
    diagnostics a manifest's typo would also die on.
    """
    where = f"component #{index + 1}"
    if not isinstance(data, Mapping):
        raise ChannelError(f"{where} is not an object")
    named = str(data.get("name", "") or "")
    if named:
        where = f"component {named!r}"
    component = catalog._component_of(data)
    if component is None:
        raise ChannelError(f"{where} is not a declaration this host can read (it needs a name and a known interface)")
    if component.interface != catalog.PLUGIN:
        raise ChannelError(
            f"{where} declares interface {component.interface!r}, and only {catalog.PLUGIN!r} may be pushed: "
            f"anything else is code this host is asked to run, which is an install"
        )
    fatal = [d.message for d in catalog.component_diagnostics(component) if d.fatal]
    if fatal:
        raise ChannelError(f"{where} is refused: {'; '.join(fatal)}")
    return component


def call(component: str, command: str, args: Mapping[str, Any], timeout_s: float) -> Reply:
    """One tool call, over the channel: its answer, or the reason it is not here.

    `command` is the client's OWN statement for that tool, exactly as it travelled
    in the push — this host does not render it (tools/statement.py Client), so what
    crosses the wire is a template and the model's raw arguments, and the client
    decides what argv words those make.

    A call is made against the push that is held NOW and never re-read midway; if
    the client clears the channel while the request is in flight the request still
    completes (a fork on the client is killed by the client), and the next call is
    the one that is refused. The bearer token proves to the client's listener that
    the request came from the session it pushed to; the address is the loopback
    port its reverse forward listens on here.
    """
    held = _CHANNEL
    reason = held.reason_for(component)
    if reason:
        raise ChannelError(reason)
    where = f"{component} ({command})"
    body = json.dumps(
        {"component": component, "command": command, "args": dict(args)}, ensure_ascii=False
    ).encode("utf-8")
    request = urllib.request.Request(
        f"http://{DIAL_HOST}:{held.port}{CALL_PATH}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {held.token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=max(1.0, float(timeout_s)) + GRACE_S) as response:
            raw = response.read(MAX_ANSWER_BYTES + 1)
    except urllib.error.HTTPError as e:
        detail = _detail(e)
        raise ChannelError(f"the client refused the call to {where}: {detail}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        # ValueError covers a request urllib cannot even build; URLError wraps the
        # socket-level ones; TimeoutError is an OSError. All of them mean the same
        # thing to the model: the reverse forward is not answering.
        raise ChannelError(f"the channel to the client is not answering: {_reason_of(e)}") from None
    if len(raw) > MAX_ANSWER_BYTES:
        raise ChannelError(f"the client's answer to {where} was larger than {MAX_ANSWER_BYTES} bytes")
    try:
        answer = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ChannelError(f"the client's answer to {where} was not JSON") from None
    if not isinstance(answer, dict) or not isinstance(answer.get("content"), str):
        raise ChannelError(
            f"the client's answer to {where} carried no content "
            f"(the plugin ABI is {{content: string, error?: bool}})"
        )
    return Reply(content=answer["content"], error=bool(answer.get("error", False)))


def _reason_of(error: BaseException) -> str:
    """The innermost readable reason of a dial failure ("" when there is none)."""
    while isinstance(error, urllib.error.URLError) and isinstance(error.reason, BaseException):
        error = error.reason
    text = str(error)
    return text or error.__class__.__name__


def _detail(error: urllib.error.HTTPError) -> str:
    """The sentence a client listener sent with its refusal, or the status."""
    try:
        raw = error.read(2048)
    except (OSError, ValueError):
        raw = b""
    try:
        body = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), str) and body["error"]:
        return body["error"]
    return f"HTTP {error.code}"


__all__ = [
    "CALL_PATH",
    "MAX_PUSH_BYTES",
    "MAX_COMPONENTS",
    "MAX_ANSWER_BYTES",
    "MIN_TOKEN",
    "GRACE_S",
    "Channel",
    "ChannelError",
    "Reply",
    "current",
    "generation",
    "declarations",
    "holds",
    "register",
    "clear",
    "call",
]
