import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const VIEWS_KEY = "ha3d_lab_custom_views_v1";
const LONG_PRESS_MS = 620;

function persist(panel) {
  localStorage.setItem(VIEWS_KEY, JSON.stringify(panel._customViews || []));
}

function getView(panel, id) {
  return (panel._customViews || []).find((item) => String(item.id) === String(id)) || null;
}

function metrics(panel) {
  if (!panel?._model) return { center: new THREE.Vector3(), minY: 0, maxY: 1, scale: 10 };
  const box = new THREE.Box3().setFromObject(panel._model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { center, minY: box.min.y, maxY: box.max.y, scale: Math.max(size.x, size.y, size.z) || 10 };
}

function defaultZone(panel) {
  const m = metrics(panel);
  return {
    x: m.center.x,
    z: m.center.z,
    y: m.minY + m.scale * 0.006,
    width: m.scale * 0.18,
    depth: m.scale * 0.18,
    show: true,
  };
}

function normalizeZone(panel, zone) {
  const d = defaultZone(panel);
  const src = zone || {};
  const num = (key, fallback) => Number.isFinite(Number(src[key])) ? Number(src[key]) : fallback;
  return {
    x: num("x", d.x),
    z: num("z", d.z),
    y: num("y", d.y),
    width: Math.max(0.001, Math.abs(num("width", d.width))),
    depth: Math.max(0.001, Math.abs(num("depth", d.depth))),
    show: src.show !== false,
  };
}

function ensureStyle(panel) {
  if (!panel?.shadowRoot || panel.shadowRoot.querySelector("#ha3dBottomViewHubStyle")) return;
  const style = document.createElement("style");
  style.id = "ha3dBottomViewHubStyle";
  style.textContent = `
    #viewsPanel #saveViewButton,#viewsPanel #customViews{display:none!important}
    #customViewsDrawer{width:min(390px,calc(100vw - 24px));max-height:min(62vh,560px)}
    #customViewsDrawer .ha3dViewsHubHead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    #customViewsDrawer .ha3dViewsHubHead strong{font-size:12px;flex:1}
    #customViewsDrawer .ha3dViewsHubSave{width:100%;min-height:38px;margin-bottom:8px;background:#18304a}
    #customViewsDrawerList{display:grid;gap:6px}
    #customViewsDrawer .ha3dViewHubRow{display:grid;grid-template-columns:minmax(0,1fr) 36px 38px 38px;gap:6px;align-items:center}
    #customViewsDrawer .ha3dViewHubOpen{min-width:0;min-height:38px;padding:8px 10px;text-align:left;background:#24262c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #customViewsDrawer .ha3dViewHubQuick{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:#20242b;border:1px solid rgba(255,255,255,.1)}
    #customViewsDrawer .ha3dViewHubQuick input{width:18px;height:18px;margin:0}
    #customViewsDrawer .ha3dViewHubEdit,#customViewsDrawer .ha3dViewHubDelete{width:38px;min-height:38px;padding:0;display:grid;place-items:center}
    #customViewsDrawer .ha3dViewHubEdit{background:#293343}#customViewsDrawer .ha3dViewHubDelete{background:#3a2424}
    #ha3dBottomZoneEditor{display:none;margin-top:10px;padding:10px;border-radius:13px;background:rgba(16,18,23,.78);border:1px solid rgba(255,255,255,.12)}
    #ha3dBottomZoneEditor.open{display:block}
    #ha3dBottomZoneEditor h4{margin:0 0 8px;font-size:13px}
    #ha3dBottomZoneEditor .vzRow{display:grid;gap:5px;margin:8px 0}
    #ha3dBottomZoneEditor label{font-size:11px;opacity:.8}
    #ha3dBottomZoneEditor input[type=text],#ha3dBottomZoneEditor input[type=number]{width:100%;padding:7px;border-radius:8px;border:1px solid #ffffff2b;background:#111;color:inherit}
    #ha3dBottomZoneEditor input[type=range]{width:100%}
    #ha3dBottomZoneEditor .vzGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
    #ha3dBottomZoneEditor .vzActions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
    #ha3dBottomZoneEditor .vzCheck{display:flex;align-items:center;gap:7px;font-size:11px}
    #ha3dBottomZoneEditor .vzHint{font-size:10px;opacity:.64;line-height:1.35}
    #ha3dBottomZoneEditor .vzValue{text-align:right;font-size:10px;opacity:.72}
  `;
  panel.shadowRoot.appendChild(style);
}

function disposeMesh(mesh) {
  if (!mesh) return;
  mesh.removeFromParent?.();
  mesh.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach((m) => m?.dispose?.());
    else node.material?.dispose?.();
  });
}

