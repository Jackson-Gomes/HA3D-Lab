import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

function virtualLightConfigs(panel) {
  return Array.isArray(panel?._config?.virtual_lights) ? panel._config.virtual_lights : [];
}

function stateFor(panel, config) {
  return config?.entity_id ? panel?._hass?.states?.[config.entity_id] || null : null;
}

function markerState(panel, config) {
  const state = stateFor(panel, config);
  if (config?.entity_id) {
    const unavailable = !state || state.state === "unknown" || state.state === "unavailable";
    return { state, unavailable, on: !unavailable && state.state === "on" };
  }
  return { state: null, unavailable: false, on: config?.enabled !== false };
}

function renderIcon(marker, stateObj) {
  if (stateObj && customElements.get("ha-state-icon")) {
    let icon = marker.querySelector("ha-state-icon[data-ha3d-virtual-light-icon]");
    if (!icon) {
      marker.replaceChildren();
      icon = document.createElement("ha-state-icon");
      icon.dataset.ha3dVirtualLightIcon = "";
      icon.setAttribute("aria-hidden", "true");
      icon.style.width = "22px";
      icon.style.height = "22px";
      icon.style.display = "inline-flex";
      icon.style.alignItems = "center";
      icon.style.justifyContent = "center";
      icon.style.pointerEvents = "none";
      icon.style.setProperty("--mdc-icon-size", "22px");
      marker.style.display = "grid";
      marker.style.placeItems = "center";
      marker.appendChild(icon);
    }
    icon.stateObj = stateObj;
    return;
  }

  if (!marker.querySelector("ha-state-icon")) marker.textContent = "💡";
}

async function toggleUnboundVirtualLight(panel, id) {
  const current = virtualLightConfigs(panel);
  const item = current.find((light) => light.id === id);
  if (!item) return;
  const nextEnabled = item.enabled === false;
  const lights = current.map((light) => light.id === id ? { ...light, enabled: nextEnabled } : light);

  try {
    await panel._saveConfigPatch?.({ virtual_lights: lights });
    const runtime = panel._ha3dVirtualLights?.get(id);
    if (runtime) runtime.config = panel._config?.virtual_lights?.find((light) => light.id === id) || { ...item, enabled: nextEnabled };
    panel._syncLightStates?.();
    panel._setStatus?.(`${item.name || id}: ${nextEnabled ? "ligada" : "desligada"}`);
  } catch (error) {
    panel._setStatus?.(`Erro ao alternar luz: ${error.message || error}`);
  }
}

async function activateVirtualLightMarker(panel, id) {
  const config = virtualLightConfigs(panel).find((item) => item.id === id);
  if (!config) return;

  if (config.entity_id && panel?._hass?.states?.[config.entity_id]) {
    panel._openNativeMoreInfo?.(config.entity_id);
    return;
  }

  await toggleUnboundVirtualLight(panel, id);
}

function ensureMarker(panel, runtime) {
  const container = panel?.shadowRoot?.querySelector("#markers");
  if (!container || !runtime?.config?.id) return null;

  panel._ha3dVirtualLightMarkers ||= new Map();
  let marker = panel._ha3dVirtualLightMarkers.get(runtime.config.id);
  if (!marker?.isConnected) {
    marker = document.createElement("button");
    marker.type = "button";
    marker.className = "lightMarker ha3dVirtualLightMarker";
    marker.dataset.ha3dVirtualLightId = runtime.config.id;
    marker.style.zIndex = "3";
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateVirtualLightMarker(panel, runtime.config.id);
    });
    container.appendChild(marker);
    panel._ha3dVirtualLightMarkers.set(runtime.config.id, marker);
  }
  return marker;
}

function removeMarker(panel, id) {
  const marker = panel?._ha3dVirtualLightMarkers?.get?.(id);
  marker?.remove?.();
  panel?._ha3dVirtualLightMarkers?.delete?.(id);
}

function removeStaleMarkers(panel, activeIds) {
  for (const [id, marker] of panel?._ha3dVirtualLightMarkers?.entries?.() || []) {
    if (activeIds.has(id) && marker?.isConnected) continue;
    marker?.remove?.();
    panel._ha3dVirtualLightMarkers.delete(id);
  }
}

function updateVirtualLightMarkers(panel) {
  if (!panel?._camera || !panel?._ha3dVirtualLights) return;
  const stage = panel.shadowRoot?.querySelector("#stage");
  if (!stage) return;

  const activeIds = new Set();
  const point = panel._ha3dVirtualLightMarkerPoint || (panel._ha3dVirtualLightMarkerPoint = new THREE.Vector3());

  for (const [id, runtime] of panel._ha3dVirtualLights.entries()) {
    const config = virtualLightConfigs(panel).find((item) => item.id === id) || runtime.config;
    if (config?.show_marker === false) {
      removeMarker(panel, id);
      continue;
    }

    activeIds.add(id);
    const marker = ensureMarker(panel, runtime);
    if (!marker) continue;

    runtime.handle.getWorldPosition(point);
    point.project(panel._camera);
    const visible = point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1.15 && Math.abs(point.y) <= 1.15;
    marker.style.visibility = visible ? "visible" : "hidden";
    if (visible) {
      marker.style.left = `${(point.x * 0.5 + 0.5) * stage.clientWidth}px`;
      marker.style.top = `${(-point.y * 0.5 + 0.5) * stage.clientHeight - 26}px`;
    }

    const status = markerState(panel, config);
    marker.classList.toggle("on", status.on);
    marker.classList.toggle("unavailable", status.unavailable);
    marker.title = `${config.name || id}${config.entity_id ? ` · ${config.entity_id}` : ""} · ${status.unavailable ? "indisponível" : status.on ? "ligada" : "desligada"}`;
    marker.setAttribute("aria-label", marker.title);
    renderIcon(marker, status.state);
  }

  removeStaleMarkers(panel, activeIds);
}

if (!proto.__ha3dVirtualLightMarkersV2) {
  proto.__ha3dVirtualLightMarkersV2 = true;

  const oldUpdateLightMarkers = proto._updateLightMarkers;
  proto._updateLightMarkers = function (...args) {
    const result = oldUpdateLightMarkers?.apply(this, args);
    updateVirtualLightMarkers(this);
    return result;
  };

  const oldSyncLightStates = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    const result = oldSyncLightStates?.apply(this, args);
    updateVirtualLightMarkers(this);
    return result;
  };
}
