// Dynamic MDI icons for window binary_sensors only.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isWindowSensor(entity, state) {
  if (!String(entity || "").startsWith("binary_sensor.")) return false;
  if (state?.attributes?.device_class === "window") return true;

  const objectId = String(entity).slice("binary_sensor.".length).toLowerCase();
  return /(^|_)(janela|window)(_|$)/.test(objectId);
}

function renderWindowIcon(binding, state) {
  const marker = binding?.marker;
  if (!marker) return;

  const isOpen = state?.state === "on";
  const iconName = isOpen ? "mdi:window-open" : "mdi:window-closed";

  let icon = marker.querySelector("ha-icon[data-ha3d-window-icon]");
  if (!icon) {
    marker.replaceChildren();
    icon = document.createElement("ha-icon");
    icon.dataset.ha3dWindowIcon = "";
    icon.style.width = "22px";
    icon.style.height = "22px";
    icon.style.pointerEvents = "none";
    marker.style.display = "grid";
    marker.style.placeItems = "center";
    marker.appendChild(icon);
  }

  icon.setAttribute("icon", iconName);
  marker.title = `${binding.name || binding.entity} — ${isOpen ? "aberta" : "fechada"}`;
}

if (!proto.__ha3dWindowMdiIconsV1) {
  proto.__ha3dWindowMdiIconsV1 = true;

  const originalBindEntityLightMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindEntityLightMarkers.apply(this, args);
    const states = this._hass?.states || {};

    for (const [entity, binding] of this._lightBindings?.entries?.() || []) {
      const state = states[entity];
      if (!isWindowSensor(entity, state)) continue;
      renderWindowIcon(binding, state);
    }

    return result;
  };
}
