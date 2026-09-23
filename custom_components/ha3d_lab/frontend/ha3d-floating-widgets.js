import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const TYPES = new Set(["text", "state", "image", "chart"]);
const inspectorMeshState = new WeakMap();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function widgets(panel) {
  return Array.isArray(panel?._config?.floating_widgets) ? panel._config.floating_widgets : [];
}

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function findAnchor(panel, key) {
  if (!panel?._model || !key) return null;
  let found = null;
  panel._model.traverse((object) => {
    if (found) return;
    const candidate = objectKey(object);
    if (candidate === key) found = object;
  });
  return found;
}

function boundsFor(object) {
  if (!object) return null;
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}

function centerFor(object) {
  const box = boundsFor(object);
  if (box) return box.getCenter(new THREE.Vector3());
  return object?.getWorldPosition?.(new THREE.Vector3()) || new THREE.Vector3();
}

function runtimeFor(panel, id) {
  return panel?._ha3dFloatingWidgets?.get?.(id) || null;
}

function selectedWidget(panel) {
  const id = panel?._selectedObject?.userData?.ha3dFloatingWidgetId;
  return id ? runtimeFor(panel, id) : null;
}

function nextId(panel, type) {
  const used = new Set(widgets(panel).map((item) => item.id));
  const prefix = type === "chart" ? "grafico" : type === "image" ? "imagem" : type === "state" ? "estado" : "texto";
  let index = 1;
  while (used.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

async function saveWidgets(panel, list, status = null) {
  panel._config = await panel._hass.callApi("POST", "ha3d_lab_lab/floating_widgets", { floating_widgets: list });
  if (status) panel._setStatus?.(status);
  refreshChooser(panel);
  return panel._config;
}

function ensureUi(panel) {
  if (!panel?.shadowRoot) return null;
  if (!panel.shadowRoot.querySelector("#ha3dFloatingWidgetStyle")) {
    const style = document.createElement("style");
    style.id = "ha3dFloatingWidgetStyle";
    style.textContent = `
      #ha3dFloatingWidgetLayer{position:absolute;inset:0;z-index:31;pointer-events:none;overflow:hidden}
      .ha3dFloatCard{position:absolute;min-width:150px;max-width:min(300px,42vw);padding:10px 12px;border:1px solid rgba(77,231,255,.72);border-radius:12px;background:linear-gradient(145deg,rgba(2,20,30,.92),rgba(3,35,49,.82));box-shadow:0 9px 30px rgba(0,0,0,.36),0 0 18px rgba(11,188,255,.18);backdrop-filter:blur(10px);color:#e8fbff;font:500 12px/1.3 system-ui,sans-serif;transform-origin:left center;pointer-events:auto;opacity:0;transition:opacity .18s ease,border-color .18s ease,box-shadow .18s ease}
      .ha3dFloatCard.visible{opacity:1}.ha3dFloatCard::before{content:"";position:absolute;left:-8px;top:50%;width:14px;height:14px;background:rgba(3,31,44,.9);border-left:1px solid rgba(77,231,255,.72);border-bottom:1px solid rgba(77,231,255,.72);transform:translateY(-50%) rotate(45deg)}
      .ha3dFloatCard.left{transform-origin:right center}.ha3dFloatCard.left::before{left:auto;right:-8px;transform:translateY(-50%) rotate(225deg)}
      .ha3dFloatTitle{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#72eaff;opacity:.9;margin-bottom:4px}.ha3dFloatValue{font-size:17px;font-weight:700;color:#fff;white-space:pre-wrap;overflow-wrap:anywhere}.ha3dFloatSub{font-size:10px;opacity:.62;margin-top:4px}.ha3dFloatImage{display:none;width:220px;max-width:36vw;max-height:170px;object-fit:contain;border-radius:8px;background:rgba(0,0,0,.18)}.ha3dFloatChart{display:none;width:230px;height:82px;overflow:visible}.ha3dFloatChart polyline{fill:none;stroke:#4de7ff;stroke-width:2.2;vector-effect:non-scaling-stroke}.ha3dFloatChart line{stroke:rgba(77,231,255,.18);stroke-width:1}
      .ha3dFloatCard.unavailable{border-color:rgba(255,96,114,.78);box-shadow:0 9px 30px rgba(0,0,0,.36),0 0 18px rgba(255,41,70,.18)}.ha3dFloatCard.unavailable .ha3dFloatTitle{color:#ff6072}
      #ha3dWidgetToolbar{display:grid;grid-template-columns:minmax(0,1fr) repeat(4,auto);gap:5px;margin:8px 0}#ha3dWidgetToolbar button{padding:6px 7px;font-size:11px}
      .ha3dRangeLine{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.ha3dRangeLine output{font-size:11px;opacity:.75;min-width:48px;text-align:right}
    `;
    panel.shadowRoot.appendChild(style);
  }
  let layer = panel.shadowRoot.querySelector("#ha3dFloatingWidgetLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "ha3dFloatingWidgetLayer";
    panel.shadowRoot.querySelector("#root")?.appendChild(layer);
  }
  return layer;
}

function makeCard(panel, config) {
  const layer = ensureUi(panel);
  if (!layer) return null;
  const card = document.createElement("div");
  card.className = "ha3dFloatCard";
  card.dataset.ha3dFloatingWidgetId = config.id;
  card.innerHTML = `<div class="ha3dFloatTitle"></div><div class="ha3dFloatValue"></div><img class="ha3dFloatImage" alt=""><svg class="ha3dFloatChart" viewBox="0 0 230 82" preserveAspectRatio="none"><line x1="0" y1="81" x2="230" y2="81"></line><polyline points=""></polyline></svg><div class="ha3dFloatSub"></div>`;
  card.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = runtimeFor(panel, config.id)?.config || config;
    if (current.entity_id) panel._openNativeMoreInfo?.(current.entity_id);
  });
  layer.appendChild(card);
  return card;
}

