// Bottom marker filter bar: lights, devices, climate, openings, and all/none.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function ensureFilterState(panel) {
  if (!panel._ha3dMarkerFilterMode) panel._ha3dMarkerFilterMode = "all";
}

function entityParts(entity) {
  const [domain = "", objectId = ""] = String(entity || "").toLowerCase().split(".", 2);
  return { domain, objectId };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isClimateScene(entity, state) {
  const { domain, objectId } = entityParts(entity);
  if (domain !== "scene") return false;

  // Scene-based IR/HVAC setups stay scenes so their existing action menus keep
  // working, but they can still participate in the Climate filter.
  if (/(^|_)(ar|ar_condicionado|arcondicionado|air|air_conditioner|aircon|climate|hvac|ventilador|fan)(_|$)/.test(objectId)) {
    return true;
  }

  const friendlyName = normalizeText(state?.attributes?.friendly_name);
  return /\b(ar condicionado|air conditioner|aircon|climate|hvac|ventilador|fan)\b/.test(friendlyName);
}

function isClimateEntity(entity, state) {
  const { domain } = entityParts(entity);
  return domain === "climate" || domain === "fan" || isClimateScene(entity, state);
}

function isOpeningEntity(entity, state) {
  const { domain, objectId } = entityParts(entity);
  const deviceClass = String(state?.attributes?.device_class || "").toLowerCase();

  if (domain === "binary_sensor") {
    if (["door", "garage_door", "opening", "window"].includes(deviceClass)) return true;
    return /(^|_)(porta|janela|door|window)(_|$)/.test(objectId);
  }

  if (domain === "cover") {
    if (["door", "garage", "window"].includes(deviceClass)) return true;
    return /(^|_)(porta|janela|door|window)(_|$)/.test(objectId);
  }

  return false;
}

function shouldShowEntity(entity, state, mode) {
  if (mode === "none") return false;
  if (mode === "all") return true;

  const { domain } = entityParts(entity);
  if (mode === "lights") return domain === "light";
  if (mode === "devices") return domain !== "light";
  if (mode === "climate") return isClimateEntity(entity, state);
  if (mode === "openings") return isOpeningEntity(entity, state);
  return true;
}

function syncFilterButtons(panel) {
  const bar = panel.shadowRoot?.querySelector("#markerFilterBar");
  if (!bar) return;

  const mode = panel._ha3dMarkerFilterMode || "all";
  for (const button of bar.querySelectorAll("[data-marker-filter]")) {
    const filter = button.dataset.markerFilter;
    const active =
      filter === mode ||
      (filter === "allnone" && (mode === "all" || mode === "none"));
    button.classList.toggle("active", active);
  }

  const allNone = bar.querySelector('[data-marker-filter="allnone"]');
  if (allNone) {
    const showAllAction = mode !== "all";
    const icon = allNone.querySelector("ha-icon");
    if (icon) {
      icon.setAttribute("icon", showAllAction ? "mdi:eye-outline" : "mdi:eye-off-outline");
    } else {
      allNone.textContent = showAllAction ? "◉" : "○";
    }
    allNone.title = showAllAction ? "Mostrar todos os marcadores" : "Ocultar todos os marcadores";
    allNone.setAttribute("aria-label", allNone.title);
  }
}

function applyMarkerFilter(panel) {
  ensureFilterState(panel);
  if (panel._cinematicActive) return;

  const mode = panel._ha3dMarkerFilterMode;
  const states = panel._hass?.states || {};
  for (const [entity, binding] of panel._lightBindings?.entries?.() || []) {
    if (!binding?.marker) continue;
    const visible = shouldShowEntity(entity, states[entity], mode);

    // Visibility belongs exclusively to the filter. Other late-loaded modules
    // may style marker display for icon layout, so use a dedicated class with
    // !important instead of competing over marker.style.display.
    binding.marker.classList.toggle("ha3d-filter-hidden", !visible);
  }

  syncFilterButtons(panel);
}

function setFilterMode(panel, mode) {
  ensureFilterState(panel);
  panel._ha3dMarkerFilterMode = mode;
  applyMarkerFilter(panel);
}

function installFilterBar(panel) {
  const root = panel.shadowRoot?.querySelector("#root");
  if (!root) return false;

  let bar = panel.shadowRoot.querySelector("#markerFilterBar");
  if (bar?.dataset?.ha3dFilterVersion === "5") {
    applyMarkerFilter(panel);
    return true;
  }

  // Replace older filter bars so their old click-handler closure cannot apply
  // earlier filtering rules to the current buttons.
  bar?.remove();

  if (!panel.shadowRoot.querySelector("#ha3dMarkerFilterStyleV5")) {
    const style = document.createElement("style");
    style.id = "ha3dMarkerFilterStyleV5";
    style.textContent = `
      .lightMarker.ha3d-filter-hidden{display:none!important}
      #markerFilterBar{
        position:absolute;
        left:50%;
        bottom:max(14px,env(safe-area-inset-bottom));
        transform:translateX(-50%);
        z-index:31;
        display:flex;
        align-items:center;
        gap:6px;
        padding:6px;
        border-radius:16px;
        background:color-mix(in srgb,var(--card-background-color,#15171d) 88%,transparent);
        border:1px solid rgba(255,255,255,.12);
        box-shadow:0 8px 28px rgba(0,0,0,.30);
        backdrop-filter:blur(16px);
        -webkit-backdrop-filter:blur(16px);
        pointer-events:auto;
        transition:opacity .22s ease;
      }
      .markerFilterButton{
        width:40px;
        height:36px;
        min-height:36px;
        padding:0;
        display:grid;
        place-items:center;
        border-radius:11px;
        border:1px solid transparent;
        background:transparent;
        color:var(--primary-text-color,#fff);
        font-size:19px;
        line-height:1;
        font-weight:650;
        box-shadow:none;
      }
      .markerFilterButton ha-icon{
        width:22px;
        height:22px;
        pointer-events:none;
        --mdc-icon-size:22px;
      }
      .markerFilterButton:hover{background:rgba(255,255,255,.08)}
      .markerFilterButton.active{
        background:color-mix(in srgb,var(--primary-color,#03a9f4) 28%,transparent);
        border-color:color-mix(in srgb,var(--primary-color,#03a9f4) 62%,transparent);
      }
      #root.ha3d-cinematic-active #markerFilterBar{opacity:0;pointer-events:none}
      @media(max-width:600px){
        #markerFilterBar{bottom:max(9px,env(safe-area-inset-bottom));gap:3px;padding:4px}
        .markerFilterButton{width:38px;height:34px;min-height:34px;font-size:18px}
      }
    `;
    panel.shadowRoot.appendChild(style);
  }

  bar = document.createElement("div");
  bar.id = "markerFilterBar";
  bar.className = "glass";
  bar.dataset.ha3dFilterVersion = "5";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Filtros de marcadores");
  bar.innerHTML = `
    <button class="markerFilterButton" data-marker-filter="lights" type="button" title="Lâmpadas" aria-label="Lâmpadas"><ha-icon icon="mdi:lightbulb-group-outline"></ha-icon></button>
    <button class="markerFilterButton" data-marker-filter="devices" type="button" title="Aparelhos" aria-label="Aparelhos"><ha-icon icon="mdi:power-plug-outline"></ha-icon></button>
    <button class="markerFilterButton" data-marker-filter="climate" type="button" title="Climatização" aria-label="Climatização"><ha-icon icon="mdi:hvac"></ha-icon></button>
    <button class="markerFilterButton" data-marker-filter="openings" type="button" title="Portas e janelas" aria-label="Portas e janelas"><ha-icon icon="mdi:door-open"></ha-icon></button>
    <button class="markerFilterButton" data-marker-filter="allnone" type="button" title="Ocultar todos os marcadores" aria-label="Ocultar todos os marcadores"><ha-icon icon="mdi:eye-off-outline"></ha-icon></button>
  `;

  bar.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-marker-filter]");
    if (!button) return;
    event.stopPropagation();

    const filter = button.dataset.markerFilter;
    if (filter === "allnone") {
      setFilterMode(panel, panel._ha3dMarkerFilterMode === "all" ? "none" : "all");
      return;
    }

    setFilterMode(panel, filter);
  });

  root.appendChild(bar);
  applyMarkerFilter(panel);
  return true;
}

