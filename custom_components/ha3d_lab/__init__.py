from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import (
    DOMAIN,
    MODEL_RELATIVE_PATH,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
)
from .entity_aliases import HA3DEntityAliasesView
from .floating_widgets import HA3DFloatingWidgetsView
from .http import HA3DAreasView, HA3DConfigView, HA3DModelUploadView
from .marker_proximity import HA3DMarkerProximityView
from .scene_assets import HA3DSceneAssetUploadView, HA3DSceneAssetsView
from .storage import HA3DStore
from .virtual_lights import HA3DVirtualLightsView


FRONTEND_VERSION = "0.3.0-lab.1"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Prepare HA3D shared runtime state."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HA3D from a config entry."""
    runtime = hass.data.setdefault(DOMAIN, {})
    store: HA3DStore = runtime.setdefault("store", HA3DStore(hass))

    if not runtime.get("http_registered"):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(frontend_dir), cache_headers=False)]
        )
        hass.http.register_view(HA3DConfigView(store))
        hass.http.register_view(HA3DModelUploadView(hass, store))
        hass.http.register_view(HA3DAreasView(hass))
        hass.http.register_view(HA3DVirtualLightsView(store))
        hass.http.register_view(HA3DSceneAssetsView(hass, store))
        hass.http.register_view(HA3DSceneAssetUploadView(hass, store))
        hass.http.register_view(HA3DFloatingWidgetsView(store))
        hass.http.register_view(HA3DEntityAliasesView(store))
        hass.http.register_view(HA3DMarkerProximityView(store))
        runtime["http_registered"] = True

    model_path = Path(hass.config.path(MODEL_RELATIVE_PATH))
    if await hass.async_add_executor_job(model_path.is_file):
        await store.async_set_model_ready()

    if not frontend.async_panel_exists(hass, PANEL_URL_PATH):
        await panel_custom.async_register_panel(
            hass=hass,
            frontend_url_path=PANEL_URL_PATH,
            webcomponent_name=PANEL_ELEMENT,
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            module_url=f"{STATIC_URL}/ha3d-entry.js?v={FRONTEND_VERSION}",
            embed_iframe=False,
            require_admin=False,
            handle_safe_area=True,
            config={"integration": DOMAIN},
        )
        runtime["owns_panel"] = True
    else:
        runtime["owns_panel"] = False

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload HA3D without touching user models or stored configuration."""
    runtime = hass.data.get(DOMAIN, {})
    if runtime.get("owns_panel") and frontend.async_panel_exists(hass, PANEL_URL_PATH):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    runtime["owns_panel"] = False
    return True
