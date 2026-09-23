// Native Home Assistant state icons for every HA3D entity marker.
// Imported last so it only replaces marker artwork; binding, actions and 3D state logic stay untouched.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function renderNativeStateIcon(binding, stateObj) {
  const marker = binding?.marker;
  if (!marker || !stateObj) return;

  // HA registers this component in its own frontend. If it is unavailable for
  // any reason, leave the existing marker artwork untouched as a safe fallback.
  if (!customElements.get("ha-state-icon")) return;

  let icon = marker.querySelector("ha-state-icon[data-ha3d-native-state-icon]");
  if (!icon) {
    marker.replaceChildren();
    icon = document.createElement("ha-state-icon");
    icon.dataset.ha3dNativeStateIcon = "";
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

  // This is the same state object Home Assistant uses for <ha-state-icon>.
  // The component resolves the normal HA icon from domain/device_class/state
  // and also reacts when the state object changes.
  icon.stateObj = stateObj;
}

if (!proto.__ha3dNativeStateIconsV1) {
  proto.__ha3dNativeStateIconsV1 = true;

  const originalBindEntityLightMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindEntityLightMarkers.apply(this, args);
    const states = this._hass?.states || {};

    for (const [entity, binding] of this._lightBindings?.entries?.() || []) {
      const stateObj = states[entity];
      if (!stateObj) continue;
      renderNativeStateIcon(binding, stateObj);
    }

    return result;
  };
}
