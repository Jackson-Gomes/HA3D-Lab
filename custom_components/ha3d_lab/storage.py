from __future__ import annotations

from copy import deepcopy
import time
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import MODEL_PUBLIC_URL, STORE_KEY, STORE_VERSION

DEFAULT_CONFIG: dict[str, Any] = {
    "model_url": None,
    "model_revision": 0,
    "auto_bind": True,
    "bindings": {},
    "object_positions": {},
    "area_bindings": {},
    "advanced_bindings": {},
    "robots": [],
    "virtual_lights": [],
    "scene_assets": [],
    "floating_widgets": [],
    "entity_aliases": {},
    "marker_proximity": {},
}


class HA3DStore:
    """Small storage wrapper for HA3D configuration."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, STORE_KEY)
        self._data: dict[str, Any] | None = None

    async def async_load(self) -> dict[str, Any]:
        if self._data is None:
            stored = await self._store.async_load() or {}
            self._data = deepcopy(DEFAULT_CONFIG)
            self._data.update(stored)
            self._data["bindings"] = dict(stored.get("bindings", {}))
            self._data["virtual_lights"] = list(stored.get("virtual_lights", []))
            self._data["scene_assets"] = list(stored.get("scene_assets", []))
            self._data["floating_widgets"] = list(stored.get("floating_widgets", []))
            self._data["entity_aliases"] = dict(stored.get("entity_aliases", {}))
            self._data["marker_proximity"] = dict(stored.get("marker_proximity", {}))
        return deepcopy(self._data)

    async def async_update(self, changes: dict[str, Any]) -> dict[str, Any]:
        data = await self.async_load()
        data.update(changes)
        self._data = data
        await self._store.async_save(data)
        return deepcopy(data)

    async def async_set_model_ready(self) -> dict[str, Any]:
        return await self.async_update(
            {
                "model_url": MODEL_PUBLIC_URL,
                "model_revision": time.time_ns(),
            }
        )
