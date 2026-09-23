from __future__ import annotations

from functools import partial
import os
from pathlib import Path
import re
import time
from typing import Any
from uuid import uuid4

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import (
    MAX_MODEL_BYTES,
    MAX_SCENE_ASSETS,
    SCENE_ASSETS_PUBLIC_DIR,
    SCENE_ASSETS_RELATIVE_DIR,
)
from .storage import HA3DStore

_CHUNK_SIZE = 1024 * 1024
_ASSET_ID_RE = re.compile(r"^[a-f0-9]{16}$")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(float(value)) < 1_000_000


def _is_vector3(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_is_number(item) for item in value)


def _is_mutable_asset(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    allowed = {"id", "name", "position", "rotation", "scale", "visible"}
    if set(value) - allowed:
        return False
    asset_id = value.get("id")
    if not isinstance(asset_id, str) or not _ASSET_ID_RE.fullmatch(asset_id):
        return False
    name = value.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        return False
    if not _is_vector3(value.get("position")):
        return False
    if not _is_vector3(value.get("rotation")):
        return False
    if not _is_vector3(value.get("scale")):
        return False
    if any(abs(float(item)) < 1e-8 for item in value["scale"]):
        return False
    return isinstance(value.get("visible"), bool)


def _asset_file(hass: HomeAssistant, asset_id: str) -> Path:
    return Path(hass.config.path(SCENE_ASSETS_RELATIVE_DIR)) / f"{asset_id}.glb"


class HA3DSceneAssetsView(HomeAssistantView):
    """Read/update runtime-imported GLB assets in the HA3D scene."""

    url = "/api/ha3d_lab/scene_assets"
    name = "api:ha3d_lab:scene_assets"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, store: HA3DStore) -> None:
        self._hass = hass
        self._store = store

    async def get(self, request: web.Request) -> web.Response:
        data = await self._store.async_load()
        return self.json({"scene_assets": data.get("scene_assets", [])})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)

        try:
            payload = await request.json()
        except ValueError:
            return self.json({"error": "invalid_json"}, status=400)

        requested = payload.get("scene_assets")
        if (
            not isinstance(requested, list)
            or len(requested) > MAX_SCENE_ASSETS
            or not all(_is_mutable_asset(item) for item in requested)
        ):
            return self.json({"error": "invalid_scene_assets"}, status=400)

        ids = [item["id"] for item in requested]
        if len(ids) != len(set(ids)):
            return self.json({"error": "duplicate_scene_asset_id"}, status=400)

        data = await self._store.async_load()
        existing = {item.get("id"): item for item in data.get("scene_assets", []) if isinstance(item, dict)}
        if any(asset_id not in existing for asset_id in ids):
            return self.json({"error": "unknown_scene_asset"}, status=400)

        normalized = []
        for item in requested:
            previous = existing[item["id"]]
            normalized.append(
                {
                    "id": item["id"],
                    "name": item["name"].strip(),
                    "url": previous["url"],
                    "revision": previous["revision"],
                    "position": [float(number) for number in item["position"]],
                    "rotation": [float(number) for number in item["rotation"]],
                    "scale": [float(number) for number in item["scale"]],
                    "visible": item["visible"],
                }
            )

        removed = set(existing) - set(ids)
        updated = await self._store.async_update({"scene_assets": normalized})

        for asset_id in removed:
            target = _asset_file(self._hass, asset_id)
            try:
                await self._hass.async_add_executor_job(target.unlink, True)
            except OSError:
                pass

        return self.json(updated)


class HA3DSceneAssetUploadView(HomeAssistantView):
    """Upload a GLB that is added to, rather than replacing, the main scene."""

    url = "/api/ha3d_lab/scene_assets/upload"
    name = "api:ha3d_lab:scene_assets_upload"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, store: HA3DStore) -> None:
        self._hass = hass
        self._store = store

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return self.json({"error": "admin_required"}, status=403)

        current = await self._store.async_load()
        assets = list(current.get("scene_assets", []))
        if len(assets) >= MAX_SCENE_ASSETS:
            return self.json({"error": "scene_asset_limit", "max_assets": MAX_SCENE_ASSETS}, status=409)

        if not request.content_type.startswith("multipart/"):
            return self.json({"error": "multipart_required"}, status=400)

        try:
            reader = await request.multipart()
        except Exception:
            return self.json({"error": "invalid_multipart"}, status=400)

        file_field = None
        while field := await reader.next():
            if field.name == "file":
                file_field = field
                break

        if file_field is None or not file_field.filename:
            return self.json({"error": "file_required"}, status=400)
        if not file_field.filename.lower().endswith(".glb"):
            return self.json({"error": "glb_required"}, status=400)

        asset_id = uuid4().hex[:16]
        target = _asset_file(self._hass, asset_id)
        temporary = target.with_name(f".{target.name}.upload")
        await self._hass.async_add_executor_job(partial(target.parent.mkdir, parents=True, exist_ok=True))

        total = 0
        header = bytearray()
        too_large = False
        handle = await self._hass.async_add_executor_job(open, temporary, "wb")
        try:
            while True:
                chunk = await file_field.read_chunk(size=_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MODEL_BYTES:
                    too_large = True
                    break
                if len(header) < 4:
                    header.extend(chunk[: 4 - len(header)])
                await self._hass.async_add_executor_job(handle.write, chunk)
        finally:
            await self._hass.async_add_executor_job(handle.close)

        if too_large:
            await self._hass.async_add_executor_job(temporary.unlink, True)
            return self.json({"error": "model_too_large", "max_bytes": MAX_MODEL_BYTES}, status=413)
        if bytes(header) != b"glTF":
            await self._hass.async_add_executor_job(temporary.unlink, True)
            return self.json({"error": "invalid_glb"}, status=400)

        await self._hass.async_add_executor_job(os.replace, temporary, target)

        display_name = Path(file_field.filename).stem.strip()[:120] or "GLB importado"
        asset = {
            "id": asset_id,
            "name": display_name,
            "url": f"{SCENE_ASSETS_PUBLIC_DIR}/{asset_id}.glb",
            "revision": time.time_ns(),
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
            "scale": [1.0, 1.0, 1.0],
            "visible": True,
        }
        assets.append(asset)
        data = await self._store.async_update({"scene_assets": assets})
        return self.json({"ok": True, "bytes": total, "asset": asset, "scene_assets": data["scene_assets"]})
