"""GET/POST /api/settings, POST /api/llm/base, GET /api/host.

The persisted knobs, the one knob that is deliberately NOT persisted (the
endpoint a claiming client re-points a live session to — see _llm_base_post),
and the host facts.

The store itself stays in agent/server.py on purpose: it is the module-level seam
tests/server_test.py patches by name, and agent/tools/hostconfig.py documents its
path as the place this machine's host tables live. `_server_module()` hands back
that module, so the endpoints resolve the store per request and such a patch
keeps reaching them.
"""

from __future__ import annotations

from ..config import API_PROTOCOLS, REASONING_EFFORT_LEVELS, flatten_settings
from ..tools import catalog


class SettingsMixin:
    "The persisted settings and the host facts the UI renders from."
    def _settings_post(self) -> None:
        """Save the flat LLM settings (base_url / model / api_key /
        reasoning_effort / api_protocol) and apply them to the live server
        config."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)

        # the two "knobs" share one shape: a bare string, empty = back to the
        # provider/protocol default (stored as None, dropped from the file)
        knobs = {}
        for field, allowed in (
            ("reasoning_effort", REASONING_EFFORT_LEVELS),
            ("api_protocol", API_PROTOCOLS),
        ):
            value = (body.get(field) or "").strip()
            if value and value not in allowed:
                return self._json({"error": f"{field} must be one of {', '.join(allowed)}"}, status=400)
            knobs[field] = value or None
        base_url = (body.get("base_url") or "").strip()
        model = (body.get("model") or "").strip()
        api_key = (body.get("api_key") or "").strip()
        if not any((base_url, model, api_key)) and not set(knobs) & set(body):
            return self._json({"error": "nothing to save"}, status=400)

        with self._state.lock:
            if api_key:
                self._state.api_key = api_key
            if base_url:
                self._cfg.base_url = base_url
            if model:
                self._cfg.model = model
            # a knob present in the body is applied (empty clears it)
            if "reasoning_effort" in body:
                self._cfg.llm_reasoning_effort = knobs["reasoning_effort"]
            if "api_protocol" in body:
                self._cfg.llm_api_protocol = knobs["api_protocol"]
        # flatten migrates legacy profile maps but only knows the LLM fields
        saved = flatten_settings(self._server_module().load_settings())
        if base_url:
            saved["base_url"] = base_url
        if model:
            saved["model"] = model
        if api_key:
            saved["api_key"] = api_key
        for field, value in knobs.items():
            if field not in body:
                continue
            if value:
                saved[field] = value
            else:
                saved.pop(field, None)  # empty = clear the knob
        self._server_module().save_settings(saved)
        self._json({"status": "ok"})

    def _llm_base_post(self) -> None:
        """Re-point the LLM endpoint of THIS process, in memory, right now.

        The counterpart of the spawn-time ``--base-url``/``--model`` flags
        (agent/supervisor.py start_session). A remote session's LLM endpoint is
        the CLAIMING CLIENT's own proxy at the far end of an SSH reverse forward,
        and that path can move under a live session: a hop that dies without a
        FIN leaves the far sshd holding the old listener, so the next reverse
        forward lands on a different port. The session — and the run inside it —
        outlives every hop (STALE_S is 300s), and a process whose endpoint was
        frozen at spawn can only retry into a port nobody serves: that is the
        field's "the session is fine, the network is fine, the agent still says
        it cannot reach the API".

        So the endpoint is mutable state. The supervisor forwards the claiming
        client's current base here on its heartbeat, this swaps the live client's
        SDK client in place (BaseOpenaiClient.repoint, which also breaks the
        reads still parked on the old path) and updates the config the NEXT run
        assembles from.

        Deliberately NOT persisted: this is the client's wire, not this machine's
        settings. ``~/.clutch/settings.json`` belongs to the host (its own
        sessions read it), and a phone's dynamic loopback port is not a setting
        there — /api/settings is the endpoint for the knobs a user actually owns
        and expects to find again after a restart."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        base_url = (body.get("base_url") or "").strip()
        model = (body.get("model") or "").strip()
        if not base_url:
            return self._json({"error": "base_url is required"}, status=400)
        if not base_url.startswith(("http://", "https://")):
            # the openai SDK would take any string and fail per request with a
            # message about an unsupported protocol: refuse it here, once, with
            # the reason the caller can act on
            return self._json({"error": "base_url must be an http(s) URL"}, status=400)
        with self._state.lock:
            moved = base_url != self._cfg.base_url or (bool(model) and model != self._cfg.model)
            self._cfg.base_url = base_url
            if model:
                self._cfg.model = model
            live = self._state.llm
            current_model = self._cfg.model
        repointed = False
        if live is not None:
            repoint = getattr(live, "repoint", None)
            if repoint is not None:
                try:
                    repointed = bool(repoint(base_url, model or None))
                except Exception as err:  # noqa: BLE001 -- an answer, not a crash
                    # a re-point that blows up must not look like a dead session:
                    # the caller (the supervisor, on a heartbeat) retries on the
                    # next beat, and the answer says what happened
                    return self._json({"error": f"repoint failed: {err}"}, status=500)
        self._json(
            {
                "status": "ok",
                "base_url": base_url,
                "model": current_model,
                # whether the base actually MOVED for a client that is running
                # (False = already there, or no run in flight: the next run
                # assembles from the config updated above)
                "repointed": repointed,
                "live": live is not None,
                "changed": moved,
            }
        )

    def _settings_get(self) -> None:
        """Current LLM endpoint config for the settings modal (no credentials)."""
        saved = flatten_settings(self._server_module().load_settings())
        self._json(
            {
                "base_url": self._cfg.base_url or saved.get("base_url", ""),
                "model": self._cfg.model or saved.get("model", ""),
                "reasoning_effort": self._cfg.llm_reasoning_effort or saved.get("reasoning_effort", ""),
                "api_protocol": self._cfg.llm_api_protocol or saved.get("api_protocol", ""),
                "has_api_key": bool(self._state.api_key or self._cfg.api_key or saved.get("api_key")),
            }
        )

    def _host_get(self) -> None:
        """The host's own tables a renderer needs to know about (GET /api/host).

        Today one: the `ui` defaults — the host document's table merged over the
        built-in one (catalog.DEFAULTS, tools/hostconfig.py). Served rather than
        duplicated, so the renderer's own copy (ui/js/tool-render.js UI_DEFAULTS)
        is only what an older
        host or an unreadable document leaves in force."""
        self._json({"ui": catalog.DEFAULTS})
