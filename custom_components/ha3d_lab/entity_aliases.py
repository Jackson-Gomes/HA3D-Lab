from __future__ import annotations

import re
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .storage import HA3DStore

_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_MAX_ALIASES = 2000
_MAX_ALIAS_LEN = 120


def _sanitize_aliases(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or len(value) > _MAX_ALIASES:
        return None
    aliases: dict[str, str] = {}
    for entity_id, alias in value.items():
        if not isinstance(entity_id, str) or not _ENTITY_ID_RE.fullmatch(entity_id):
            return None
        if not isinstance(alias, str):
            return None
        clean = alias.strip()
        if len(clean) > _MAX_ALIAS_LEN:
            return None
        if clean:
            aliases[entity_id] = clean
    return aliases


class HA3DEntityAliasesView(HomeAssistantView):
    """Read and update display-only entity names owned by HA3D."""

    url = "/api/ha3d_lab/entity_aliases"
    name = "api:ha3d_lab:entity_aliases"
    requires_auth = True

    def __init__(self, store: HA3DStore) -> None:
        self._store = store

    async def get(self, request: web.Request) -> web.Response:
        data = await self._store.async_load()
        aliases = _sanitize_aliases(data.get("entity_aliases", {})) or {}
        return self.json({"entity_aliases": aliases})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)
        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "invalid_json"}, status=400)

        aliases = _sanitize_aliases(payload.get("entity_aliases"))
        if aliases is None:
            return self.json({"error": "invalid_entity_aliases"}, status=400)

        await self._store.async_update({"entity_aliases": aliases})
        return self.json({"entity_aliases": aliases})