function helperSize(panel) {
  return Math.max(0.05, finite(panel?._modelScale, 10) * 0.009);
}

function createRuntime(panel, config) {
  const anchor = findAnchor(panel, config.anchor);
  const handle = new THREE.Group();
  handle.name = `HA3D_FloatingWidget_${config.id}`;
  handle.userData.ha3dFloatingWidgetId = config.id;
  handle.userData.ha3dEditorHelper = true;
  const base = centerFor(anchor);
  handle.position.copy(base).add(new THREE.Vector3(...(config.offset || [0, 0, 0])));
  handle.scale.setScalar(clamp(config.scale, 0.2, 4));

  const size = helperSize(panel);
  const helper = new THREE.Mesh(
    new THREE.OctahedronGeometry(size, 0),
    new THREE.MeshBasicMaterial({ color: 0x4de7ff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
  );
  helper.renderOrder = 1200;
  helper.userData.ha3dFloatingWidgetHandle = handle;
  handle.add(helper);
  panel._scene?.add(handle);

  return { config, anchor, handle, helper, card: makeCard(panel, config), historyKey: null };
}

function disposeRuntime(runtime) {
  runtime?.card?.remove?.();
  runtime?.handle?.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach((material) => material?.dispose?.());
    else node.material?.dispose?.();
  });
  runtime?.handle?.removeFromParent?.();
}

function rebuild(panel) {
  for (const runtime of panel?._ha3dFloatingWidgets?.values?.() || []) disposeRuntime(runtime);
  panel._ha3dFloatingWidgets = new Map();
  panel._ha3dFloatingWidgetPickables = [];
  for (const config of widgets(panel)) {
    if (!config?.id || !TYPES.has(config.type)) continue;
    const runtime = createRuntime(panel, config);
    panel._ha3dFloatingWidgets.set(config.id, runtime);
    panel._ha3dFloatingWidgetPickables.push(runtime.helper);
  }
  setEditorHelperVisibility(panel);
  refreshChooser(panel);
}

function setEditorHelperVisibility(panel) {
  const editing = Boolean(panel?._editorMode);
  for (const runtime of panel?._ha3dFloatingWidgets?.values?.() || []) runtime.helper.visible = editing;
  const layer = panel?.shadowRoot?.querySelector("#ha3dFloatingWidgetLayer");
  if (layer) layer.style.display = editing ? "none" : "block";
}

function refreshChooser(panel) {
  const select = panel?.shadowRoot?.querySelector("#ha3dFloatingWidgetSelect");
  if (!select) return;
  const current = panel?._selectedObject?.userData?.ha3dFloatingWidgetId || "";
  select.replaceChildren(new Option("Widgets…", ""));
  for (const config of widgets(panel)) select.appendChild(new Option(`${config.name || config.id} · ${config.type}`, config.id));
  select.value = current;
}

function installToolbar(panel) {
  ensureUi(panel);
  const transformRow = panel?.shadowRoot?.querySelector("#ha3dEditor .ha3dTransform");
  if (!transformRow || panel.shadowRoot.querySelector("#ha3dWidgetToolbar")) return;
  const row = document.createElement("div");
  row.id = "ha3dWidgetToolbar";
  row.innerHTML = `<select id="ha3dFloatingWidgetSelect" title="Selecionar widget" style="min-width:0;padding:7px;border-radius:8px;background:#111;color:inherit;border:1px solid #ffffff2b"></select><button class="secondary" data-widget-type="text" type="button">+ Texto</button><button class="secondary" data-widget-type="state" type="button">+ Estado</button><button class="secondary" data-widget-type="image" type="button">+ Imagem</button><button class="secondary" data-widget-type="chart" type="button">+ Gráfico</button>`;
  transformRow.insertAdjacentElement("afterend", row);
  row.querySelector("#ha3dFloatingWidgetSelect")?.addEventListener("change", (event) => {
    if (event.target.value) panel._selectFloatingWidget?.(event.target.value);
  });
  row.querySelectorAll("[data-widget-type]").forEach((button) => button.addEventListener("click", () => panel._createFloatingWidget?.(button.dataset.widgetType)));
  refreshChooser(panel);
}

