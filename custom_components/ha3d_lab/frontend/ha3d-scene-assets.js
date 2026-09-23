import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

function sceneAssets(panel) {
  return Array.isArray(panel?._config?.scene_assets) ? panel._config.scene_assets : [];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function assetRuntime(panel, id) {
  return panel?._ha3dSceneAssets?.get?.(id) || null;
}

function selectedAssetRuntime(panel) {
  const id = panel?._selectedObject?.userData?.ha3dSceneAssetId;
  return id ? assetRuntime(panel, id) : null;
}

function mutableAsset(item, runtime = null) {
  const root = runtime?.root;
  return {
    id: item.id,
    name: String(item.name || item.id),
    position: root ? [root.position.x, root.position.y, root.position.z] : [...(item.position || [0, 0, 0])],
    rotation: root ? [root.rotation.x, root.rotation.y, root.rotation.z] : [...(item.rotation || [0, 0, 0])],
    scale: root ? [root.scale.x, root.scale.y, root.scale.z] : [...(item.scale || [1, 1, 1])],
    visible: root ? root.visible !== false : item.visible !== false,
  };
}

function mutableAssets(panel, overrideId = null, override = null) {
  return sceneAssets(panel).map((item) => {
    const runtime = assetRuntime(panel, item.id);
    const base = mutableAsset(item, runtime);
    return item.id === overrideId && override ? { ...base, ...override, id: item.id } : base;
  });
}

async function saveAssets(panel, assets, status = null) {
  panel._config = await panel._hass.callApi("POST", "ha3d_lab_lab/scene_assets", { scene_assets: assets });
  if (status) panel._setStatus?.(status);
  refreshAssetChooser(panel);
  return panel._config;
}

function versionedUrl(panel, item) {
  return panel._versionedModelUrl?.(item.url, item.revision) || item.url;
}

function markAssetRoot(root, item) {
  root.name = `HA3D_SceneAsset_${item.id}`;
  root.userData ||= {};
  root.userData.ha3dSceneAssetId = item.id;
  root.userData.ha3dSceneAssetName = item.name;
  root.userData.ha3dLogicalRoot = true;
  root.userData.ha3dOriginalNodeName = `scene_asset:${item.id}`;
  root.userData.ha3dBaseTransformV2 = {
    position: [...(item.position || [0, 0, 0])],
    rotation: [...(item.rotation || [0, 0, 0]), "XYZ"],
    scale: [...(item.scale || [1, 1, 1])],
  };
  root.traverse((node) => {
    node.userData ||= {};
    node.userData.ha3dSceneAssetRoot = root;
    node.userData.ha3dLogicalRootObject = root;
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
}

function applyAssetTransform(root, item) {
  root.position.fromArray(item.position || [0, 0, 0]);
  const rotation = item.rotation || [0, 0, 0];
  root.rotation.set(finite(rotation[0]), finite(rotation[1]), finite(rotation[2]));
  root.scale.fromArray(item.scale || [1, 1, 1]);
  root.visible = item.visible !== false;
  root.updateMatrixWorld(true);
}

function collectAssetLights(panel, root) {
  const previous = Array.isArray(panel._modelLights) ? [...panel._modelLights] : [];
  panel._collectModelLights?.(root);
  const imported = Array.isArray(panel._modelLights) ? [...panel._modelLights] : [];
  panel._modelLights = [...previous, ...imported.filter((light) => !previous.includes(light))];
  return imported;
}

function refreshBindingsAfterAssetChange(panel) {
  panel._indexBindings?.();
  panel._bindModelLights?.();
  panel._bindEntityLightMarkers?.();
  panel._restoreUnboundModelLights?.();
  panel._bindAdvancedMarkers?.();
  panel._syncLightStates?.();
}

function disposeMaterial(material) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value?.isTexture) value.dispose?.();
  }
  material.dispose?.();
}

function disposeAssetRoot(root) {
  root?.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach(disposeMaterial);
    else disposeMaterial(node.material);
  });
  root?.removeFromParent?.();
}

function removeAssetBindings(panel, runtime) {
  if (!runtime?.root) return;
  const nodes = new Set();
  runtime.root.traverse((node) => nodes.add(node));
  panel._modelLights = (panel._modelLights || []).filter((light) => !nodes.has(light));

  for (const [entity, binding] of [...(panel._lightBindings?.entries?.() || [])]) {
    const anchorRemoved = nodes.has(binding?.anchor);
    const lights = (binding?.lights || []).filter((light) => !nodes.has(light));
    if (anchorRemoved) {
      binding?.marker?.remove?.();
      panel._lightBindings.delete(entity);
    } else {
      binding.lights = lights;
      binding.light = lights[0] || null;
    }
  }
}

