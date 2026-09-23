from __future__ import annotations

import re
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .storage import HA3DStore

_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_MAX_LIGHTS = 200


def _is_number(value: Any, minimum: float = -1_000_000, maximum: float = 1_000_000) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and minimum <= float(value) <= maximum
    )


def _is_vector3(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_is_number(item) for item in value)


def _is_valid_virtual_light(value: Any) -> bool:
    if not isinstance(value, dict):
        return False

    allowed = {
        "id",
        "name",
        "entity_id",
        "type",
        "position",
        "rotation",
        "color",
        "intensity",
        "distance",
        "decay",
        "angle",
        "penumbra",
        "cast_shadow",
        "enabled",
        "show_marker",
        "effect",
    }
    if set(value) - allowed:
        return False

    light_id = value.get("id")
    if not isinstance(light_id, str) or not light_id or len(light_id) > 100:
        return False

    name = value.get("name", light_id)
    if not isinstance(name, str) or not name or len(name) > 120:
        return False

    if value.get("type") not in {"point", "spot"}:
        return False

    entity_id = value.get("entity_id")
    if entity_id is not None and (not isinstance(entity_id, str) or not _ENTITY_ID_RE.fullmatch(entity_id)):
        return False

    if not _is_vector3(value.get("position")) or not _is_vector3(value.get("rotation")):
        return False

    color = value.get("color", "#ffffff")
    if not isinstance(color, str) or not _COLOR_RE.fullmatch(color):
        return False

    if not _is_number(value.get("intensity", 10), 0, 1_000_000):
        return False
    if not _is_number(value.get("distance", 6), 0, 1_000_000):
        return False
    if not _is_number(value.get("decay", 2), 0, 100):
        return False
    if not _is_number(value.get("angle", 0.78539816339), 0.01, 1.57079632680):
        return False
    if not _is_number(value.get("penumbra", 0.35), 0, 1):
        return False

    if "cast_shadow" in value and not isinstance(value["cast_shadow"], bool):
        return False
    if "enabled" in value and not isinstance(value["enabled"], bool):
        return False
    if "show_marker" in value and not isinstance(value["show_marker"], bool):
        return False
    if value.get("effect", "none") not in {"none", "tv_flicker"}:
        return False

    return True


def _is_valid_virtual_lights(value: Any) -> bool:
    if not isinstance(value, list) or len(value) > _MAX_LIGHTS:
        return False
    ids: set[str] = set()
    for item in value:
        if not _is_valid_virtual_light(item):
            return False
        light_id = item["id"]
        if light_id in ids:
            return False
        ids.add(light_id)
    return True


class HA3DVirtualLightsView(HomeAssistantView):
    """Persist HA3D runtime-created lights without changing the GLB."""

    url = "/api/ha3d_lab/virtual_lights"
    name = "api:ha3d_lab:virtual_lights"
    requires_auth = True

    def __init__(self, store: HA3DStore) -> None:
        self._store = store

    async def get(self, request: web.Request) -> web.Response:
        data = await self._store.async_load()
        return self.json({"virtual_lights": data.get("virtual_lights", [])})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)

        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "invalid_json"}, status=400)

        lights = payload.get("virtual_lights")
        if not _is_valid_virtual_lights(lights):
            return self.json({"error": "invalid_virtual_lights"}, status=400)

        data = await self._store.async_update({"virtual_lights": lights})
        return self.json(data)
