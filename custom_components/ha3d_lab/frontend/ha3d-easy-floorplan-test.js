/*
 * Experimental editor and interaction layer for HA3D.
 * Design concepts: Easy Floorplan (MIT, Copyright 2026 Nicolas Sandller).
 * This is an independent Three.js/GLB implementation; see ../NOTICE.
 */
import * as THREE from "https://esm.sh/three@0.180.0";
import { TransformControls } from "https://esm.sh/three@0.180.0/examples/jsm/controls/TransformControls.js";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;
const INTERACTIVE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean"]);

function entityDomain(entityId) { return String(entityId || "").split(".", 1)[0]; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function isOffline(state) { return ["unavailable", "unknown"].includes(state?.state); }
function stateRule(config, state) {
  const value = state?.state;
  const numeric = Number(value);
  return (config?.state_rules || []).find((rule) =>
    (rule.state !== undefined && String(rule.state) === value)
    || (Number.isFinite(numeric) && Number.isFinite(Number(rule.above)) && numeric > Number(rule.above))
    || (Number.isFinite(numeric) && Number.isFinite(Number(rule.below)) && numeric < Number(rule.below)),
  ) || (config?.state_rules || []).find((rule) => rule.default);
}
function actionFor(config, gesture, entityId) {
  const action = config?.actions?.[gesture];
  if (action?.action) return action;
  if (gesture !== "tap") return { action: "none" };
  return INTERACTIVE_DOMAINS.has(entityDomain(entityId)) ? { action: "toggle" } : { action: "more-info" };
}

if (!proto.__ha3dEasyFloorplanTestV1) {
  proto.__ha3dEasyFloorplanTestV1 = true;

  const oldRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    oldRenderShell.apply(this, args);
    const style = document.createElement("style");
    style.textContent = `
      #editorButton.active{background:#176b44} #ha3dEditor{display:none;position:absolute;z-index:40;top:68px;left:12px;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 86px);overflow:auto;padding:14px;border-radius:16px}
      #ha3dEditor.open{display:block}#ha3dEditor.minimized{width:auto;max-height:none;padding:8px 10px}#ha3dEditor.minimized p,#ha3dEditor.minimized #ha3dEditorBody{display:none}#ha3dEditor h3{margin:0 0 8px;font-size:15px}#ha3dEditor.minimized h3{margin:0}#ha3dEditor p{margin:5px 0 12px;font-size:12px;opacity:.72;line-height:1.4}.ha3dRow{display:grid;gap:5px;margin:10px 0}.ha3dRow label{font-size:12px;opacity:.8}.ha3dRow input,.ha3dRow select,.ha3dRow textarea{width:100%;padding:8px;border-radius:8px;border:1px solid #ffffff2b;background:#111;color:inherit;font:inherit}.ha3dRow textarea{min-height:58px;resize:vertical}.ha3dEditorActions{display:flex;gap:7px;flex-wrap:wrap}.ha3dHint{font-size:11px;opacity:.65}.ha3dSelected{outline:2px solid #4fc3f7;outline-offset:2px}.ha3dEditorHead{display:flex;align-items:center;gap:8px}.ha3dEditorHead button{margin-left:auto;padding:5px 8px;font-size:11px}.ha3dTransform{display:flex;gap:6px;margin:8px 0}.ha3dTransform button.active{background:#176b44}
      .lightMarker.ha3dOffline{background:#303139;color:#b4b7c2;border-color:#737783;filter:grayscale(1)}.lightMarker.ha3dPressed{animation:ha3dPress .26s ease-out}@keyframes ha3dPress{50%{transform:translate(-50%,-50%) scale(.84);box-shadow:0 0 0 9px #56b7ff55}}
    `;
    this.shadowRoot.append(style);
    const actions = this.shadowRoot.querySelector("#actions");
    const editorButton = document.createElement("button");
    editorButton.id = "editorButton"; editorButton.className = "secondary"; editorButton.type = "button"; editorButton.textContent = "Editor";
    editorButton.addEventListener("click", () => this._toggleEditor());
    actions.prepend(editorButton);
    const editor = document.createElement("section");
    editor.id = "ha3dEditor"; editor.className = "glass";
    editor.innerHTML = `<div class="ha3dEditorHead"><h3>Editor Mode</h3><button id="ha3dCollapseEditor" class="secondary" type="button">Recolher</button></div><p>Selecione um objeto e use a tríade para mover, rotacionar ou escalar. O GLB original não é regravado.</p><div class="ha3dTransform"><button data-transform="translate" class="active" type="button">Mover</button><button data-transform="rotate" type="button">Rotacionar</button><button data-transform="scale" type="button">Escalar</button></div><div id="ha3dEditorBody"><p class="ha3dHint">Selecione um objeto 3D para editar.</p></div>`;
    editor.querySelector("#ha3dCollapseEditor").addEventListener("click", () => { editor.classList.toggle("minimized"); editor.querySelector("#ha3dCollapseEditor").textContent = editor.classList.contains("minimized") ? "Abrir" : "Recolher"; });
    editor.querySelectorAll("[data-transform]").forEach((button) => button.addEventListener("click", () => { this._transformControls?.setMode(button.dataset.transform); editor.querySelectorAll("[data-transform]").forEach((item) => item.classList.toggle("active", item === button)); }));
    this.shadowRoot.querySelector("#root").append(editor);
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const out = await oldLoadModel.apply(this, args);
    this._applySavedObjectPositions();
    this._bindAdvancedMarkers();
    return out;
  };

  const oldInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    const result = oldInitViewer.apply(this, args);
    this._transformControls = new TransformControls(this._camera, this._renderer.domElement);
    this._transformControls.enabled = false;
    this._transformControls.visible = false;
    this._scene.add(this._transformControls);
    this._transformControls.addEventListener("dragging-changed", (event) => { this._controls.enabled = !event.value; });
    this._transformControls.addEventListener("mouseUp", () => this._persistSelectedTransform());
    return result;
  };

  proto._applySavedObjectPositions = function () {
    const saved = this._config?.object_positions || {};
    this._model?.traverse((object) => {
      const value = saved[object.userData?.ha3dOriginalNodeName || object.name];
      if (!value) return;
      if (value.position) object.position.fromArray(value.position);
      if (value.rotation) object.rotation.fromArray(value.rotation);
      if (value.scale) object.scale.fromArray(value.scale);
    });
  };

  proto._toggleEditor = function () {
    if (!this._hass?.user?.is_admin) { this._setStatus("Editor disponível apenas para administradores"); return; }
    this._editorMode = !this._editorMode;
    this.shadowRoot.querySelector("#ha3dEditor")?.classList.toggle("open", this._editorMode);
    this.shadowRoot.querySelector("#editorButton")?.classList.toggle("active", this._editorMode);
    this._setStatus(this._editorMode ? "Editor ativo: selecione e arraste um objeto" : "Editor desativado");
  };

  proto._selectForEditor = function (object) {
    if (!object) return;
    this._selectedObject?.traverse?.((node) => node.userData && (node.userData.ha3dEditorSelected = false));
    this._selectedObject = object;
    object.userData.ha3dEditorSelected = true;
    this._transformControls?.attach(object);
    this._transformControls.enabled = true;
    this._transformControls.visible = true;
    const editor = this.shadowRoot.querySelector("#ha3dEditor");
    if (editor?.classList.contains("open")) { editor.classList.add("minimized"); editor.querySelector("#ha3dCollapseEditor").textContent = "Abrir"; }
    this._renderEditorForm();
  };

  proto._persistSelectedTransform = async function () {
    const object = this._selectedObject;
    if (!object) return;
    const name = object.userData?.ha3dOriginalNodeName || object.name;
    const positions = { ...(this._config?.object_positions || {}), [name]: { position: object.position.toArray(), rotation: object.rotation.toArray(), scale: object.scale.toArray() } };
    try { await this._saveConfigPatch({ object_positions: positions }); this._setStatus("Transformação salva"); } catch (error) { this._setStatus(`Erro ao salvar: ${error.message || error}`); }
  };

  proto._renderEditorForm = async function () {
    const body = this.shadowRoot.querySelector("#ha3dEditorBody");
    const object = this._selectedObject;
    if (!body || !object) return;
    const name = object.userData?.ha3dOriginalNodeName || object.name || "(sem nome)";
    const advanced = this._config?.advanced_bindings?.[name] || {};
    const area = this._config?.area_bindings?.[name] || "";
    if (!this._areaData) {
      try { this._areaData = (await this._hass.callApi("GET", "ha3d_lab/areas")).areas || []; } catch (_error) { this._areaData = []; }
    }
    const options = [`<option value="">Nenhuma</option>`, ...this._areaData.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === area ? "selected" : ""}>${escapeHtml(item.name)}</option>`)].join("");
    const selectedEntity = advanced.entity_id || object.userData?.ha3dEntityId || "";
    body.innerHTML = `<div class="ha3dRow"><label>Objeto GLB</label><input disabled value="${escapeHtml(name)}"></div>
      <div class="ha3dRow"><label>Entidade principal</label><input id="ha3dEntity" list="ha3dEntityOptions" autocomplete="off" placeholder="Pesquise por nome ou entity_id…" value="${escapeHtml(selectedEntity)}"><datalist id="ha3dEntityOptions"></datalist><span class="ha3dHint">Digite “DeskJet”, “tinta” ou qualquer parte do nome.</span></div>
      <div class="ha3dRow"><label>Área do Home Assistant</label><select id="ha3dArea">${options}</select></div>
      <div class="ha3dRow"><label>Leituras extras (uma por linha: entity_id ou entity_id:atributo)</label><textarea id="ha3dReadings" placeholder="sensor.temperatura_sala\nsensor.umidade_sala">${(advanced.readings || []).map((item) => typeof item === "string" ? item : `${item.entity_id || ""}${item.attribute ? `:${item.attribute}` : ""}`).join("\n")}</textarea></div>
      <div class="ha3dRow"><label>Regras visuais JSON (ex.: [{"state":"on","color":"#ffd54f","icon":"💡"}])</label><textarea id="ha3dRules">${JSON.stringify(advanced.state_rules || [])}</textarea></div>
      <div class="ha3dRow"><label><input id="ha3dZoomOnly" type="checkbox" ${advanced.show_only_when_zoomed ? "checked" : ""}> Exibir somente quando próximo</label></div>
      <div class="ha3dEditorActions"><button id="ha3dSaveObject" type="button">Salvar binding</button><button id="ha3dAddArea" class="secondary" type="button">Adicionar entidades da área</button><button id="ha3dRemoveBinding" class="secondary" type="button">Remover binding</button><button id="ha3dRemoveArea" class="secondary" type="button">Remover entidades da área</button></div>`;
    this._updateEntityChoices(area);
    body.querySelector("#ha3dArea").addEventListener("change", (event) => this._updateEntityChoices(event.target.value));
    body.querySelector("#ha3dSaveObject").addEventListener("click", () => this._saveEditorBinding(name));
    body.querySelector("#ha3dAddArea").addEventListener("click", () => this._addAreaEntities(name));
    body.querySelector("#ha3dRemoveBinding").addEventListener("click", () => this._removeEditorBinding(name));
    body.querySelector("#ha3dRemoveArea").addEventListener("click", () => this._removeAreaEntities(name));
  };

  proto._saveConfigPatch = async function (patch) {
    // HA's current callApi contract sends POST JSON in its third argument.
    // Passing it as a fourth argument silently drops the body, leaving the
    // server unable to validate or persist editor/robot settings.
    this._config = await this._hass.callApi("POST", "ha3d_lab/config", patch);
  };

  proto._updateEntityChoices = function (areaId = "") {
    const list = this.shadowRoot.querySelector("#ha3dEntityOptions");
    if (!list) return;
    const scoped = areaId ? this._areaData?.find((area) => area.id === areaId)?.entities : null;
    const allowed = scoped ? new Set(scoped) : null;
    const entities = Object.entries(this._hass?.states || {})
      .filter(([entityId]) => !allowed || allowed.has(entityId))
      .sort(([left], [right]) => left.localeCompare(right));
    list.replaceChildren(...entities.map(([entityId, state]) => {
      const option = document.createElement("option");
      option.value = entityId;
      option.label = `${state.attributes?.friendly_name || entityId} — ${entityId}`;
      return option;
    }));
  };
  proto._saveEditorBinding = async function (name) {
    const body = this.shadowRoot.querySelector("#ha3dEditorBody");
    let rules;
    try { rules = JSON.parse(body.querySelector("#ha3dRules").value || "[]"); if (!Array.isArray(rules)) throw Error(); } catch (_error) { this._setStatus("Regras precisam ser uma lista JSON válida"); return; }
    const entityId = body.querySelector("#ha3dEntity").value.trim();
    const readings = body.querySelector("#ha3dReadings").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [entity_id, attribute] = line.split(":", 2); return attribute ? { entity_id, attribute } : { entity_id }; });
    const advanced = { ...(this._config?.advanced_bindings || {}), [name]: { ...(this._config?.advanced_bindings?.[name] || {}), entity_id: entityId || undefined, readings, state_rules: rules, show_only_when_zoomed: body.querySelector("#ha3dZoomOnly").checked } };
    const areas = { ...(this._config?.area_bindings || {}) }; const area = body.querySelector("#ha3dArea").value; if (area) areas[name] = area; else delete areas[name];
    try { await this._saveConfigPatch({ advanced_bindings: advanced, area_bindings: areas }); this._indexBindings(); this._clearMarkers(); this._bindModelLights(); this._bindEntityLightMarkers(); this._bindAdvancedMarkers(); this._syncLightStates(); this._setStatus("Binding salvo"); } catch (error) { this._setStatus(`Erro ao salvar: ${error.message || error}`); }
  };
  proto._addAreaEntities = async function (name) {
    const areaId = this.shadowRoot.querySelector("#ha3dArea").value;
    const area = this._areaData?.find((item) => item.id === areaId);
    if (!area) { this._setStatus("Escolha uma área primeiro"); return; }
    const advanced = { ...(this._config?.advanced_bindings || {}) };
    for (const entity_id of area.entities) advanced[`__area__${area.id}__${entity_id}`] = { entity_id, anchor: name };
    try { await this._saveConfigPatch({ advanced_bindings: advanced }); this._bindAdvancedMarkers(); this._setStatus(`${area.entities.length} entidades da área adicionadas`); } catch (error) { this._setStatus(`Erro ao salvar: ${error.message || error}`); }
  };

  proto._bindAdvancedMarkers = function () {
    const configs = this._config?.advanced_bindings || {};
    for (const [key, config] of Object.entries(configs)) {
      const entity = config.entity_id;
      if (!entity || this._lightBindings.has(entity)) continue;
      let anchor;
      const anchorName = config.anchor || key;
      this._model?.traverse((object) => { if (!anchor && (object.name === anchorName || object.userData?.ha3dOriginalNodeName === anchorName)) anchor = object; });
      if (!anchor) continue;
      const binding = this._makeLightMarker(entity, this._hass?.states?.[entity]?.attributes?.friendly_name || entity, anchor, null);
      // GLB node origins are often at a parent pivot, not inside the mesh. Use
      // its visual bounds for editor-created markers so they land on the item.
      binding.ha3dAnchorBounds = true;
      binding.ha3dMarkerOffset = new THREE.Vector3(...(config.marker_offset || [0, 0, 0]));
      this._wireMarkerEditorDrag(binding, key);
    }
  };

  proto._wireMarkerEditorDrag = function (binding, configKey) {
    if (binding.marker.dataset.ha3dEditorDrag) return;
    binding.marker.dataset.ha3dEditorDrag = "true";
    binding.marker.addEventListener("pointerdown", (event) => {
      if (!this._editorMode) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const box = new THREE.Box3().setFromObject(binding.anchor);
      const center = box.getCenter(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._camera.getWorldDirection(new THREE.Vector3()), center);
      const point = new THREE.Vector3();
      const move = (moveEvent) => {
        const rect = this._renderer.domElement.getBoundingClientRect();
        this._pointer.set(((moveEvent.clientX - rect.left) / rect.width) * 2 - 1, -((moveEvent.clientY - rect.top) / rect.height) * 2 + 1);
        this._raycaster.setFromCamera(this._pointer, this._camera);
        if (this._raycaster.ray.intersectPlane(plane, point)) binding.ha3dMarkerOffset.copy(point).sub(center);
      };
      const up = async () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        const advanced = { ...(this._config?.advanced_bindings || {}) };
        advanced[configKey] = { ...advanced[configKey], marker_offset: binding.ha3dMarkerOffset.toArray() };
        try { await this._saveConfigPatch({ advanced_bindings: advanced }); this._setStatus("Posição do marcador salva"); } catch (error) { this._setStatus(`Erro ao salvar marcador: ${error.message || error}`); }
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
    }, true);
  };

  const oldSync = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    oldSync.apply(this, args);
    for (const [entity, binding] of this._lightBindings || []) {
      const config = Object.values(this._config?.advanced_bindings || {}).find((item) => item.entity_id === entity);
      const state = this._hass?.states?.[entity]; const rule = stateRule(config, state); const marker = binding.marker;
      if (!marker) continue;
      marker.classList.toggle("ha3dOffline", isOffline(state));
      if (rule?.color) marker.style.background = rule.color; else marker.style.removeProperty("background");
      if (rule?.icon) marker.textContent = rule.icon;
      const readings = (config?.readings || []).map((item) => { const reading = this._hass?.states?.[item.entity_id]; return reading ? (item.attribute ? reading.attributes?.[item.attribute] : reading.state) : "—"; }).filter((value) => value !== undefined);
      marker.title = `${binding.name}${readings.length ? ` · ${readings.join(" · ")}` : ""}${isOffline(state) ? " — indisponível" : ""}`;
    }
  };

  const oldUpdateMarkers = proto._updateLightMarkers;
  proto._updateLightMarkers = function (...args) {
    oldUpdateMarkers.apply(this, args);
    for (const [entity, binding] of this._lightBindings || []) {
      const config = Object.values(this._config?.advanced_bindings || {}).find((item) => item.entity_id === entity);
      if (config?.show_only_when_zoomed) {
        const distance = this._camera.position.distanceTo(this._controls.target);
        binding.marker.style.display = distance < (this._modelScale || 10) * 1.15 ? "block" : "none";
      }
      if (binding.ha3dAnchorBounds) {
        const box = new THREE.Box3().setFromObject(binding.anchor);
        if (box.isEmpty()) continue;
        const point = box.getCenter(new THREE.Vector3()).add(binding.ha3dMarkerOffset || new THREE.Vector3()).project(this._camera);
        const stage = this.shadowRoot.querySelector("#stage");
        const visible = point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1.15 && Math.abs(point.y) <= 1.15;
        binding.marker.style.visibility = visible ? "visible" : "hidden";
        if (visible) {
          binding.marker.style.left = `${(point.x * 0.5 + 0.5) * stage.clientWidth}px`;
          binding.marker.style.top = `${(-point.y * 0.5 + 0.5) * stage.clientHeight}px`;
        }
      }
    }
  };
  proto._refreshMarkers = function () {
    this._indexBindings(); this._clearMarkers(); this._bindModelLights();
    this._bindEntityLightMarkers(); this._bindAdvancedMarkers(); this._syncLightStates();
  };
  proto._removeEditorBinding = async function (name) {
    const advanced = { ...(this._config?.advanced_bindings || {}) };
    const areas = { ...(this._config?.area_bindings || {}) };
    delete advanced[name]; delete areas[name];
    try { await this._saveConfigPatch({ advanced_bindings: advanced, area_bindings: areas }); this._refreshMarkers(); this._renderEditorForm(); this._setStatus("Binding removido"); } catch (error) { this._setStatus(`Erro ao remover: ${error.message || error}`); }
  };
  proto._removeAreaEntities = async function (name) {
    const advanced = { ...(this._config?.advanced_bindings || {}) };
    for (const [key, value] of Object.entries(advanced)) if (key.startsWith("__area__") && value.anchor === name) delete advanced[key];
    try { await this._saveConfigPatch({ advanced_bindings: advanced }); this._refreshMarkers(); this._setStatus("Entidades adicionadas pela área removidas"); } catch (error) { this._setStatus(`Erro ao remover: ${error.message || error}`); }
  };

  const oldFit = proto._fit;
  proto._fit = function (...args) { oldFit.apply(this, args); const box = new THREE.Box3().setFromObject(this._model); this._modelScale = Math.max(...box.getSize(new THREE.Vector3()).toArray()) || 10; };

  const oldWireUi = proto._wireUi;
  proto._wireUi = function (...args) {
    oldWireUi.apply(this, args);
    this._renderer.domElement.addEventListener("pointerdown", (event) => {
      // A robot-calibration marker owns the transform gizmo until it is saved
      // or cancelled. Do not pick the GLB object behind it on a canvas click.
      if (this._robotCalibrationMarker) return;
      if (this._editorMode) {
        const object = this._pickObject(event);
        this._selectForEditor(object);
        return;
      }
      const object = this._pickObject(event); let node = object;
      while (node && !node.userData?.ha3dEntityId) node = node.parent;
      const entity = node?.userData?.ha3dEntityId;
      if (!entity) return;
      const name = node.userData?.ha3dOriginalNodeName || node.name;
      const config = this._config?.advanced_bindings?.[name];
      let held = false;
      const holdTimer = setTimeout(() => { held = true; this._suppressTapUntil = performance.now() + 700; this._runEntityAction(entity, actionFor(config, "hold", entity), node); }, 650);
      const release = () => {
        clearTimeout(holdTimer); window.removeEventListener("pointerup", release);
        if (held) return;
        const now = performance.now();
        if (now - (this._lastTapAt || 0) < 280 && this._lastTapEntity === entity) {
          this._suppressTapUntil = now + 500;
          this._lastTapAt = 0;
          this._runEntityAction(entity, actionFor(config, "double_tap", entity), node);
        } else { this._lastTapAt = now; this._lastTapEntity = entity; }
      };
      window.addEventListener("pointerup", release, { once: true });
    });
  };

  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._robotCalibrationMarker) return;
    if (!this._editorMode) return this._handleGesturePick(event, "tap", oldPick);
    this._selectForEditor(this._pickObject(event));
  };
  proto._pickObject = function (event) { if (!this._model) return null; const r = this._renderer.domElement.getBoundingClientRect(); this._pointer.set(((event.clientX-r.left)/r.width)*2-1,-((event.clientY-r.top)/r.height)*2+1); this._raycaster.setFromCamera(this._pointer,this._camera); return this._raycaster.intersectObject(this._model,true)[0]?.object || null; };
  proto._beginObjectDrag = function (event, object) {
    if (!object || !this._editorMode) return;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._camera.getWorldDirection(new THREE.Vector3()), object.getWorldPosition(new THREE.Vector3()));
    const point = new THREE.Vector3(); this._raycaster.ray.intersectPlane(plane, point); const offset = object.getWorldPosition(new THREE.Vector3()).sub(point);
    const move = (moveEvent) => { const r=this._renderer.domElement.getBoundingClientRect(); this._pointer.set(((moveEvent.clientX-r.left)/r.width)*2-1,-((moveEvent.clientY-r.top)/r.height)*2+1); this._raycaster.setFromCamera(this._pointer,this._camera); if(this._raycaster.ray.intersectPlane(plane,point)) { object.position.copy(object.parent.worldToLocal(point.clone().add(offset))); } };
    const up = async () => { window.removeEventListener("pointermove",move); window.removeEventListener("pointerup",up); const name=object.userData?.ha3dOriginalNodeName||object.name; const positions={...(this._config?.object_positions||{}),[name]:{position:object.position.toArray(),rotation:object.rotation.toArray(),scale:object.scale.toArray()}}; try{await this._saveConfigPatch({object_positions:positions});this._setStatus("Posição salva");}catch(error){this._setStatus(`Erro ao salvar posição: ${error.message||error}`);} };
    window.addEventListener("pointermove",move); window.addEventListener("pointerup",up,{once:true});
  };
  proto._handleGesturePick = async function (event, gesture, fallback) {
    if (performance.now() < (this._suppressTapUntil || 0)) return;
    const object = this._pickObject(event); let node = object; while (node && !node.userData?.ha3dEntityId) node = node.parent;
    const entity = node?.userData?.ha3dEntityId; if (!entity) return fallback.call(this,event);
    const config = this._config?.advanced_bindings?.[node.userData?.ha3dOriginalNodeName || node.name]; await this._runEntityAction(entity, actionFor(config,gesture,entity), node);
  };
  proto._runEntityAction = async function (entity, action, node) {
    const marker = this._lightBindings?.get(entity)?.marker; marker?.classList.add("ha3dPressed"); setTimeout(()=>marker?.classList.remove("ha3dPressed"),300);
    if (!action || action.action === "none") return;
    if (action.action === "more-info") return this._openNativeMoreInfo(action.entity || entity);
    if (action.action === "toggle") return this._hass.callService("homeassistant","toggle",{entity_id:action.entity||entity});
    if (["call-service","perform-action"].includes(action.action)) { const [domain, service] = String(action.service || action.perform_action || "").split(".",2); if(domain&&service) return this._hass.callService(domain,service,action.data||action.service_data||{},action.target); }
  };
}