async function loadOneAsset(panel, item) {
  if (!panel?._model || !item?.id || !item?.url) return null;
  const existing = assetRuntime(panel, item.id);
  if (existing) return existing;

  const gltf = await panel._loader.loadAsync(versionedUrl(panel, item));
  const root = new THREE.Group();
  root.add(gltf.scene);
  markAssetRoot(root, item);
  applyAssetTransform(root, item);
  panel._model.add(root);
  root.updateMatrixWorld(true);

  const runtime = { config: item, root, lights: [] };
  panel._ha3dSceneAssets ||= new Map();
  panel._ha3dSceneAssets.set(item.id, runtime);
  runtime.lights = collectAssetLights(panel, root);
  return runtime;
}

async function loadAllAssets(panel) {
  if (!panel?._model) return;

  for (const runtime of panel._ha3dSceneAssets?.values?.() || []) {
    removeAssetBindings(panel, runtime);
    disposeAssetRoot(runtime.root);
  }
  panel._ha3dSceneAssets = new Map();

  const failures = [];
  for (const item of sceneAssets(panel)) {
    try {
      await loadOneAsset(panel, item);
    } catch (error) {
      console.error("[HA3D] scene asset load failed", item?.id, error);
      failures.push(item?.name || item?.id || "asset");
    }
  }

  refreshBindingsAfterAssetChange(panel);
  refreshAssetChooser(panel);
  if (failures.length) panel._setStatus?.(`Falha ao carregar asset: ${failures.join(", ")}`);
}

function refreshAssetChooser(panel) {
  const select = panel?.shadowRoot?.querySelector("#ha3dSceneAssetSelect");
  if (!select) return;
  const selectedId = panel?._selectedObject?.userData?.ha3dSceneAssetId || "";
  select.replaceChildren(new Option("Assets da cena…", ""));
  for (const item of sceneAssets(panel)) {
    select.appendChild(new Option(`${item.visible === false ? "(oculto) " : ""}${item.name || item.id}`, item.id));
  }
  select.value = selectedId;
}

function installAssetToolbar(panel) {
  const editor = panel?.shadowRoot?.querySelector("#ha3dEditor");
  const transformRow = editor?.querySelector(".ha3dTransform");
  if (!editor || !transformRow || editor.querySelector("#ha3dSceneAssetToolbar")) return;

  const input = document.createElement("input");
  input.id = "ha3dSceneAssetFile";
  input.type = "file";
  input.accept = ".glb,model/gltf-binary";
  input.style.display = "none";

  const row = document.createElement("div");
  row.id = "ha3dSceneAssetToolbar";
  row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:6px;margin:8px 0";
  row.innerHTML = `
    <select id="ha3dSceneAssetSelect" title="Selecionar GLB adicionado à cena" style="min-width:0;padding:7px;border-radius:8px;background:#111;color:inherit;border:1px solid #ffffff2b"></select>
    <button id="ha3dAddSceneAsset" class="secondary" type="button">+ GLB à cena</button>
  `;
  transformRow.insertAdjacentElement("afterend", row);
  row.insertAdjacentElement("afterend", input);

  row.querySelector("#ha3dAddSceneAsset")?.addEventListener("click", () => input.click());
  row.querySelector("#ha3dSceneAssetSelect")?.addEventListener("change", (event) => {
    if (event.target.value) panel._selectSceneAsset?.(event.target.value);
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) await panel._uploadSceneAsset?.(file);
  });
  refreshAssetChooser(panel);
}

function installAssetEditorSection(panel) {
  const runtime = selectedAssetRuntime(panel);
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!runtime || !body || body.querySelector("#ha3dSceneAssetEditor")) return;

  const item = sceneAssets(panel).find((asset) => asset.id === runtime.config.id) || runtime.config;
  const section = document.createElement("section");
  section.id = "ha3dSceneAssetEditor";
  section.style.cssText = "border:1px solid #ffffff24;border-radius:10px;padding:10px;margin:8px 0 12px";
  section.innerHTML = `
    <div class="ha3dRow"><label>Asset GLB da cena</label><input id="ha3dSceneAssetName" value="${escapeHtml(item.name || item.id)}"></div>
    <div class="ha3dRow"><label><input id="ha3dSceneAssetVisible" type="checkbox" ${runtime.root.visible !== false ? "checked" : ""}> Visível</label><span class="ha3dHint">O gizmo move, rotaciona e escala este GLB inteiro. Objetos internos continuam disponíveis para auto-binding por entity_id.</span></div>
    <div class="ha3dEditorActions"><button id="ha3dSaveSceneAsset" class="secondary" type="button">Salvar asset</button><button id="ha3dRemoveSceneAsset" class="secondary" type="button">Remover da cena</button></div>
  `;
  body.prepend(section);

  section.querySelector("#ha3dSaveSceneAsset")?.addEventListener("click", async () => {
    const name = section.querySelector("#ha3dSceneAssetName")?.value?.trim() || item.id;
    const visible = Boolean(section.querySelector("#ha3dSceneAssetVisible")?.checked);
    runtime.root.visible = visible;
    runtime.root.userData.ha3dSceneAssetName = name;
    try {
      await saveAssets(panel, mutableAssets(panel, item.id, { name, visible }), `Asset salvo: ${name}`);
      runtime.config = sceneAssets(panel).find((asset) => asset.id === item.id) || { ...item, name, visible };
    } catch (error) {
      panel._setStatus?.(`Erro ao salvar asset: ${error.message || error}`);
    }
  });

  section.querySelector("#ha3dRemoveSceneAsset")?.addEventListener("click", () => panel._removeSceneAsset?.(item.id));
}