function entityOptions(panel) {
  return Object.entries(panel?._hass?.states || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, state]) => `<option value="${escapeHtml(entityId)}">${escapeHtml(state.attributes?.friendly_name || entityId)} — ${escapeHtml(entityId)}</option>`)
    .join("");
}

function renderForm(panel, runtime) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!body || !runtime) return;
  const c = runtime.config;
  const pos = runtime.handle.position;
  const scale = clamp(runtime.handle.scale.x, 0.2, 4);
  body.innerHTML = `
    <div class="ha3dRow"><label>Widget flutuante</label><input id="ha3dFwName" value="${escapeHtml(c.name || c.id)}"></div>
    <div class="ha3dRow"><label>Objeto âncora</label><input disabled value="${escapeHtml(c.anchor)}"></div>
    <div class="ha3dRow"><label>Tipo</label><select id="ha3dFwType"><option value="text" ${c.type === "text" ? "selected" : ""}>Texto</option><option value="state" ${c.type === "state" ? "selected" : ""}>Estado</option><option value="image" ${c.type === "image" ? "selected" : ""}>Imagem</option><option value="chart" ${c.type === "chart" ? "selected" : ""}>Gráfico</option></select></div>
    <div class="ha3dRow"><label>Entidade Home Assistant</label><input id="ha3dFwEntity" list="ha3dFwEntities" autocomplete="off" placeholder="sensor.alguma_coisa" value="${escapeHtml(c.entity_id || "")}"><datalist id="ha3dFwEntities">${entityOptions(panel)}</datalist></div>
    <div class="ha3dRow"><label>Atributo (opcional)</label><input id="ha3dFwAttribute" placeholder="temperature" value="${escapeHtml(c.attribute || "")}"></div>
    <div class="ha3dRow" id="ha3dFwTextRow"><label>Texto</label><textarea id="ha3dFwText" placeholder="Temperatura: {state}">${escapeHtml(c.text || "")}</textarea><span class="ha3dHint">Aceita {state}, {name}, {entity_id} e {attribute}.</span></div>
    <div class="ha3dRow" id="ha3dFwImageRow"><label>URL da imagem (opcional)</label><input id="ha3dFwImage" placeholder="/local/imagem.png" value="${escapeHtml(c.image_url || "")}"><span class="ha3dHint">Sem URL, usa entity_picture da entidade quando existir.</span></div>
    <div class="ha3dRow" id="ha3dFwChartRow"><label>Histórico do gráfico</label><div class="ha3dRangeLine"><input id="ha3dFwChartHours" type="range" min="1" max="168" step="1" value="${clamp(c.chart_hours || 24, 1, 168)}"><output id="ha3dFwChartHoursOut">${clamp(c.chart_hours || 24, 1, 168)} h</output></div></div>
    <div class="ha3dRow"><label>Exibição</label><select id="ha3dFwVisibility"><option value="always" ${c.visibility === "always" ? "selected" : ""}>Sempre</option><option value="zoom" ${c.visibility === "zoom" ? "selected" : ""}>Quando aproximar</option><option value="click" ${c.visibility === "click" ? "selected" : ""}>Quando clicar no objeto</option></select></div>
    <div class="ha3dRow" id="ha3dFwZoomRow"><label>Distância para aparecer</label><div class="ha3dRangeLine"><input id="ha3dFwZoom" type="range" min="0.15" max="3" step="0.05" value="${clamp(c.zoom_threshold || 1.15, 0.15, 3)}"><output id="ha3dFwZoomOut">${clamp(c.zoom_threshold || 1.15, 0.15, 3).toFixed(2)}×</output></div><span class="ha3dHint">Multiplicador do tamanho da cena. Menor = precisa chegar mais perto.</span></div>
    <div class="ha3dRow"><label>Tamanho</label><div class="ha3dRangeLine"><input id="ha3dFwScale" type="range" min="0.35" max="2.5" step="0.05" value="${scale}"><output id="ha3dFwScaleOut">${scale.toFixed(2)}×</output></div><span class="ha3dHint">Também pode usar Escalar no gizmo.</span></div>
    <div class="ha3dRow"><label>Posição mundial X / Y / Z</label><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"><input id="ha3dFwPx" type="number" step="0.01" value="${pos.x.toFixed(4)}"><input id="ha3dFwPy" type="number" step="0.01" value="${pos.y.toFixed(4)}"><input id="ha3dFwPz" type="number" step="0.01" value="${pos.z.toFixed(4)}"></div></div>
    <div class="ha3dRow"><label><input id="ha3dFwEnabled" type="checkbox" ${c.enabled !== false ? "checked" : ""}> Ativo</label></div>
    <div class="ha3dEditorActions"><button id="ha3dFwSave" type="button">Salvar widget</button><button id="ha3dFwDelete" class="secondary" type="button">Remover widget</button></div>
  `;

  const typeSelect = body.querySelector("#ha3dFwType");
  const visibility = body.querySelector("#ha3dFwVisibility");
  const syncRows = () => {
    const type = typeSelect.value;
    body.querySelector("#ha3dFwTextRow").style.display = type === "text" ? "grid" : "none";
    body.querySelector("#ha3dFwImageRow").style.display = type === "image" ? "grid" : "none";
    body.querySelector("#ha3dFwChartRow").style.display = type === "chart" ? "grid" : "none";
    body.querySelector("#ha3dFwZoomRow").style.display = visibility.value === "zoom" ? "grid" : "none";
  };
  typeSelect.addEventListener("change", syncRows);
  visibility.addEventListener("change", syncRows);
  body.querySelector("#ha3dFwZoom")?.addEventListener("input", (event) => { body.querySelector("#ha3dFwZoomOut").value = `${Number(event.target.value).toFixed(2)}×`; });
  body.querySelector("#ha3dFwScale")?.addEventListener("input", (event) => {
    const value = clamp(event.target.value, 0.35, 2.5);
    runtime.handle.scale.setScalar(value);
    body.querySelector("#ha3dFwScaleOut").value = `${value.toFixed(2)}×`;
  });
  body.querySelector("#ha3dFwChartHours")?.addEventListener("input", (event) => { body.querySelector("#ha3dFwChartHoursOut").value = `${event.target.value} h`; });
  body.querySelector("#ha3dFwSave")?.addEventListener("click", () => panel._saveFloatingWidgetForm?.(c.id));
  body.querySelector("#ha3dFwDelete")?.addEventListener("click", () => panel._removeFloatingWidget?.(c.id));
  syncRows();
}