function rebuildZones(panel) {
  if (!panel?._scene) return;
  panel._ha3dBottomViewZones ||= new Map();
  for (const mesh of panel._ha3dBottomViewZones.values()) disposeMesh(mesh);
  panel._ha3dBottomViewZones.clear();

  for (const view of panel._customViews || []) {
    if (!view.zone) continue;
    view.zone = normalizeZone(panel, view.zone);
    const zone = view.zone;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0x4fc3f7,
      transparent: true,
      opacity: zone.show ? 0.16 : 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `HA3D_BottomViewZone_${view.id}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(zone.x, zone.y, zone.z);
    mesh.scale.set(zone.width, zone.depth, 1);
    mesh.renderOrder = 8;
    mesh.userData.ha3dEditorHelper = true;
    mesh.userData.ha3dViewZoneId = String(view.id);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x8ad9ff, transparent: true, opacity: zone.show ? 0.75 : 0, depthWrite: false }),
    );
    edge.position.z = 0.001;
    edge.userData.ha3dEditorHelper = true;
    mesh.add(edge);
    panel._scene.add(mesh);
    panel._ha3dBottomViewZones.set(String(view.id), mesh);
  }
}

function updateZone(panel, view) {
  if (!view?.zone) return;
  view.zone = normalizeZone(panel, view.zone);
  let mesh = panel._ha3dBottomViewZones?.get?.(String(view.id));
  if (!mesh) {
    rebuildZones(panel);
    mesh = panel._ha3dBottomViewZones?.get?.(String(view.id));
  }
  if (!mesh) return;
  const z = view.zone;
  mesh.position.set(z.x, z.y, z.z);
  mesh.scale.set(z.width, z.depth, 1);
  if (mesh.material) mesh.material.opacity = z.show ? 0.16 : 0;
  if (mesh.children?.[0]?.material) mesh.children[0].material.opacity = z.show ? 0.75 : 0;
}

function setQuick(panel, id, checked) {
  for (const view of panel._customViews || []) view.quick_access = checked && String(view.id) === String(id);
  persist(panel);
  renderHub(panel);
}

function activateQuick(panel) {
  const quick = (panel._customViews || []).find((view) => view.quick_access && view.view);
  if (quick?.view) panel._animateCameraTo?.(quick.view);
  else panel._applyCameraView?.("default");
}

function bounds(panel) {
  const m = metrics(panel);
  return {
    minY: m.minY - m.scale * 0.15,
    maxY: m.maxY + m.scale * 0.15,
    step: Math.max(m.scale / 500, 0.001),
    move: Math.max(m.scale / 200, 0.005),
  };
}

function planePoint(panel, event, y) {
  const canvas = panel?._renderer?.domElement;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  panel._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  panel._raycaster.setFromCamera(panel._pointer, panel._camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const point = new THREE.Vector3();
  return panel._raycaster.ray.intersectPlane(plane, point) ? point : null;
}

function openDrawer(panel) {
  const drawer = panel.shadowRoot?.querySelector("#customViewsDrawer");
  const button = panel.shadowRoot?.querySelector("#customViewsDrawerButton");
  if (!drawer) return;
  renderHub(panel);
  drawer.classList.add("open");
  button?.classList.add("active");
}

function closeDrawer(panel) {
  panel.shadowRoot?.querySelector("#customViewsDrawer")?.classList.remove("open");
  panel.shadowRoot?.querySelector("#customViewsDrawerButton")?.classList.remove("active");
}

function startDraw(panel, id) {
  const view = getView(panel, id);
  if (!view) return;
  view.zone = normalizeZone(panel, view.zone || defaultZone(panel));
  view.zone.show = true;
  updateZone(panel, view);
  panel._ha3dBottomZoneDrawId = String(id);
  closeDrawer(panel);
  panel._setStatus?.("Vista: arraste no piso para desenhar o retângulo");
}

function renderZoneEditor(panel, id) {
  const drawer = panel.shadowRoot?.querySelector("#customViewsDrawer");
  const editor = panel.shadowRoot?.querySelector("#ha3dBottomZoneEditor");
  const view = getView(panel, id);
  if (!drawer || !editor || !view) return;
  panel._ha3dBottomEditingView = String(id);
  const lim = bounds(panel);
  const zone = view.zone ? normalizeZone(panel, view.zone) : null;
  if (zone) view.zone = zone;
  const fallback = defaultZone(panel);

  editor.classList.add("open");
  editor.innerHTML = `
    <h4>Editar vista</h4>
    <div class="vzRow"><label>Nome</label><input id="bvName" type="text" value="${String(view.name || "Vista").replaceAll('"', '&quot;')}"></div>
    <label class="vzCheck"><input id="bvQuick" type="checkbox" ${view.quick_access ? "checked" : ""}> Usar como acesso rápido</label>
    <label class="vzCheck"><input id="bvShow" type="checkbox" ${zone?.show !== false ? "checked" : ""} ${zone ? "" : "disabled"}> Mostrar retângulo</label>
    <div class="vzRow"><label>Altura da zona</label><input id="bvY" type="range" min="${lim.minY}" max="${lim.maxY}" step="${lim.step}" value="${zone?.y ?? fallback.y}" ${zone ? "" : "disabled"}><span id="bvYOut" class="vzValue">${Number(zone?.y ?? fallback.y).toFixed(3)}</span></div>
    <div class="vzGrid">
      <div class="vzRow"><label>X</label><input id="bvX" type="number" step="${lim.move}" value="${zone?.x ?? fallback.x}" ${zone ? "" : "disabled"}></div>
      <div class="vzRow"><label>Z</label><input id="bvZ" type="number" step="${lim.move}" value="${zone?.z ?? fallback.z}" ${zone ? "" : "disabled"}></div>
      <div class="vzRow"><label>Largura</label><input id="bvW" type="number" min="${lim.move}" step="${lim.move}" value="${zone?.width ?? fallback.width}" ${zone ? "" : "disabled"}></div>
      <div class="vzRow"><label>Profundidade</label><input id="bvD" type="number" min="${lim.move}" step="${lim.move}" value="${zone?.depth ?? fallback.depth}" ${zone ? "" : "disabled"}></div>
    </div>
    <div class="vzHint">Mesmo oculto, o retângulo continua sendo a área clicável que chama esta vista.</div>
    <div class="vzActions"><button id="bvDraw" type="button">${zone ? "Redesenhar retângulo" : "Criar retângulo"}</button><button id="bvCapture" class="secondary" type="button">Atualizar câmera</button><button id="bvRemoveZone" class="secondary" type="button" ${zone ? "" : "disabled"}>Remover zona</button><button id="bvClose" class="secondary" type="button">Fechar</button></div>
  `;

  const update = () => {
    const current = getView(panel, id);
    if (!current?.zone) return;
    current.zone = normalizeZone(panel, {
      ...current.zone,
      x: Number(editor.querySelector("#bvX")?.value),
      z: Number(editor.querySelector("#bvZ")?.value),
      y: Number(editor.querySelector("#bvY")?.value),
      width: Number(editor.querySelector("#bvW")?.value),
      depth: Number(editor.querySelector("#bvD")?.value),
      show: Boolean(editor.querySelector("#bvShow")?.checked),
    });
    editor.querySelector("#bvYOut").textContent = current.zone.y.toFixed(3);
    persist(panel);
    updateZone(panel, current);
  };

  editor.querySelector("#bvName")?.addEventListener("change", (event) => {
    view.name = String(event.target.value || "Vista").trim().slice(0, 80) || "Vista";
    persist(panel);
    renderHub(panel);
    renderZoneEditor(panel, id);
  });
  editor.querySelector("#bvQuick")?.addEventListener("change", (event) => setQuick(panel, id, event.target.checked));
  for (const sel of ["#bvShow", "#bvY", "#bvX", "#bvZ", "#bvW", "#bvD"]) {
    editor.querySelector(sel)?.addEventListener("input", update);
    editor.querySelector(sel)?.addEventListener("change", update);
  }
  editor.querySelector("#bvDraw")?.addEventListener("click", () => startDraw(panel, id));
  editor.querySelector("#bvCapture")?.addEventListener("click", () => {
    const current = getView(panel, id);
    if (!current) return;
    current.view = panel._captureCameraView?.() || current.view;
    persist(panel);
    panel._setStatus?.(`Câmera atual salva em ${current.name || "vista"}`);
  });
  editor.querySelector("#bvRemoveZone")?.addEventListener("click", () => {
    const current = getView(panel, id);
    if (!current) return;
    delete current.zone;
    persist(panel);
    rebuildZones(panel);
    renderHub(panel);
    renderZoneEditor(panel, id);
  });
  editor.querySelector("#bvClose")?.addEventListener("click", () => {
    editor.classList.remove("open");
    panel._ha3dBottomEditingView = null;
  });
}

function renderHub(panel) {
  ensureStyle(panel);
  const drawer = panel.shadowRoot?.querySelector("#customViewsDrawer");
  const list = panel.shadowRoot?.querySelector("#customViewsDrawerList");
  if (!drawer || !list) return false;

  let head = drawer.querySelector(".ha3dViewsHubHead");
  if (!head) {
    const oldTitle = drawer.querySelector(".customDrawerTitle");
    oldTitle?.remove();
    head = document.createElement("div");
    head.className = "ha3dViewsHubHead";
    head.innerHTML = `<strong>Vistas</strong>`;
    drawer.prepend(head);
  }

  let save = drawer.querySelector("#ha3dViewsHubSave");
  if (!save) {
    save = document.createElement("button");
    save.id = "ha3dViewsHubSave";
    save.className = "ha3dViewsHubSave";
    save.type = "button";
    save.textContent = "+ Salvar vista atual";
    head.insertAdjacentElement("afterend", save);
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      panel._saveCurrentView?.();
      setTimeout(() => { renderHub(panel); rebuildZones(panel); }, 0);
    });
  }

  list.replaceChildren();
  const views = panel._customViews || [];
  if (!views.length) {
    const empty = document.createElement("div");
    empty.className = "customDrawerEmpty";
    empty.textContent = "Nenhuma vista personalizada";
    list.appendChild(empty);
  }

  for (const view of views) {
    const row = document.createElement("div");
    row.className = "ha3dViewHubRow";

    const open = document.createElement("button");
    open.className = "ha3dViewHubOpen";
    open.type = "button";
    open.textContent = view.name || "Vista personalizada";
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      if (view.view) panel._animateCameraTo?.(view.view);
      closeDrawer(panel);
    });

    const quick = document.createElement("label");
    quick.className = "ha3dViewHubQuick";
    quick.title = "Acesso rápido";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(view.quick_access);
    check.setAttribute("aria-label", "Acesso rápido");
    check.addEventListener("change", () => setQuick(panel, view.id, check.checked));
    quick.appendChild(check);

    const edit = document.createElement("button");
    edit.className = "ha3dViewHubEdit";
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Editar vista e área clicável";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      renderZoneEditor(panel, view.id);
    });

    const remove = document.createElement("button");
    remove.className = "ha3dViewHubDelete";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Excluir vista";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      panel._customViews = (panel._customViews || []).filter((item) => String(item.id) !== String(view.id));
      persist(panel);
      rebuildZones(panel);
      renderHub(panel);
    });

    row.append(open, quick, edit, remove);
    list.appendChild(row);
  }

  let editor = drawer.querySelector("#ha3dBottomZoneEditor");
  if (!editor) {
    editor = document.createElement("div");
    editor.id = "ha3dBottomZoneEditor";
    list.insertAdjacentElement("afterend", editor);
  }
  return true;
}

function installBottomButton(panel) {
  let button = panel.shadowRoot?.querySelector("#customViewsDrawerButton");
  if (!button || button.dataset.ha3dBottomViewHub === "1") return Boolean(button);
  const clone = button.cloneNode(true);
  clone.dataset.ha3dBottomViewHub = "1";
  clone.title = "Vistas · toque: acesso rápido · segure: menu";
  clone.setAttribute("aria-label", clone.title);
  button.replaceWith(clone);
  button = clone;

  let timer = null;
  let held = false;
  let startX = 0;
  let startY = 0;
  let moved = false;

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    held = false;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (moved) return;
      held = true;
      openDrawer(panel);
    }, LONG_PRESS_MS);

    const move = (e) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
        moved = true;
        clearTimeout(timer);
      }
    };
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      if (!held && !moved) activateQuick(panel);
      held = false;
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  return true;
}

function installCanvas(panel) {
  const canvas = panel?._renderer?.domElement;
  if (!canvas || canvas.__ha3dBottomViewHubBound) return;
  canvas.__ha3dBottomViewHubBound = true;

  canvas.addEventListener("pointerdown", (event) => {
    const drawId = panel._ha3dBottomZoneDrawId;
    if (drawId) {
      const view = getView(panel, drawId);
      if (!view) { panel._ha3dBottomZoneDrawId = null; return; }
      view.zone = normalizeZone(panel, view.zone || defaultZone(panel));
      const start = planePoint(panel, event, view.zone.y);
      if (!start) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const pointerId = event.pointerId;
      const minimum = metrics(panel).scale * 0.01;
      const controlsEnabled = panel._controls?.enabled;
      if (panel._controls) panel._controls.enabled = false;

      const move = (e) => {
        if (e.pointerId !== pointerId) return;
        const point = planePoint(panel, e, view.zone.y);
        if (!point) return;
        view.zone.x = (start.x + point.x) / 2;
        view.zone.z = (start.z + point.z) / 2;
        view.zone.width = Math.max(minimum, Math.abs(point.x - start.x));
        view.zone.depth = Math.max(minimum, Math.abs(point.z - start.z));
        view.zone.show = true;
        updateZone(panel, view);
      };
      const up = (e) => {
        if (e.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        if (panel._controls) panel._controls.enabled = controlsEnabled !== false;
        panel._ha3dBottomZoneDrawId = null;
        persist(panel);
        updateZone(panel, view);
        openDrawer(panel);
        renderZoneEditor(panel, view.id);
        panel._setStatus?.(`Área vinculada à vista ${view.name || "personalizada"}`);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      return;
    }

    if (panel._editorMode || panel._cameraAnimating || panel._cinematicActive) return;
    const meshes = [...(panel._ha3dBottomViewZones?.values?.() || [])];
    if (!meshes.length) return;
    const rect = canvas.getBoundingClientRect();
    panel._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    panel._raycaster.setFromCamera(panel._pointer, panel._camera);
    const zoneHit = panel._raycaster.intersectObjects(meshes, false)[0];
    if (!zoneHit) return;

    const sceneScale = Math.max(0.001, Number(panel._modelScale) || 10);
    const modelHit = panel._model ? panel._raycaster.intersectObject(panel._model, true).find((hit) => !hit.object?.userData?.ha3dEditorHelper) : null;
    if (modelHit && modelHit.distance + sceneScale * 0.004 < zoneHit.distance) return;

    const id = zoneHit.object?.userData?.ha3dViewZoneId;
    if (!id) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    event.preventDefault();
    event.stopImmediatePropagation();
    const up = (e) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) return;
      const view = getView(panel, id);
      if (view?.view) panel._animateCameraTo?.(view.view);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }, true);
}

function ensure(panel) {
  if (!panel?.shadowRoot) return;
  ensureStyle(panel);
  installBottomButton(panel);
  renderHub(panel);
  installCanvas(panel);
  rebuildZones(panel);
}

if (!proto.__ha3dBottomViewHubV1) {
  proto.__ha3dBottomViewHubV1 = true;

  const oldRenderCustomViews = proto._renderCustomViews;
  proto._renderCustomViews = function (...args) {
    const result = oldRenderCustomViews?.apply(this, args);
    queueMicrotask(() => { installBottomButton(this); renderHub(this); rebuildZones(this); });
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    queueMicrotask(() => ensure(this));
    requestAnimationFrame(() => ensure(this));
    setTimeout(() => ensure(this), 250);
    setTimeout(() => ensure(this), 1000);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    ensure(this);
    return result;
  };
}
