from __future__ import annotations

import re
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .storage import HA3DStore

_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_MAX_WIDGETS = 300


def _number(value: Any, minimum: float = -1_000_000, maximum: float = 1_000_000) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and minimum <= float(value) <= maximum


def _vec3(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_number(item) for item in value)


def _valid_widget(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    allowed = {
        "id", "name", "type", "anchor", "entity_id", "attribute", "text", "image_url",
        "offset", "scale", "visibility", "zoom_threshold", "chart_hours", "enabled",
    }
    if set(value) - allowed:
        return False

    widget_id = value.get("id")
    if not isinstance(widget_id, str) or not widget_id or len(widget_id) > 100:
        return False
    name = value.get("name", widget_id)
    if not isinstance(name, str) or not name or len(name) > 120:
        return False
    if value.get("type") not in {"text", "state", "image", "chart"}:
        return False
    anchor = value.get("anchor")
    if not isinstance(anchor, str) or not anchor or len(anchor) > 255:
        return False

    entity_id = value.get("entity_id")
    if entity_id not in (None, "") and (not isinstance(entity_id, str) or not _ENTITY_ID_RE.fullmatch(entity_id)):
        return False
    attribute = value.get("attribute")
    if attribute not in (None, "") and (not isinstance(attribute, str) or len(attribute) > 120):
        return False
    text = value.get("text", "")
    if not isinstance(text, str) or len(text) > 1000:
        return False
    image_url = value.get("image_url", "")
    if not isinstance(image_url, str) or len(image_url) > 2000:
        return False
    if not _vec3(value.get("offset", [0, 0, 0])):
        return False
    if not _number(value.get("scale", 1), 0.2, 4):
        return False
    if value.get("visibility", "always") not in {"always", "zoom", "click"}:
        return False
    if not _number(value.get("zoom_threshold", 1.15), 0.1, 5):
        return False
    if not _number(value.get("chart_hours", 24), 1, 168):
        return False
    if "enabled" in value and not isinstance(value["enabled"], bool):
        return False
    return True


def _valid_widgets(value: Any) -> bool:
    if not isinstance(value, list) or len(value) > _MAX_WIDGETS:
        return False
    ids: set[str] = set()
    for item in value:
        if not _valid_widget(item) or item["id"] in ids:
            return False
        ids.add(item["id"])
    return True


class HA3DFloatingWidgetsView(HomeAssistantView):
    """Persist floating information widgets independently from object bindings."""

    url = "/api/ha3d_lab/floating_widgets"
    name = "api:ha3d_lab:floating_widgets"
    requires_auth = True

    def __init__(self, store: HA3DStore) -> None:
        self._store = store

    async def get(self, request: web.Request) -> web.Response:
        data = await self._store.async_load()
        return self.json({"floating_widgets": data.get("floating_widgets", [])})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)
        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "invalid_json"}, status=400)

        widgets = payload.get("floating_widgets")
        if not _valid_widgets(widgets):
            return self.json({"error": "invalid_floating_widgets"}, status=400)

        data = await self._store.async_update({"floating_widgets": widgets})
        return self.json(data)