function stateValue(panel, config) {
  const state = config.entity_id ? panel?._hass?.states?.[config.entity_id] : null;
  if (!state) return { state: null, value: "—", unavailable: Boolean(config.entity_id) };
  const unavailable = ["unknown", "unavailable"].includes(state.state);
  let value = config.attribute ? state.attributes?.[config.attribute] : state.state;
  if (value == null) value = "—";
  const unit = !config.attribute ? state.attributes?.unit_of_measurement : null;
  return { state, value: `${value}${unit ? ` ${unit}` : ""}`, unavailable };
}

function textTemplate(panel, config) {
  const info = stateValue(panel, config);
  const state = info.state;
  const raw = String(config.text || config.name || "");
  return raw
    .replaceAll("{state}", String(info.value ?? "—"))
    .replaceAll("{name}", String(state?.attributes?.friendly_name || config.name || config.entity_id || ""))
    .replaceAll("{entity_id}", String(config.entity_id || ""))
    .replaceAll("{attribute}", String(config.attribute ? state?.attributes?.[config.attribute] ?? "—" : ""));
}

function chartPoints(values) {
  if (!values?.length) return "";
  const nums = values.map((item) => Number(item)).filter(Number.isFinite);
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = Math.max(1e-9, max - min);
  const width = 230;
  const height = 75;
  return nums.map((value, index) => {
    const x = nums.length === 1 ? width / 2 : (index / (nums.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) + 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

async function ensureHistory(panel, runtime) {
  const config = runtime.config;
  if (!config.entity_id || config.type !== "chart") return;
  panel._ha3dFloatingHistory ||= new Map();
  const hours = clamp(config.chart_hours || 24, 1, 168);
  const key = `${config.entity_id}|${config.attribute || ""}|${hours}`;
  const cached = panel._ha3dFloatingHistory.get(key);
  if (cached && Date.now() - cached.at < 60000) return;
  panel._ha3dFloatingHistory.set(key, { at: Date.now(), loading: true, values: cached?.values || [] });
  try {
    const start = new Date(Date.now() - hours * 3600000).toISOString();
    const response = await panel._hass.callApi("GET", `history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(config.entity_id)}&minimal_response&no_attributes`);
    const rows = Array.isArray(response?.[0]) ? response[0] : [];
    const values = rows.map((row) => config.attribute ? row?.attributes?.[config.attribute] : row?.state).map(Number).filter(Number.isFinite);
    panel._ha3dFloatingHistory.set(key, { at: Date.now(), loading: false, values: values.slice(-240) });
  } catch (_error) {
    panel._ha3dFloatingHistory.set(key, { at: Date.now(), loading: false, values: cached?.values || [] });
  }
  runtime.historyKey = key;
}

function updateCard(panel, runtime) {
  const { config, card } = runtime;
  if (!card) return;
  const title = card.querySelector(".ha3dFloatTitle");
  const value = card.querySelector(".ha3dFloatValue");
  const sub = card.querySelector(".ha3dFloatSub");
  const image = card.querySelector(".ha3dFloatImage");
  const chart = card.querySelector(".ha3dFloatChart");
  const info = stateValue(panel, config);
  const friendly = info.state?.attributes?.friendly_name || config.name || config.entity_id || "Informação";

  card.classList.toggle("unavailable", info.unavailable);
  title.textContent = friendly;
  value.style.display = "block";
  image.style.display = "none";
  chart.style.display = "none";
  sub.textContent = config.entity_id || "";

  if (config.type === "text") {
    value.textContent = textTemplate(panel, config);
  } else if (config.type === "state") {
    value.textContent = info.value;
  } else if (config.type === "image") {
    value.style.display = "none";
    image.style.display = "block";
    image.src = config.image_url || info.state?.attributes?.entity_picture || "";
    image.alt = friendly;
  } else if (config.type === "chart") {
    value.textContent = info.value;
    chart.style.display = "block";
    const hours = clamp(config.chart_hours || 24, 1, 168);
    const key = `${config.entity_id}|${config.attribute || ""}|${hours}`;
    const values = panel._ha3dFloatingHistory?.get(key)?.values || [];
    chart.querySelector("polyline")?.setAttribute("points", chartPoints(values));
    sub.textContent = `${config.entity_id || ""} · últimas ${hours} h`;
    ensureHistory(panel, runtime);
  }
}

function visibleFor(panel, runtime) {
  const c = runtime.config;
  if (panel._editorMode || c.enabled === false || !runtime.anchor) return false;
  if (c.visibility === "click") return panel._ha3dInspectorAnchorKey === c.anchor;
  if (c.visibility === "zoom") {
    const sceneScale = Math.max(0.001, finite(panel._modelScale, 10));
    const distance = panel._camera?.position?.distanceTo?.(centerFor(runtime.anchor)) ?? Infinity;
    return distance <= sceneScale * clamp(c.zoom_threshold || 1.15, 0.15, 3);
  }
  return true;
}

function updateRuntimePosition(panel, runtime) {
  if (!runtime.anchor) runtime.anchor = findAnchor(panel, runtime.config.anchor);
  if (!runtime.anchor) return;
  const isSelected = selectedWidget(panel)?.config?.id === runtime.config.id;
  const dragging = Boolean(panel._transformControls?.dragging);
  if (!(panel._editorMode && isSelected && dragging)) {
    runtime.handle.position.copy(centerFor(runtime.anchor)).add(new THREE.Vector3(...(runtime.config.offset || [0, 0, 0])));
  }
}

function updateWidgets(panel, now = performance.now()) {
  if (!panel?._camera || !panel?._renderer) return;
  const rect = panel._renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  panel._ha3dFloatingWidgetFramePoint ||= new THREE.Vector3();
  const point = panel._ha3dFloatingWidgetFramePoint;
  for (const runtime of panel?._ha3dFloatingWidgets?.values?.() || []) {
    updateRuntimePosition(panel, runtime);
    const show = visibleFor(panel, runtime);
    if (!show) {
      runtime.card?.classList.remove("visible");
      continue;
    }
    runtime.handle.getWorldPosition(point);
    point.project(panel._camera);
    const inView = point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1.1 && Math.abs(point.y) <= 1.1;
    runtime.card?.classList.toggle("visible", inView);
    if (!inView || !runtime.card) continue;
    if (!runtime.lastContentAt || now - runtime.lastContentAt > 650) {
      runtime.lastContentAt = now;
      updateCard(panel, runtime);
    }
    const x = (point.x * 0.5 + 0.5) * rect.width;
    const y = (-point.y * 0.5 + 0.5) * rect.height;
    const left = x > rect.width * 0.68;
    runtime.card.classList.toggle("left", left);
    const scale = clamp(runtime.config.scale || 1, 0.2, 4);
    runtime.card.style.left = `${x}px`;
    runtime.card.style.top = `${y}px`;
    runtime.card.style.transform = left
      ? `translate(calc(-100% - 18px),-50%) scale(${scale})`
      : `translate(18px,-50%) scale(${scale})`;
  }
}

function rememberInspectorMesh(panel, mesh) {
  let state = inspectorMeshState.get(mesh);
  if (!state) {
    state = { material: mesh.material, renderOrder: mesh.renderOrder, edge: null, accent: null };
    inspectorMeshState.set(mesh, state);
  }
  return state;
}

function ensureInspectorMaterials(panel) {
  if (!panel._ha3dInspectorXrayMaterial) panel._ha3dInspectorXrayMaterial = new THREE.MeshBasicMaterial({ color: 0x0bbcff, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthTest: true, depthWrite: false, toneMapped: false });
  if (!panel._ha3dInspectorXrayEdgeMaterial) panel._ha3dInspectorXrayEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x4de7ff, transparent: true, opacity: 0.42, depthTest: false, depthWrite: false, toneMapped: false });
  if (!panel._ha3dInspectorAccentMaterial) panel._ha3dInspectorAccentMaterial = new THREE.LineBasicMaterial({ color: 0x9af4ff, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false, toneMapped: false });
}

function inspectorEdge(panel, mesh, key, material, name) {
  const state = rememberInspectorMesh(panel, mesh);
  if (!state[key] && mesh.geometry?.attributes?.position) {
    try {
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 28), material);
      edge.name = name;
      edge.userData.ha3dInspectorOverlay = true;
      edge.renderOrder = 30;
      mesh.add(edge);
      state[key] = edge;
    } catch (_error) {}
  }
  return state[key];
}

