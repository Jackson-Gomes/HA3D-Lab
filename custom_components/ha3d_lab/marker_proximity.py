from __future__ import annotations

import re
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .storage import HA3DStore

_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_MIN_FACTOR = 0.25
_MAX_FACTOR = 3.0
_MAX_ITEMS = 2000


def _sanitize_proximity(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict) or len(value) > _MAX_ITEMS:
        return None
    result: dict[str, float] = {}
    for entity_id, factor in value.items():
        if not isinstance(entity_id, str) or not _ENTITY_ID_RE.fullmatch(entity_id):
            return None
        if isinstance(factor, bool) or not isinstance(factor, (int, float)):
            return None
        numeric = float(factor)
        if numeric < _MIN_FACTOR or numeric > _MAX_FACTOR:
            return None
        result[entity_id] = round(numeric, 3)
    return result


class HA3DMarkerProximityView(HomeAssistantView):
    """Read and update per-entity marker proximity thresholds."""

    url = "/api/ha3d_lab/marker_proximity"
    name = "api:ha3d_lab:marker_proximity"
    requires_auth = True

    def __init__(self, store: HA3DStore) -> None:
        self._store = store

    async def get(self, request: web.Request) -> web.Response:
        data = await self._store.async_load()
        values = _sanitize_proximity(data.get("marker_proximity", {})) or {}
        return self.json({"marker_proximity": values})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)
        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "invalid_json"}, status=400)

        values = _sanitize_proximity(payload.get("marker_proximity"))
        if values is None:
            return self.json({"error": "invalid_marker_proximity"}, status=400)

        await self._store.async_update({"marker_proximity": values})
        return self.json({"marker_proximity": values})
