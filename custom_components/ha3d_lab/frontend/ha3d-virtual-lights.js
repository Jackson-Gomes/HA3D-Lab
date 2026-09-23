import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const DEFAULT_COLOR = "#ffffff";
const MAX_VIRTUAL_LIGHTS = 200;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function virtualLightConfig(panel) {
  return Array.isArray(panel?._config?.virtual_lights) ? panel._config.virtual_lights : [];
}

function selectedVirtualRuntime(panel) {
  const id = panel?._selectedObject?.userData?.ha3dVirtualLightId;
  return id ? panel?._ha3dVirtualLights?.get(id) || null : null;
}

function nextLightId(panel, type) {
  const used = new Set(virtualLightConfig(panel).map((item) => item.id));
  const prefix = type === "spot" ? "spot" : "point";
  let index = 1;
  while (used.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function selectedCenter(panel) {
  const selected = panel?._selectedObject;
  if (selected && !selected.userData?.ha3dVirtualLightId) {
    const box = new THREE.Box3().setFromObject(selected);
    if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
  }
  return panel?._controls?.target?.clone?.() || new THREE.Vector3();
}

function helperSize(panel) {
  return Math.max(0.06, finite(panel?._modelScale, 10) * 0.012);
}

function disposeObject(root) {
  root?.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach((material) => material?.dispose?.());
    else node.material?.dispose?.();
  });
  root?.removeFromParent?.();
}

function kelvinToColor(kelvin, target) {
  const temperature = clamp(kelvin, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temperature - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temperature - 60, -0.0755148492);
    blue = 255;
  }
  target.setRGB(clamp(red, 0, 255) / 255, clamp(green, 0, 255) / 255, clamp(blue, 0, 255) / 255, THREE.SRGBColorSpace);
}

function applyVirtualLightState(panel, runtime) {
  const config = runtime?.config;
  const light = runtime?.light;
  if (!config || !light) return;

  const state = config.entity_id ? panel?._hass?.states?.[config.entity_id] : null;
  const unavailable = state && ["unknown", "unavailable"].includes(state.state);
  const entityEnabled = config.entity_id ? state?.state === "on" : config.enabled !== false;
  const attrs = state?.attributes || {};
  const brightness = Number.isFinite(Number(attrs.brightness)) ? clamp(Number(attrs.brightness) / 255, 0, 1) : 1;
  light.intensity = entityEnabled && !unavailable ? Math.max(0, finite(config.intensity, 10)) * brightness : 0;
  light.distance = Math.max(0, finite(config.distance, 6));
  light.decay = Math.max(0, finite(config.decay, 2));
  light.castShadow = Boolean(config.cast_shadow && light.intensity > 0);

  const rgb = attrs.rgb_color;
  if (Array.isArray(rgb) && rgb.length >= 3) {
    light.color.setRGB(clamp(rgb[0], 0, 255) / 255, clamp(rgb[1], 0, 255) / 255, clamp(rgb[2], 0, 255) / 255, THREE.SRGBColorSpace);
  } else if (Number.isFinite(Number(attrs.color_temp_kelvin))) {
    kelvinToColor(Number(attrs.color_temp_kelvin), light.color);
  } else {
    try { light.color.set(config.color || DEFAULT_COLOR); } catch (_error) { light.color.set(DEFAULT_COLOR); }
  }

  if (runtime.target) runtime.target.position.set(0, 0, -Math.max(light.distance || 0, 1));
  if (light.isSpotLight) {
    light.angle = clamp(finite(config.angle, Math.PI / 4), 0.01, Math.PI / 2);
    light.penumbra = clamp(finite(config.penumbra, 0.35), 0, 1);
  }
  if (light.shadow) {
    light.shadow.mapSize.set(512, 512);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.05;
  }
}

function createHelper(panel, handle, type) {
  const size = helperSize(panel);
  const material = new THREE.MeshBasicMaterial({
    color: type === "spot" ? 0xff9800 : 0xffd54f,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 10), material);
  sphere.renderOrder = 1000;
  sphere.userData.ha3dVirtualLightHandle = handle;
  handle.add(sphere);
  const helpers = [sphere];

  if (type === "spot") {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.72, size * 1.8, 14, 1, true),
      material.clone(),
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -size * 1.2;
    cone.renderOrder = 1000;
    cone.userData.ha3dVirtualLightHandle = handle;
    handle.add(cone);
    helpers.push(cone);
  }
  handle.userData.ha3dVirtualHelperMeshes = helpers;
  return helpers;
}

