const CUSTOM_VIEWS_KEY = "ha3d_lab_custom_views_v1";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function persistViews(panel) {
  localStorage.setItem(CUSTOM_VIEWS_KEY, JSON.stringify(panel._customViews || []));
}

function cleanName(value, fallback) {
  const name = String(value ?? "").trim();
  return (name || fallback).slice(0, 80);
}

function askViewName(currentName, fallback) {
  const result = window.prompt("Nome da vista personalizada", currentName || fallback);
  if (result === null) return null;
  return cleanName(result, fallback);
}

function renameView(panel, id) {
  const saved = panel._customViews?.find?.((item) => item.id === id);
  if (!saved) return;

  const nextName = askViewName(saved.name, saved.name || "Vista personalizada");
  if (nextName === null) return;

  saved.name = nextName;
  persistViews(panel);
  panel._renderCustomViews?.();
}

function removeView(panel, id) {
  panel._customViews = (panel._customViews || []).filter((item) => item.id !== id);
  persistViews(panel);
  panel._renderCustomViews?.();
}

function ensureStyle(panel) {
  if (!panel.shadowRoot || panel.shadowRoot.querySelector("#ha3dCustomViewDrawerStyle")) return;

  const style = document.createElement("style");
  style.id = "ha3dCustomViewDrawerStyle";
  style.textContent = `
    #customViewsDrawer{
      position:absolute;
      left:50%;
      bottom:calc(max(14px,env(safe-area-inset-bottom)) + 58px);
      transform:translateX(-50%);
      z-index:34;
      display:none;
      width:min(330px,calc(100vw - 24px));
      max-height:min(46vh,420px);
      overflow:auto;
      padding:10px;
      border-radius:16px;
      background:color-mix(in srgb,var(--card-background-color,#15171d) 92%,transparent);
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 12px 34px rgba(0,0,0,.38);
      backdrop-filter:blur(18px);
      -webkit-backdrop-filter:blur(18px);
      pointer-events:auto;
    }
    #customViewsDrawer.open{display:block}
    #customViewsDrawer .customDrawerTitle{
      padding:3px 4px 9px;
      font-size:12px;
      font-weight:750;
      opacity:.8;
    }
    #customViewsDrawerList{display:grid;gap:6px}
    #customViewsDrawer .customDrawerRow{
      display:grid;
      grid-template-columns:minmax(0,1fr) 38px 38px;
      gap:6px;
    }
    #customViewsDrawer .customDrawerOpen{
      min-width:0;
      min-height:38px;
      padding:8px 10px;
      text-align:left;
      background:#24262c;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    #customViewsDrawer .customDrawerEdit,
    #customViewsDrawer .customDrawerDelete{
      width:38px;
      min-height:38px;
      padding:0;
      display:grid;
      place-items:center;
      background:#293343;
    }
    #customViewsDrawer .customDrawerDelete{background:#3a2424}
    #customViewsDrawer .customDrawerEmpty{
      padding:12px 8px;
      font-size:12px;
      opacity:.62;
      text-align:center;
    }
    #customViewsDrawerButton.active{
      background:color-mix(in srgb,var(--primary-color,#03a9f4) 28%,transparent);
      border-color:color-mix(in srgb,var(--primary-color,#03a9f4) 62%,transparent);
    }
    #viewsPanel .customRow{grid-template-columns:minmax(0,1fr) 40px 40px!important}
    #viewsPanel .customRow .ha3dRenameView{
      width:40px;
      padding:0;
      background:#293343;
    }
    #root.ha3d-idle-xray #customViewsDrawer,
    #root.ha3d-cinematic-active #customViewsDrawer{
      display:none!important;
    }
    @media(max-width:600px){
      #customViewsDrawer{
        bottom:calc(max(9px,env(safe-area-inset-bottom)) + 52px);
        width:min(320px,calc(100vw - 18px));
      }
    }
  `;
  panel.shadowRoot.appendChild(style);
}

function renderDrawer(panel) {
  const drawer = panel.shadowRoot?.querySelector("#customViewsDrawer");
  const list = panel.shadowRoot?.querySelector("#customViewsDrawerList");
  if (!drawer || !list) return;

  list.replaceChildren();
  const views = panel._customViews || [];

  if (!views.length) {
    const empty = document.createElement("div");
    empty.className = "customDrawerEmpty";
    empty.textContent = "Nenhuma vista personalizada";
    list.appendChild(empty);
    return;
  }

  for (const saved of views) {
    const row = document.createElement("div");
    row.className = "customDrawerRow";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "customDrawerOpen";
    open.textContent = saved.name || "Vista personalizada";
    open.title = saved.name || "Vista personalizada";
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      panel._animateCameraTo?.(saved.view);
      drawer.classList.remove("open");
      panel.shadowRoot?.querySelector("#customViewsDrawerButton")?.classList.remove("active");
    });

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "customDrawerEdit";
    edit.textContent = "✎";
    edit.title = "Renomear vista";
    edit.setAttribute("aria-label", "Renomear vista");
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      renameView(panel, saved.id);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "customDrawerDelete";
    remove.textContent = "×";
    remove.title = "Excluir vista";
    remove.setAttribute("aria-label", "Excluir vista");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeView(panel, saved.id);
    });

    row.append(open, edit, remove);
    list.appendChild(row);
  }
}