function collectHa3dPanels(root, found = new Set()) {
  if (!root?.querySelectorAll) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "ha3d-lab-panel") found.add(element);
    if (element.shadowRoot) collectHa3dPanels(element.shadowRoot, found);
  }
  return found;
}

function installOnExistingPanels() {
  for (const panel of collectHa3dPanels(document)) {
    ensureFilterState(panel);
    installFilterBar(panel);
    applyMarkerFilter(panel);
  }
}

if (!proto.__ha3dMarkerFilterBarV5) {
  proto.__ha3dMarkerFilterBarV5 = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    ensureFilterState(this);
    originalConnectedCallback?.call(this);
    queueMicrotask(() => installFilterBar(this));
  };

  const originalBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindMarkers?.apply(this, args);
    installFilterBar(this);
    applyMarkerFilter(this);
    return result;
  };

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: true,
      enumerable: hassDescriptor.enumerable,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        queueMicrotask(() => {
          installFilterBar(this);
          applyMarkerFilter(this);
        });
      },
    });
  }

  const originalRestoreCinematicUi = proto._restoreCinematicUi;
  proto._restoreCinematicUi = function (...args) {
    const result = originalRestoreCinematicUi?.apply(this, args);
    installFilterBar(this);
    applyMarkerFilter(this);
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
  setTimeout(installOnExistingPanels, 2500);
}