function createRuntime(panel, config) {
  const handle = new THREE.Group();
  handle.name = `HA3D_VirtualLight_${config.id}`;
  handle.userData.ha3dVirtualLightId = config.id;
  handle.userData.ha3dEditorHelper = true;
  handle.position.fromArray(config.position || [0, 0, 0]);
  const rotation = config.rotation || [0, 0, 0];
  handle.rotation.set(finite(rotation[0]), finite(rotation[1]), finite(rotation[2]));
  handle.scale.set(1, 1, 1);

  let light;
  let target = null;
  if (config.type === "spot") {
    light = new THREE.SpotLight(DEFAULT_COLOR, 0, finite(config.distance, 6), finite(config.angle, Math.PI / 4), finite(config.penumbra, 0.35), finite(config.decay, 2));
    target = new THREE.Object3D();
    target.name = `HA3D_VirtualLightTarget_${config.id}`;
    target.position.set(0, 0, -Math.max(finite(config.distance, 6), 1));
    handle.add(target);
    light.target = target;
  } else {
    light = new THREE.PointLight(DEFAULT_COLOR, 0, finite(config.distance, 6), finite(config.decay, 2));
  }
  light.name = `HA3D_VirtualLightSource_${config.id}`;
  light.userData.ha3dVirtualLightId = config.id;
  handle.add(light);

  const helperMeshes = createHelper(panel, handle, config.type);
  for (const mesh of helperMeshes) mesh.visible = Boolean(panel._editorMode);
  panel._scene.add(handle);

  const runtime = { config, handle, light, target, helperMeshes };
  applyVirtualLightState(panel, runtime);
  return runtime;
}

function rebuildVirtualLights(panel) {
  if (!panel?._scene) return;
  for (const runtime of panel._ha3dVirtualLights?.values?.() || []) disposeObject(runtime.handle);
  panel._ha3dVirtualLights = new Map();
  panel._ha3dVirtualLightPickables = [];

  for (const config of virtualLightConfig(panel).slice(0, MAX_VIRTUAL_LIGHTS)) {
    if (!config?.id || !["point", "spot"].includes(config.type)) continue;
    const runtime = createRuntime(panel, config);
    panel._ha3dVirtualLights.set(config.id, runtime);
    panel._ha3dVirtualLightPickables.push(...runtime.helperMeshes);
  }
  refreshVirtualLightChooser(panel);
}

function syncVirtualLightStates(panel) {
  for (const runtime of panel?._ha3dVirtualLights?.values?.() || []) applyVirtualLightState(panel, runtime);
}

function setHelperVisibility(panel) {
  const visible = Boolean(panel?._editorMode);
  for (const runtime of panel?._ha3dVirtualLights?.values?.() || []) {
    for (const mesh of runtime.helperMeshes || []) mesh.visible = visible;
  }
}

function refreshVirtualLightChooser(panel) {
  const select = panel?.shadowRoot?.querySelector("#ha3dVirtualLightSelect");
  if (!select) return;
  const current = panel?._selectedObject?.userData?.ha3dVirtualLightId || "";
  select.replaceChildren(new Option("Luzes virtuais…", ""));
  for (const config of virtualLightConfig(panel)) {
    select.appendChild(new Option(`${config.name || config.id} · ${config.type}`, config.id));
  }
  select.value = current;
}

function installVirtualLightToolbar(panel) {
  const transformRow = panel?.shadowRoot?.querySelector("#ha3dEditor .ha3dTransform");
  if (!transformRow || panel.shadowRoot.querySelector("#ha3dVirtualLightToolbar")) return;

  const row = document.createElement("div");
  row.id = "ha3dVirtualLightToolbar";
  row.style.cssText = "display:grid;grid-template-columns:1fr auto auto;gap:6px;margin:8px 0";
  row.innerHTML = `
    <select id="ha3dVirtualLightSelect" title="Selecionar luz virtual" style="min-width:0;padding:7px;border-radius:8px;background:#111;color:inherit;border:1px solid #ffffff2b"></select>
    <button id="ha3dAddPointLight" class="secondary" type="button">+ Point</button>
    <button id="ha3dAddSpotLight" class="secondary" type="button">+ Spot</button>
  `;
  transformRow.insertAdjacentElement("afterend", row);
  row.querySelector("#ha3dAddPointLight")?.addEventListener("click", () => panel._createVirtualLight?.("point"));
  row.querySelector("#ha3dAddSpotLight")?.addEventListener("click", () => panel._createVirtualLight?.("spot"));
  row.querySelector("#ha3dVirtualLightSelect")?.addEventListener("change", (event) => {
    if (event.target.value) panel._selectVirtualLight?.(event.target.value);
  });
  refreshVirtualLightChooser(panel);
}

