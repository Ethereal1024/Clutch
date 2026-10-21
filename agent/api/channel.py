"""POST/GET/DELETE /api/channel: what the CLIENT runs, declared to this session.

A component with no process on this machine (`service` absent, `launch` absent, an
`entry` module named instead) cannot be installed here — its bytes never come to
this machine — so the client says what it has, and where this session may call it:
a loopback port its reverse forward listens on, a bearer token, and the
declarations themselves. The bookkeeping, the validation and the call are all
tools/channel.py; this module is only the three verbs.

DELETION is the honest "nothing is declared": the client went away, the window
closed, its listener died. It changes no bytes either — the same discipline as the
push, because a channel declaration is not an install and this session must not
be able to leave one behind in the machine's component table.

The token never travels back out. GET answers what this session holds — names,
the tool list, the generation — which is what a window needs to show
the user its own client components; the secret is the client's, it was sent to be
used and not to be read back (this API is also reachable through a tunnel).
"""

from __future__ import annotations

from ..tools import channel


class ChannelMixin:
    "The client's plugin declarations: pushed, read back, and cleared."
    def _channel_post(self) -> None:
        """Replace the whole set of declarations the client runs (POST /api/channel).

        The body is `{port, token, components: [...]}`, one push per session. A
        refused push leaves the previous set in place — half a set would be a tool
        surface nobody declared — and says why in the error, which is the sentence
        the client shows.
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length > channel.MAX_PUSH_BYTES:
            self._json(
                {"error": f"a channel push may be at most {channel.MAX_PUSH_BYTES} bytes"}, status=413
            )
            return
        body = self._read_body()
        if body is None:
            self._json({"error": "bad json body"}, status=400)
            return
        try:
            held = channel.register(body)
        except channel.ChannelError as e:
            self._json({"error": str(e)}, status=400)
            return
        self._json({"status": "ok", **self._channel_state(held)})

    def _channel_delete(self) -> None:
        """Forget the client's declarations (DELETE /api/channel)."""
        self._json({"status": "ok", **self._channel_state(channel.clear())})

    def _channel_get(self) -> None:
        """What this session holds right now (GET /api/channel) — never the token."""
        self._json(self._channel_state(channel.current()))

    @staticmethod
    def _channel_state(held: channel.Channel) -> dict:
        return {
            "live": held.live(),
            "generation": held.generation,
            "since": held.since,
            "port": held.port,
            "components": [
                {
                    "name": component.name,
                    "entry": component.entry,
                    "tools": [tool.name for tool in component.tools],
                }
                for component in held.components.values()
            ],
        }
