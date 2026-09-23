// Final MDI icon standardization layer for HA3D.
// Runs after the existing marker/UI modules so it changes only artwork, not behavior.

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function objectId(entity) {
  return String(entity || "").split(".", 2)[1] || "";
}

function fallbackMdi(entity, stateObj) {
  const domain = String(entity || "").split(".", 1)[0];
  const id = objectId(entity).toLowerCase();
  const deviceClass = String(stateObj?.attributes?.device_class || "").toLowerCase();
  const on = stateObj?.state === "on";

  if (domain === "light") return on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline";
  if (domain === "switch") {
    if (/(impressora|printer)/.test(id)) return "mdi:printer-3d-nozzle";
    return on ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline";
  }
  if (domain === "media_player") {
    if (/(xbox|playstation|console|game|gaming)/.test(id)) return "mdi:gamepad-variant";
    if (/(alexa|echo|speaker|som|audio)/.test(id)) return "mdi:speaker";
    if (/(tv|televis|television)/.test(id)) return "mdi:television";
    return "mdi:play-circle-outline";
  }
  if (domain === "vacuum") return "mdi:robot-vacuum";
  if (domain === "climate") return "mdi:thermostat";
  if (domain === "camera") return "mdi:cctv";
  if (domain === "lock") return on ? "mdi:lock-open-variant" : "mdi:lock";
  if (domain === "cover") return on ? "mdi:window-open" : "mdi:window-closed";
  if (domain === "fan") return "mdi:fan";
  if (domain === "scene") return "mdi:palette-outline";
  if (domain === "script") return "mdi:script-text-play-outline";
  if (domain === "automation") return "mdi:robot-outline";
  if (domain === "person") return "mdi:account";
  if (domain === "device_tracker") return "mdi:map-marker";
  if (domain === "weather") return "mdi:weather-partly-cloudy";
  if (domain === "alarm_control_panel") return "mdi:shield-home-outline";

  if (domain === "binary_sensor") {
    if (deviceClass === "window" || /(^|_)(janela|window)(_|$)/.test(id)) {
      return on ? "mdi:window-open" : "mdi:window-closed";
    }
    if (deviceClass === "door" || deviceClass === "opening" || /(^|_)(porta|door)(_|$)/.test(id)) {
      return on ? "mdi:door-open" : "mdi:door-closed";
    }
    if (["motion", "occupancy", "presence"].includes(deviceClass)) return "mdi:motion-sensor";
    return on ? "mdi:radiobox-marked" : "mdi:radiobox-blank";
  }

  if (domain === "sensor") return "mdi:gauge";
  if (domain === "button") return "mdi:gesture-tap-button";
  return "mdi:circle-outline";
}

function styleMarkerIcon(icon) {
  icon.style.width = "22px";
  icon.style.height = "22px";
  icon.style.display = "inline-flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.pointerEvents = "none";
  icon.style.setProperty("--mdc-icon-size", "22px");
}

function renderMarkerIcon(binding, entity, stateObj) {
  const marker = binding?.marker;
  if (!marker) return;

  marker.style.display = "grid";
  marker.style.placeItems = "center";

  // Prefer Home Assistant's own state-aware icon whenever the entity exists.
  // This preserves custom entity icons and state-specific MDI behavior.
  if (stateObj && customElements.get("ha-state-icon")) {
    let icon = marker.querySelector("ha-state-icon[data-ha3d-mdi-state]");
    if (!icon) {
      marker.replaceChildren();
      icon = document.createElement("ha-state-icon");
      icon.dataset.ha3dMdiState = "";
      icon.setAttribute("aria-hidden", "true");
      styleMarkerIcon(icon);
      marker.appendChild(icon);
    }
    icon.stateObj = stateObj;
    return;
  }

  // If the HA state/icon component is not available yet, never fall back to
  // emoji: use a deterministic MDI icon from the entity/domain instead.
  let icon = marker.querySelector("ha-icon[data-ha3d-mdi-fallback]");
  if (!icon) {
    marker.replaceChildren();
    icon = document.createElement("ha-icon");
    icon.dataset.ha3dMdiFallback = "";
    icon.setAttribute("aria-hidden", "true");
    styleMarkerIcon(icon);
    marker.appendChild(icon);
  }
  icon.setAttribute("icon", stateObj?.attributes?.icon || fallbackMdi(entity, stateObj));
}

function applyMarkerIcons(panel) {
  const states = panel._hass?.states || {};
  for (const [entity, binding] of panel._lightBindings?.entries?.() || []) {
    renderMarkerIcon(binding, entity, states[entity]);
  }
}

function makeIcon(name, size = 22) {
  const icon = document.createElement("ha-icon");
  icon.setAttribute("icon", name);
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  icon.style.pointerEvents = "none";
  icon.style.setProperty("--mdc-icon-size", `${size}px`);
  return icon;
}