function entityOptions(panel) {
  return Object.entries(panel?._hass?.states || {})
    .filter(([entityId]) => entityId.startsWith("light."))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, state]) => `<option value="${escapeHtml(entityId)}">${escapeHtml(state.attributes?.friendly_name || entityId)}</option>`)
    .join("");
}

function renderVirtualLightForm(panel, runtime) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!body || !runtime) return;
  const config = runtime.config;
  const position = runtime.handle.position;
  const rotation = runtime.handle.rotation;
  const angleDeg = finite(config.angle, Math.PI / 4) * 180 / Math.PI;
  body.innerHTML = `
    <div class="ha3dRow"><label>Luz virtual</label><input id="ha3dVlName" value="${escapeHtml(config.name || config.id)}"></div>
    <div class="ha3dRow"><label>Entidade Home Assistant</label><input id="ha3dVlEntity" list="ha3dVlEntities" autocomplete="off" placeholder="light.alguma_luz" value="${escapeHtml(config.entity_id || "")}"><datalist id="ha3dVlEntities">${entityOptions(panel)}</datalist><span class="ha3dHint">Sem entidade, a luz fica ligada manualmente conforme a opção Ativa.</span></div>
    <div class="ha3dRow"><label>Tipo</label><select id="ha3dVlType"><option value="point" ${config.type === "point" ? "selected" : ""}>Point Light</option><option value="spot" ${config.type === "spot" ? "selected" : ""}>Spot Light</option></select></div>
    <div class="ha3dRow"><label>Intensidade</label><input id="ha3dVlIntensity" type="number" min="0" step="0.5" value="${finite(config.intensity, 10)}"></div>
    <div class="ha3dRow"><label>Alcance</label><input id="ha3dVlDistance" type="number" min="0" step="0.1" value="${finite(config.distance, 6)}"></div>
    <div class="ha3dRow"><label>Cor base</label><input id="ha3dVlColor" type="color" value="${escapeHtml(config.color || DEFAULT_COLOR)}"></div>
    <div class="ha3dRow"><label>Ângulo do Spot (graus)</label><input id="ha3dVlAngle" type="number" min="1" max="90" step="1" value="${angleDeg.toFixed(1)}"></div>
    <div class="ha3dRow"><label>Penumbra do Spot</label><input id="ha3dVlPenumbra" type="number" min="0" max="1" step="0.05" value="${finite(config.penumbra, 0.35)}"></div>
    <div class="ha3dRow"><label>Posição X / Y / Z</label><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"><input id="ha3dVlPx" type="number" step="0.01" value="${position.x.toFixed(4)}"><input id="ha3dVlPy" type="number" step="0.01" value="${position.y.toFixed(4)}"><input id="ha3dVlPz" type="number" step="0.01" value="${position.z.toFixed(4)}"></div></div>
    <div class="ha3dRow"><label>Rotação X / Y / Z (graus)</label><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"><input id="ha3dVlRx" type="number" step="1" value="${(rotation.x * 180 / Math.PI).toFixed(2)}"><input id="ha3dVlRy" type="number" step="1" value="${(rotation.y * 180 / Math.PI).toFixed(2)}"><input id="ha3dVlRz" type="number" step="1" value="${(rotation.z * 180 / Math.PI).toFixed(2)}"></div><span class="ha3dHint">Para Spot, a direção acompanha a rotação do gizmo.</span></div>
    <div class="ha3dRow"><label><input id="ha3dVlShadow" type="checkbox" ${config.cast_shadow ? "checked" : ""}> Projetar sombras</label><label><input id="ha3dVlEnabled" type="checkbox" ${config.enabled !== false ? "checked" : ""}> Ativa quando não houver entidade HA</label></div>
    <div class="ha3dEditorActions"><button id="ha3dVlSave" type="button">Salvar luz</button><button id="ha3dVlDuplicate" class="secondary" type="button">Duplicar</button><button id="ha3dVlDelete" class="secondary" type="button">Remover luz</button></div>
  `;

  const syncSpotFields = () => {
    const spot = body.querySelector("#ha3dVlType")?.value === "spot";
    body.querySelector("#ha3dVlAngle").disabled = !spot;
    body.querySelector("#ha3dVlPenumbra").disabled = !spot;
  };
  body.querySelector("#ha3dVlType")?.addEventListener("change", syncSpotFields);
  syncSpotFields();
  body.querySelector("#ha3dVlSave")?.addEventListener("click", () => panel._saveVirtualLightForm?.(config.id));
  body.querySelector("#ha3dVlDuplicate")?.addEventListener("click", () => panel._duplicateVirtualLight?.(config.id));
  body.querySelector("#ha3dVlDelete")?.addEventListener("click", () => panel._removeVirtualLight?.(config.id));
}