function decorateExistingCustomRows(panel) {
  const host = panel.shadowRoot?.querySelector("#customViews");
  if (!host) return;

  const rows = [...host.querySelectorAll(".customRow")];
  const views = panel._customViews || [];

  rows.forEach((row, index) => {
    const saved = views[index];
    if (!saved || row.querySelector(".ha3dRenameView")) return;

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "ha3dRenameView";
    rename.textContent = "✎";
    rename.title = "Renomear vista";
    rename.setAttribute("aria-label", "Renomear vista");
    rename.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      renameView(panel, saved.id);
    });

    const remove = row.lastElementChild;
    row.insertBefore(rename, remove || null);
  });
}

function ensureDrawer(panel) {
  const root = panel.shadowRoot?.querySelector("#root");
  const bar = panel.shadowRoot?.querySelector("#markerFilterBar");
  if (!root || !bar) return false;

  ensureStyle(panel);

  let button = panel.shadowRoot.querySelector("#customViewsDrawerButton");
  if (!button) {
    button = document.createElement("button");
    button.id = "customViewsDrawerButton";
    button.className = "markerFilterButton";
    button.type = "button";
    button.textContent = "▤";
    button.title = "Vistas personalizadas";
    button.setAttribute("aria-label", "Vistas personalizadas");
    bar.appendChild(button);
  }

  let drawer = panel.shadowRoot.querySelector("#customViewsDrawer");
  if (!drawer) {
    drawer = document.createElement("div");
    drawer.id = "customViewsDrawer";
    drawer.className = "glass";
    drawer.innerHTML = `
      <div class="customDrawerTitle">Vistas personalizadas</div>
      <div id="customViewsDrawerList"></div>
    `;
    drawer.addEventListener("pointerdown", (event) => event.stopPropagation());
    drawer.addEventListener("click", (event) => event.stopPropagation());
    root.appendChild(drawer);
  }

  if (!button.__ha3dCustomViewsDrawerBound) {
    button.__ha3dCustomViewsDrawerBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = !drawer.classList.contains("open");
      drawer.classList.toggle("open", open);
      button.classList.toggle("active", open);
      if (open) renderDrawer(panel);
    });
  }

  if (!root.__ha3dCustomViewsDrawerCloseBound) {
    root.__ha3dCustomViewsDrawerCloseBound = true;
    root.addEventListener("pointerdown", (event) => {
      const activeDrawer = panel.shadowRoot?.querySelector("#customViewsDrawer.open");
      const activeButton = panel.shadowRoot?.querySelector("#customViewsDrawerButton");
      if (!activeDrawer) return;
      if (activeDrawer.contains(event.target) || activeButton?.contains?.(event.target)) return;
      activeDrawer.classList.remove("open");
      activeButton?.classList.remove("active");
    });
  }

  renderDrawer(panel);
  decorateExistingCustomRows(panel);
  return true;
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
  for (const panel of collectPanels(document)) ensureDrawer(panel);
}

if (!proto.__ha3dCustomViewDrawerV1) {
  proto.__ha3dCustomViewDrawerV1 = true;

  proto._saveCurrentView = function () {
    if (!this._model) return;

    const fallback = `Vista ${this._customViews.length + 1}`;
    const name = askViewName(fallback, fallback);
    if (name === null) return;

    this._customViews.push({
      id: `${Date.now()}`,
      name,
      view: this._captureCameraView(),
    });
    persistViews(this);
    this._renderCustomViews?.();
  };

  const originalRenderCustomViews = proto._renderCustomViews;
  proto._renderCustomViews = function (...args) {
    const result = originalRenderCustomViews?.apply(this, args);
    decorateExistingCustomRows(this);
    ensureDrawer(this);
    renderDrawer(this);
    return result;
  };

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => ensureDrawer(this));
    requestAnimationFrame(() => ensureDrawer(this));
    return result;
  };

  const originalBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindMarkers?.apply(this, args);
    ensureDrawer(this);
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
  setTimeout(installOnExistingPanels, 2500);
}