function setIconOnly(button, mdi) {
  if (!button) return;
  const current = button.querySelector("ha-icon[data-ha3d-ui-mdi]");
  if (current?.getAttribute("icon") === mdi && button.childElementCount === 1) return;
  button.replaceChildren();
  const icon = makeIcon(mdi);
  icon.dataset.ha3dUiMdi = "";
  button.appendChild(icon);
}

function standardizeDrawerIcons(panel) {
  for (const button of panel.shadowRoot?.querySelectorAll(
    ".ha3dRenameView,.customDrawerEdit",
  ) || []) {
    setIconOnly(button, "mdi:pencil-outline");
  }
  for (const button of panel.shadowRoot?.querySelectorAll(
    ".customDrawerDelete,#customViews .customRow > button:last-child",
  ) || []) {
    setIconOnly(button, "mdi:delete-outline");
  }
}

function standardizeFilterBar(panel) {
  const bar = panel.shadowRoot?.querySelector("#markerFilterBar");
  if (!bar) return;

  const lights = bar.querySelector('[data-marker-filter="lights"]');
  const devices = bar.querySelector('[data-marker-filter="devices"]');
  const allNone = bar.querySelector('[data-marker-filter="allnone"]');

  setIconOnly(lights, "mdi:lightbulb-group-outline");
  setIconOnly(devices, "mdi:power-plug-outline");
  setIconOnly(
    allNone,
    panel._ha3dMarkerFilterMode === "none" ? "mdi:eye-outline" : "mdi:eye-off-outline",
  );

  if (!bar.__ha3dMdiRefreshBound) {
    bar.__ha3dMdiRefreshBound = true;
    bar.addEventListener("click", () => queueMicrotask(() => standardizeFilterBar(panel)));
  }
}

function standardizeInterface(panel) {
  if (!panel.shadowRoot) return;

  // Buttons that were previously represented by emoji/text glyphs become MDI.
  const viewsButton = panel.shadowRoot.querySelector("#viewsButton");
  if (viewsButton) {
    setIconOnly(viewsButton, "mdi:cog-outline");
    viewsButton.title = "Vistas";
    viewsButton.setAttribute("aria-label", "Vistas");
  }

  const customViewsButton = panel.shadowRoot.querySelector("#customViewsDrawerButton");
  if (customViewsButton) {
    setIconOnly(customViewsButton, "mdi:view-carousel-outline");
    customViewsButton.title = "Vistas personalizadas";
    customViewsButton.setAttribute("aria-label", "Vistas personalizadas");
  }

  standardizeFilterBar(panel);
  standardizeDrawerIcons(panel);

  const drawerButton = panel.shadowRoot.querySelector("#customViewsDrawerButton");
  if (drawerButton && !drawerButton.__ha3dMdiDrawerRefreshBound) {
    drawerButton.__ha3dMdiDrawerRefreshBound = true;
    drawerButton.addEventListener("click", () => queueMicrotask(() => standardizeDrawerIcons(panel)));
  }

  const drawer = panel.shadowRoot.querySelector("#customViewsDrawer");
  if (drawer && !drawer.__ha3dMdiDrawerRefreshBound) {
    drawer.__ha3dMdiDrawerRefreshBound = true;
    drawer.addEventListener("click", () => queueMicrotask(() => standardizeDrawerIcons(panel)));
  }
}

function applyAll(panel) {
  applyMarkerIcons(panel);
  standardizeInterface(panel);
}

function collectPanels(root, found = new Set()) {
  if (!root?.querySelectorAll) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "ha3d-lab-panel") found.add(element);
    if (element.shadowRoot) collectPanels(element.shadowRoot, found);
  }
  return found;
}

function installOnExistingPanels() {
  for (const panel of collectPanels(document)) applyAll(panel);
}

if (!proto.__ha3dIconStandardV2) {
  proto.__ha3dIconStandardV2 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => applyAll(this));
    requestAnimationFrame(() => applyAll(this));
    return result;
  };

  const originalBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindMarkers?.apply(this, args);
    queueMicrotask(() => applyAll(this));
    return result;
  };

  const originalRenderCustomViews = proto._renderCustomViews;
  proto._renderCustomViews = function (...args) {
    const result = originalRenderCustomViews?.apply(this, args);
    queueMicrotask(() => standardizeInterface(this));
    return result;
  };

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: hassDescriptor.configurable ?? true,
      enumerable: hassDescriptor.enumerable ?? false,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        queueMicrotask(() => applyAll(this));
      },
    });
  }

  const originalRestoreCinematicUi = proto._restoreCinematicUi;
  proto._restoreCinematicUi = function (...args) {
    const result = originalRestoreCinematicUi?.apply(this, args);
    queueMicrotask(() => standardizeInterface(this));
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
  setTimeout(installOnExistingPanels, 2500);
}