if (!proto.__ha3dSceneAssetsV1) {
  proto.__ha3dSceneAssetsV1 = true;

  const oldRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = oldRenderShell?.apply(this, args);
    installAssetToolbar(this);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    await loadAllAssets(this);
    return result;
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const result = oldToggleEditor?.apply(this, args);
    refreshAssetChooser(this);
    return result;
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (...args) {
    const result = oldSelectForEditor?.apply(this, args);
    refreshAssetChooser(this);
    return result;
  };

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installAssetEditorSection(this);
    return result;
  };

  const oldPersistSelectedTransform = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    const runtime = selectedAssetRuntime(this);
    if (!runtime) return oldPersistSelectedTransform?.apply(this, args);
    const item = sceneAssets(this).find((asset) => asset.id === runtime.config.id) || runtime.config;
    try {
      await saveAssets(this, mutableAssets(this), `Posição do asset salva: ${item.name || item.id}`);
      runtime.config = sceneAssets(this).find((asset) => asset.id === item.id) || item;
    } catch (error) {
      console.error("[HA3D] failed to persist scene asset transform", item.id, error);
      this._setStatus?.(`Erro ao salvar asset: ${error.message || error}`);
    }
  };

  proto._uploadSceneAsset = async function (file) {
    if (!this._hass?.user?.is_admin) return;
    if (!file?.name?.toLowerCase?.().endsWith(".glb")) {
      this._setStatus?.("Selecione um arquivo .glb");
      return;
    }
    if (!this._model) {
      this._setStatus?.("Carregue primeiro o GLB principal da casa");
      return;
    }

    const form = new FormData();
    form.append("file", file, file.name);
    this._setStatus?.(`Adicionando ${file.name} à cena…`);
    try {
      const response = await this._hass.fetchWithAuth("/api/ha3d_lab/scene_assets/upload", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this._config = { ...(this._config || {}), scene_assets: result.scene_assets || [] };
      const runtime = await loadOneAsset(this, result.asset);
      refreshBindingsAfterAssetChange(this);
      refreshAssetChooser(this);
      if (runtime) this._selectForEditor?.(runtime.root);
      this._setStatus?.(`GLB adicionado à cena: ${result.asset?.name || file.name}`);
    } catch (error) {
      console.error("[HA3D] scene asset upload failed", error);
      this._setStatus?.(`Falha ao adicionar GLB: ${error.message || error}`);
    }
  };

  proto._selectSceneAsset = function (id) {
    const runtime = assetRuntime(this, id);
    if (!runtime?.root) return;
    if (!runtime.root.visible) runtime.root.visible = true;
    this._selectForEditor?.(runtime.root);
    refreshAssetChooser(this);
  };

  proto._removeSceneAsset = async function (id) {
    const runtime = assetRuntime(this, id);
    const item = sceneAssets(this).find((asset) => asset.id === id);
    if (!item) return;
    try {
      const remaining = mutableAssets(this).filter((asset) => asset.id !== id);
      await saveAssets(this, remaining, `Asset removido: ${item.name || id}`);
      if (this._selectedObject?.userData?.ha3dSceneAssetId === id) {
        this._selectedObject = null;
        this._ha3dTransformTarget = null;
        this._transformControls?.detach?.();
        if (this._ha3dSelectionBox) this._ha3dSelectionBox.visible = false;
      }
      removeAssetBindings(this, runtime);
      disposeAssetRoot(runtime?.root);
      this._ha3dSceneAssets?.delete?.(id);
      refreshBindingsAfterAssetChange(this);
      refreshAssetChooser(this);
      const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
      if (body) body.innerHTML = '<p class="ha3dHint">Selecione um objeto 3D, uma luz virtual ou um asset GLB para editar.</p>';
    } catch (error) {
      console.error("[HA3D] scene asset removal failed", error);
      this._setStatus?.(`Erro ao remover asset: ${error.message || error}`);
    }
  };
}
