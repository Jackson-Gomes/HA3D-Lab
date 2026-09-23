// Scene-prefix action menu.
// Only GLB bindings whose entity_id starts with scene. are affected.
// Example anchor: scene.ar_da_sala -> scene.ar_da_sala, scene.ar_da_sala_23, scene.ar_da_sala_desligar.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isSceneEntity(entity) {
  return String(entity || "").startsWith("scene.");
}

function matchingScenes(panel, baseEntity) {
  const states = panel._hass?.states || {};
  const prefix = `${baseEntity}_`;

  return Object.keys(states)
    .filter((entity) => entity === baseEntity || entity.startsWith(prefix))
    .filter(isSceneEntity)
    .sort((a, b) => {
      if (a === baseEntity) return -1;
      if (b === baseEntity) return 1;
      const an = states[a]?.attributes?.friendly_name || a;
      const bn = states[b]?.attributes?.friendly_name || b;
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });
}

function fallbackLabel(entity, baseEntity) {
  if (entity === baseEntity) return "Padrão";
  const suffix = entity.slice(baseEntity.length).replace(/^_+/, "");
  return suffix
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || entity;
}

function ensureSceneMenu(panel) {
  const root = panel.shadowRoot?.querySelector("#root");
  if (!root) return null;

  let menu = panel.shadowRoot.querySelector("#scenePrefixMenu");
  if (menu) return menu;

  if (!panel.shadowRoot.querySelector("#scenePrefixMenuStyle")) {
    const style = document.createElement("style");
    style.id = "scenePrefixMenuStyle";
    style.textContent = `
      #scenePrefixMenu{
        position:absolute;
        z-index:42;
        display:none;
        min-width:190px;
        max-width:min(300px,calc(100vw - 24px));
        padding:8px;
        border-radius:16px;
        background:color-mix(in srgb,var(--card-background-color,#15171d) 92%,transparent);
        border:1px solid rgba(255,255,255,.14);
        box-shadow:0 12px 34px rgba(0,0,0,.38);
        backdrop-filter:blur(18px);
        -webkit-backdrop-filter:blur(18px);
        pointer-events:auto;
      }
      #scenePrefixMenu.open{display:block}
      #scenePrefixMenu .sceneMenuTitle{
        padding:5px 8px 8px;
        font-size:12px;
        font-weight:700;
        opacity:.78;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      #scenePrefixMenu .sceneMenuList{display:grid;gap:5px}
      #scenePrefixMenu .sceneMenuAction{
        width:100%;
        min-height:38px;
        padding:8px 10px;
        border-radius:11px;
        text-align:left;
        background:#24262c;
        border:1px solid rgba(255,255,255,.10);
        color:var(--primary-text-color,#fff);
        font-size:12px;
        font-weight:600;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      #scenePrefixMenu .sceneMenuAction:hover{background:#30333a}
      #scenePrefixMenu .sceneMenuAction:disabled{opacity:.55}
    `;
    panel.shadowRoot.appendChild(style);
  }

  menu = document.createElement("div");
  menu.id = "scenePrefixMenu";
  menu.setAttribute("role", "menu");
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  menu.addEventListener("click", (event) => event.stopPropagation());
  root.appendChild(menu);

  if (!root.__ha3dScenePrefixCloseHook) {
    root.__ha3dScenePrefixCloseHook = true;
    root.addEventListener("pointerdown", (event) => {
      const activeMenu = panel.shadowRoot?.querySelector("#scenePrefixMenu.open");
      if (!activeMenu || activeMenu.contains(event.target)) return;
      activeMenu.classList.remove("open");
    });
  }

  return menu;
}

function positionMenu(panel, menu, marker) {
  const root = panel.shadowRoot?.querySelector("#root");
  if (!root || !menu || !marker) return;

  const rootRect = root.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 12;

  let left = markerRect.left - rootRect.left + markerRect.width / 2 - menuRect.width / 2;
  left = Math.max(margin, Math.min(left, rootRect.width - menuRect.width - margin));

  let top = markerRect.top - rootRect.top - menuRect.height - 12;
  if (top < margin) top = markerRect.bottom - rootRect.top + 12;
  top = Math.max(margin, Math.min(top, rootRect.height - menuRect.height - margin));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openSceneMenu(panel, baseEntity, marker) {
  const menu = ensureSceneMenu(panel);
  if (!menu) return;

  const scenes = matchingScenes(panel, baseEntity);
  const baseState = panel._hass?.states?.[baseEntity];
  const title = baseState?.attributes?.friendly_name || baseEntity;

  menu.replaceChildren();

  const heading = document.createElement("div");
  heading.className = "sceneMenuTitle";
  heading.textContent = title;
  menu.appendChild(heading);

  const list = document.createElement("div");
  list.className = "sceneMenuList";
  menu.appendChild(list);

  for (const entity of scenes) {
    const state = panel._hass?.states?.[entity];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sceneMenuAction";
    button.setAttribute("role", "menuitem");
    button.textContent = state?.attributes?.friendly_name || fallbackLabel(entity, baseEntity);
    button.title = entity;

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try {
        await panel._hass?.callService?.("scene", "turn_on", {}, { entity_id: entity });
        menu.classList.remove("open");
      } catch (error) {
        console.error("[HA3D] scene action failed", entity, error);
        button.disabled = false;
      }
    });

    list.appendChild(button);
  }

  if (!scenes.length) {
    const empty = document.createElement("div");
    empty.className = "sceneMenuTitle";
    empty.textContent = "Nenhuma cena encontrada";
    list.appendChild(empty);
  }

  menu.classList.add("open");
  requestAnimationFrame(() => positionMenu(panel, menu, marker));
}

function bindSceneMarkers(panel) {
  ensureSceneMenu(panel);

  for (const [entity, binding] of panel._lightBindings?.entries?.() || []) {
    if (!isSceneEntity(entity) || !binding?.marker) continue;
    const marker = binding.marker;
    if (marker.__ha3dScenePrefixMenuBound) continue;
    marker.__ha3dScenePrefixMenuBound = true;
    marker.dataset.ha3dScenePrefix = entity;

    marker.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSceneMenu(panel, entity, marker);
      },
      true,
    );
  }
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
  for (const panel of collectHa3dPanels(document)) bindSceneMarkers(panel);
}

if (!proto.__ha3dScenePrefixMenuV1) {
  proto.__ha3dScenePrefixMenuV1 = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    originalConnectedCallback?.call(this);
    queueMicrotask(() => bindSceneMarkers(this));
  };

  const originalBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindMarkers?.apply(this, args);
    bindSceneMarkers(this);
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
