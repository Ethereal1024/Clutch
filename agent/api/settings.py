"""GET/POST /api/settings and GET /api/host: the persisted knobs and host facts.

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