function editorNumber(body, id, fallback) {
  return finite(body.querySelector(id)?.value, fallback);
}

async function saveVirtualLights(panel, lights, status) {
  await panel._saveConfigPatch?.({ virtual_lights: lights });
  if (!Array.isArray(panel._config?.virtual_lights)) throw new Error("Home Assistant não confirmou virtual_lights");
  panel._setStatus?.(status);
}

if (!proto.__ha3dVirtualLightsV1) {
  proto.__ha3dVirtualLightsV1 = true;

  const oldRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = oldRenderShell?.apply(this, args);
    installVirtualLightToolbar(this);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    rebuildVirtualLights(this);
    return result;
  };

  const oldSyncLightStates = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    const result = oldSyncLightStates?.apply(this, args);
    syncVirtualLightStates(this);
    return result;
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const result = oldToggleEditor?.apply(this, args);
    setHelperVisibility(this);
    refreshVirtualLightChooser(this);
    return result;
  };

  const oldPickObject = proto._pickObject;
  proto._pickObject = function (event) {
    if (this._editorMode && this._ha3dVirtualLightPickables?.length) {
      const rect = this._renderer.domElement.getBoundingClientRect();
      this._pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this._raycaster.setFromCamera(this._pointer, this._camera);
      const hit = this._raycaster.intersectObjects(this._ha3dVirtualLightPickables, false)[0]?.object;
      if (hit?.userData?.ha3dVirtualLightHandle) return hit.userData.ha3dVirtualLightHandle;
    }
    return oldPickObject?.call(this, event) || null;
  };

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const runtime = selectedVirtualRuntime(this);
    if (runtime) {
      renderVirtualLightForm(this, runtime);
      return;
    }
    return oldRenderEditorForm?.apply(this, args);
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (object) {
    const result = oldSelectForEditor?.call(this, object);
    const runtime = selectedVirtualRuntime(this);
    const scaleButton = this.shadowRoot?.querySelector('[data-transform="scale"]');
    if (scaleButton) scaleButton.disabled = Boolean(runtime);
    if (runtime) {
      if ((this._transformControls?.getMode?.() || this._transformControls?.mode) === "scale") this._transformControls?.setMode?.("translate");
      this._setStatus?.(`Luz virtual: ${runtime.config.name || runtime.config.id}`);
      refreshVirtualLightChooser(this);
    }
    return result;
  };

  const oldPersistSelectedTransform = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    const runtime = selectedVirtualRuntime(this);
    if (!runtime) return oldPersistSelectedTransform?.apply(this, args);

    runtime.handle.scale.set(1, 1, 1);
    const lights = virtualLightConfig(this).map((item) => item.id === runtime.config.id ? {
      ...item,
      position: runtime.handle.position.toArray(),
      rotation: [runtime.handle.rotation.x, runtime.handle.rotation.y, runtime.handle.rotation.z],
    } : item);
    try {
      await saveVirtualLights(this, lights, `Posição da luz salva: ${runtime.config.name || runtime.config.id}`);
      runtime.config = this._config.virtual_lights.find((item) => item.id === runtime.config.id) || runtime.config;
      renderVirtualLightForm(this, runtime);
    } catch (error) {
      this._setStatus?.(`Erro ao salvar luz: ${error.message || error}`);
    }
  };

  proto._createVirtualLight = async function (type = "point") {
    if (!this._hass?.user?.is_admin) return;
    const lights = virtualLightConfig(this);
    if (lights.length >= MAX_VIRTUAL_LIGHTS) {
      this._setStatus?.(`Limite de ${MAX_VIRTUAL_LIGHTS} luzes virtuais`);
      return;
    }
    const id = nextLightId(this, type);
    const center = selectedCenter(this);
    const distance = Math.max(1, finite(this._modelScale, 10) * 0.35);
    const config = {
      id,
      name: type === "spot" ? `Spot ${id.split("_").pop()}` : `Point ${id.split("_").pop()}`,
      entity_id: null,
      type: type === "spot" ? "spot" : "point",
      position: center.toArray(),
      rotation: [0, 0, 0],
      color: DEFAULT_COLOR,
      intensity: 10,
      distance,
      decay: 2,
      angle: Math.PI / 4,
      penumbra: 0.35,
      cast_shadow: true,
      enabled: true,
    };
    try {
      await saveVirtualLights(this, [...lights, config], `Luz criada: ${config.name}`);
      rebuildVirtualLights(this);
      this._selectVirtualLight?.(id);
    } catch (error) {
      this._setStatus?.(`Erro ao criar luz: ${error.message || error}`);
    }
  };

  proto._selectVirtualLight = function (id) {
    const runtime = this._ha3dVirtualLights?.get(id);
    if (!runtime) return;
    this._selectForEditor?.(runtime.handle);
    refreshVirtualLightChooser(this);
  };

  proto._saveVirtualLightForm = async function (id) {
    const runtime = this._ha3dVirtualLights?.get(id);
    const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
    if (!runtime || !body) return;

    const entityId = body.querySelector("#ha3dVlEntity")?.value?.trim() || null;
    if (entityId && !this._hass?.states?.[entityId]) {
      this._setStatus?.(`Entidade não encontrada: ${entityId}`);
      return;
    }
    const type = body.querySelector("#ha3dVlType")?.value === "spot" ? "spot" : "point";
    const position = [editorNumber(body, "#ha3dVlPx", runtime.handle.position.x), editorNumber(body, "#ha3dVlPy", runtime.handle.position.y), editorNumber(body, "#ha3dVlPz", runtime.handle.position.z)];
    const rotation = [editorNumber(body, "#ha3dVlRx", 0), editorNumber(body, "#ha3dVlRy", 0), editorNumber(body, "#ha3dVlRz", 0)].map((value) => value * Math.PI / 180);
    const updated = {
      ...runtime.config,
      name: body.querySelector("#ha3dVlName")?.value?.trim() || id,
      entity_id: entityId,
      type,
      position,
      rotation,
      color: body.querySelector("#ha3dVlColor")?.value || DEFAULT_COLOR,
      intensity: Math.max(0, editorNumber(body, "#ha3dVlIntensity", 10)),
      distance: Math.max(0, editorNumber(body, "#ha3dVlDistance", 6)),
      decay: Math.max(0, finite(runtime.config.decay, 2)),
      angle: clamp(editorNumber(body, "#ha3dVlAngle", 45), 1, 90) * Math.PI / 180,
      penumbra: clamp(editorNumber(body, "#ha3dVlPenumbra", 0.35), 0, 1),
      cast_shadow: Boolean(body.querySelector("#ha3dVlShadow")?.checked),
      enabled: Boolean(body.querySelector("#ha3dVlEnabled")?.checked),
    };
    const lights = virtualLightConfig(this).map((item) => item.id === id ? updated : item);
    try {
      await saveVirtualLights(this, lights, `Luz salva: ${updated.name}`);
      rebuildVirtualLights(this);
      this._selectVirtualLight?.(id);
    } catch (error) {
      this._setStatus?.(`Erro ao salvar luz: ${error.message || error}`);
    }
  };

  proto._duplicateVirtualLight = async function (id) {
    const source = virtualLightConfig(this).find((item) => item.id === id);
    if (!source) return;
    const newId = nextLightId(this, source.type);
    const offset = Math.max(0.15, finite(this._modelScale, 10) * 0.025);
    const copy = {
      ...source,
      id: newId,
      name: `${source.name || source.id} cópia`,
      position: [finite(source.position?.[0]) + offset, finite(source.position?.[1]), finite(source.position?.[2]) + offset],
      rotation: [...(source.rotation || [0, 0, 0])],
    };
    try {
      await saveVirtualLights(this, [...virtualLightConfig(this), copy], `Luz duplicada: ${copy.name}`);
      rebuildVirtualLights(this);
      this._selectVirtualLight?.(newId);
    } catch (error) {
      this._setStatus?.(`Erro ao duplicar luz: ${error.message || error}`);
    }
  };

  proto._removeVirtualLight = async function (id) {
    const runtime = this._ha3dVirtualLights?.get(id);
    const name = runtime?.config?.name || id;
    const lights = virtualLightConfig(this).filter((item) => item.id !== id);
    try {
      await saveVirtualLights(this, lights, `Luz removida: ${name}`);
      if (this._selectedObject?.userData?.ha3dVirtualLightId === id) {
        this._selectedObject = null;
        this._ha3dTransformTarget = null;
        this._transformControls?.detach?.();
        if (this._ha3dSelectionBox) this._ha3dSelectionBox.visible = false;
      }
      rebuildVirtualLights(this);
      const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
      if (body) body.innerHTML = '<p class="ha3dHint">Selecione um objeto 3D ou uma luz virtual para editar.</p>';
      const scaleButton = this.shadowRoot?.querySelector('[data-transform="scale"]');
      if (scaleButton) scaleButton.disabled = false;
    } catch (error) {
      this._setStatus?.(`Erro ao remover luz: ${error.message || error}`);
    }
  };
}