function restoreInspectorVisual(panel) {
  panel?._model?.traverse?.((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dInspectorOverlay) return;
    const state = inspectorMeshState.get(mesh);
    if (!state) return;
    if (mesh.material === panel._ha3dInspectorXrayMaterial) mesh.material = state.material;
    mesh.renderOrder = state.renderOrder;
    if (state.edge) state.edge.visible = false;
    if (state.accent) state.accent.visible = false;
  });
}

function applyInspectorVisual(panel, selected) {
  restoreInspectorVisual(panel);
  if (panel._editorMode || !selected || !panel._model) return;
  ensureInspectorMaterials(panel);
  const selectedNodes = new Set();
  selected.traverse?.((node) => selectedNodes.add(node));
  selectedNodes.add(selected);
  panel._model.traverse((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dInspectorOverlay || mesh.userData?.ha3dEditorHelper) return;
    const state = rememberInspectorMesh(panel, mesh);
    if (selectedNodes.has(mesh)) {
      mesh.material = state.material;
      mesh.renderOrder = Math.max(4, state.renderOrder || 0);
      const accent = inspectorEdge(panel, mesh, "accent", panel._ha3dInspectorAccentMaterial, "__HA3D_INSPECTOR_ACCENT__");
      if (accent) accent.visible = true;
      if (state.edge) state.edge.visible = false;
    } else {
      mesh.material = panel._ha3dInspectorXrayMaterial;
      mesh.renderOrder = 2;
      const edge = inspectorEdge(panel, mesh, "edge", panel._ha3dInspectorXrayEdgeMaterial, "__HA3D_INSPECTOR_XRAY__");
      if (edge) edge.visible = true;
      if (state.accent) state.accent.visible = false;
    }
  });
}

function ease(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function zoomToObject(panel, object) {
  if (!panel?._camera || !panel?._controls || panel._editorMode || panel._cinematicActive) return;
  const box = boundsFor(object);
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const objectScale = Math.max(size.x, size.y, size.z, finite(panel._modelScale, 10) * 0.015);
  const startPos = panel._camera.position.clone();
  const startTarget = panel._controls.target.clone();
  let direction = startPos.clone().sub(center);
  const currentDistance = Math.max(direction.length(), 0.01);
  if (direction.lengthSq() < 1e-8) direction.set(1, 0.5, 1);
  direction.normalize();
  const desiredDistance = Math.min(currentDistance * 0.68, Math.max(objectScale * 2.6, finite(panel._modelScale, 10) * 0.07));
  if (!(desiredDistance < currentDistance * 0.96)) return;
  const endPos = center.clone().add(direction.multiplyScalar(desiredDistance));
  const token = (panel._ha3dInspectorZoomToken || 0) + 1;
  panel._ha3dInspectorZoomToken = token;
  const oldEnabled = panel._controls.enabled;
  panel._controls.enabled = false;
  panel._cameraAnimating = true;
  const started = performance.now();
  const duration = 620;
  const frame = (now) => {
    if (panel._ha3dInspectorZoomToken !== token || panel._editorMode) {
      if (panel._ha3dInspectorZoomToken === token) {
        panel._controls.enabled = oldEnabled;
        panel._cameraAnimating = false;
      }
      return;
    }
    const t = ease((now - started) / duration);
    panel._camera.position.lerpVectors(startPos, endPos, t);
    panel._controls.target.lerpVectors(startTarget, center, t);
    panel._camera.lookAt(panel._controls.target);
    if (t < 1) requestAnimationFrame(frame);
    else {
      panel._controls.enabled = oldEnabled;
      panel._cameraAnimating = false;
      panel._controls.update();
    }
  };
  requestAnimationFrame(frame);
}

function clearInspector(panel) {
  panel._ha3dInspectorAnchorKey = null;
  panel._ha3dInspectorObject = null;
  panel._ha3dInspectorZoomToken = (panel._ha3dInspectorZoomToken || 0) + 1;
  restoreInspectorVisual(panel);
}

function focusObject(panel, object, key) {
  if (panel._editorMode) return;
  panel._ha3dInspectorAnchorKey = key;
  panel._ha3dInspectorObject = object;
  applyInspectorVisual(panel, object);
  zoomToObject(panel, object);
}

function hasWidgetsForAnchor(panel, key) {
  return widgets(panel).some((item) => item.enabled !== false && item.anchor === key);
}

function installFrame(panel) {
  if (panel._ha3dFloatingWidgetRaf) return;
  const loop = (now) => {
    if (!panel.isConnected) { panel._ha3dFloatingWidgetRaf = 0; return; }
    updateWidgets(panel, now);
    panel._ha3dFloatingWidgetRaf = requestAnimationFrame(loop);
  };
  panel._ha3dFloatingWidgetRaf = requestAnimationFrame(loop);
}

function stopFrame(panel) {
  if (panel._ha3dFloatingWidgetRaf) cancelAnimationFrame(panel._ha3dFloatingWidgetRaf);
  panel._ha3dFloatingWidgetRaf = 0;
}

if (!proto.__ha3dFloatingWidgetsV1) {
  proto.__ha3dFloatingWidgetsV1 = true;

  const oldRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = oldRenderShell?.apply(this, args);
    installToolbar(this);
    ensureUi(this);
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    queueMicrotask(() => { ensureUi(this); installToolbar(this); installFrame(this); });
    return result;
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    stopFrame(this);
    clearInspector(this);
    for (const runtime of this._ha3dFloatingWidgets?.values?.() || []) disposeRuntime(runtime);
    this._ha3dFloatingWidgets = new Map();
    return oldDisconnected?.apply(this, args);
  };

  const oldLoad = proto._loadModel;
  proto._loadModel = async function (...args) {
    clearInspector(this);
    const result = await oldLoad?.apply(this, args);
    rebuild(this);
    return result;
  };

  const oldToggle = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    if (!this._editorMode) clearInspector(this);
    const result = oldToggle?.apply(this, args);
    if (this._editorMode) clearInspector(this);
    setEditorHelperVisibility(this);
    refreshChooser(this);
    return result;
  };

  const oldPickObject = proto._pickObject;
  proto._pickObject = function (event) {
    if (this._editorMode && this._ha3dFloatingWidgetPickables?.length) {
      const rect = this._renderer.domElement.getBoundingClientRect();
      this._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this._raycaster.setFromCamera(this._pointer, this._camera);
      const hit = this._raycaster.intersectObjects(this._ha3dFloatingWidgetPickables, false)[0]?.object;
      if (hit?.userData?.ha3dFloatingWidgetHandle) return hit.userData.ha3dFloatingWidgetHandle;
    }
    return oldPickObject?.call(this, event) || null;
  };

  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._editorMode) return oldPick?.call(this, event);
    const object = this._pickObject?.(event);
    const key = objectKey(object);
    if (object && key && hasWidgetsForAnchor(this, key)) {
      focusObject(this, object, key);
      return;
    }
    clearInspector(this);
    return oldPick?.call(this, event);
  };

  const oldSelect = proto._selectForEditor;
  proto._selectForEditor = function (object, ...args) {
    const result = oldSelect?.call(this, object, ...args);
    const runtime = selectedWidget(this);
    const rotate = this.shadowRoot?.querySelector('[data-transform="rotate"]');
    if (rotate) rotate.disabled = Boolean(runtime);
    if (runtime) {
      this._setStatus?.(`Widget: ${runtime.config.name || runtime.config.id}`);
      refreshChooser(this);
    }
    return result;
  };

  const oldRenderForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const runtime = selectedWidget(this);
    if (runtime) {
      renderForm(this, runtime);
      return;
    }
    return oldRenderForm?.apply(this, args);
  };

  const oldPersist = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    const runtime = selectedWidget(this);
    if (!runtime) return oldPersist?.apply(this, args);
    const anchor = runtime.anchor || findAnchor(this, runtime.config.anchor);
    const offset = runtime.handle.position.clone().sub(centerFor(anchor)).toArray();
    const uniform = clamp((runtime.handle.scale.x + runtime.handle.scale.y + runtime.handle.scale.z) / 3, 0.2, 4);
    runtime.handle.scale.setScalar(uniform);
    const list = widgets(this).map((item) => item.id === runtime.config.id ? { ...item, offset, scale: uniform } : item);
    try {
      await saveWidgets(this, list, `Widget salvo: ${runtime.config.name || runtime.config.id}`);
      runtime.config = widgets(this).find((item) => item.id === runtime.config.id) || { ...runtime.config, offset, scale: uniform };
    } catch (error) {
      this._setStatus?.(`Erro ao salvar widget: ${error.message || error}`);
    }
  };

  proto._createFloatingWidget = async function (type = "text") {
    if (!TYPES.has(type)) return;
    const selected = this._selectedObject;
    if (!selected || selected.userData?.ha3dFloatingWidgetId || selected.userData?.ha3dVirtualLightId) {
      this._setStatus?.("Selecione primeiro o objeto que será a âncora do widget");
      return;
    }
    const anchor = objectKey(selected);
    if (!anchor) {
      this._setStatus?.("O objeto selecionado não possui um identificador utilizável");
      return;
    }
    const box = boundsFor(selected);
    const size = box?.getSize(new THREE.Vector3()) || new THREE.Vector3();
    const id = nextId(this, type);
    const item = {
      id,
      name: type === "chart" ? "Gráfico" : type === "image" ? "Imagem" : type === "state" ? "Estado" : "Texto",
      type,
      anchor,
      entity_id: "",
      attribute: "",
      text: type === "text" ? "Texto" : "",
      image_url: "",
      offset: [0, Math.max(size.y * 0.58, finite(this._modelScale, 10) * 0.018), 0],
      scale: 1,
      visibility: "click",
      zoom_threshold: 1.15,
      chart_hours: 24,
      enabled: true,
    };
    try {
      await saveWidgets(this, [...widgets(this), item], "Widget criado");
      rebuild(this);
      this._selectFloatingWidget?.(id);
    } catch (error) {
      this._setStatus?.(`Erro ao criar widget: ${error.message || error}`);
    }
  };

  proto._selectFloatingWidget = function (id) {
    const runtime = runtimeFor(this, id);
    if (!runtime) return;
    this._selectForEditor?.(runtime.handle);
    this._renderEditorForm?.();
  };

  proto._saveFloatingWidgetForm = async function (id) {
    const runtime = runtimeFor(this, id);
    const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
    if (!runtime || !body) return;
    const anchor = runtime.anchor || findAnchor(this, runtime.config.anchor);
    const px = finite(body.querySelector("#ha3dFwPx")?.value, runtime.handle.position.x);
    const py = finite(body.querySelector("#ha3dFwPy")?.value, runtime.handle.position.y);
    const pz = finite(body.querySelector("#ha3dFwPz")?.value, runtime.handle.position.z);
    runtime.handle.position.set(px, py, pz);
    const scale = clamp(body.querySelector("#ha3dFwScale")?.value, 0.2, 4);
    runtime.handle.scale.setScalar(scale);
    const offset = runtime.handle.position.clone().sub(centerFor(anchor)).toArray();
    const updated = {
      ...runtime.config,
      name: body.querySelector("#ha3dFwName")?.value.trim() || runtime.config.id,
      type: TYPES.has(body.querySelector("#ha3dFwType")?.value) ? body.querySelector("#ha3dFwType").value : runtime.config.type,
      entity_id: body.querySelector("#ha3dFwEntity")?.value.trim() || "",
      attribute: body.querySelector("#ha3dFwAttribute")?.value.trim() || "",
      text: body.querySelector("#ha3dFwText")?.value || "",
      image_url: body.querySelector("#ha3dFwImage")?.value.trim() || "",
      offset,
      scale,
      visibility: body.querySelector("#ha3dFwVisibility")?.value || "always",
      zoom_threshold: clamp(body.querySelector("#ha3dFwZoom")?.value, 0.15, 3),
      chart_hours: clamp(body.querySelector("#ha3dFwChartHours")?.value, 1, 168),
      enabled: Boolean(body.querySelector("#ha3dFwEnabled")?.checked),
    };
    try {
      await saveWidgets(this, widgets(this).map((item) => item.id === id ? updated : item), "Widget salvo");
      runtime.config = widgets(this).find((item) => item.id === id) || updated;
      runtime.anchor = findAnchor(this, runtime.config.anchor);
      updateCard(this, runtime);
      refreshChooser(this);
    } catch (error) {
      this._setStatus?.(`Erro ao salvar widget: ${error.message || error}`);
    }
  };

  proto._removeFloatingWidget = async function (id) {
    try {
      await saveWidgets(this, widgets(this).filter((item) => item.id !== id), "Widget removido");
      const runtime = runtimeFor(this, id);
      if (runtime) disposeRuntime(runtime);
      this._ha3dFloatingWidgets?.delete?.(id);
      this._selectedObject = null;
      this._transformControls?.detach?.();
      const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
      if (body) body.innerHTML = '<p class="ha3dHint">Selecione um objeto 3D para editar.</p>';
      refreshChooser(this);
    } catch (error) {
      this._setStatus?.(`Erro ao remover widget: ${error.message || error}`);
    }
  };
}
