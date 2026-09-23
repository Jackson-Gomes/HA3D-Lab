import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const GENERIC_ROOT_NAMES = new Set(["scene", "root", "model", "gltf_scene_root_node", "sketchup"]);

function safeName(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function isGenericWrapper(object) {
  return GENERIC_ROOT_NAMES.has(safeName(object).toLowerCase());
}

function logicalRoots(panel) {
  const model = panel?._model;
  if (!model) return [];
  let roots = [...model.children];
  if (roots.length === 1 && roots[0]?.children?.length > 1 && isGenericWrapper(roots[0])) roots = [...roots[0].children];
  return roots.filter((item) => item && !item.userData?.ha3dEditorHelper);
}

function rememberBaseTransform(object) {
  if (!object?.userData || object.userData.ha3dBaseTransformV2) return;
  object.userData.ha3dBaseTransformV2 = {
    position: object.position.toArray(),
    rotation: object.rotation.toArray(),
    scale: object.scale.toArray(),
  };
}

function annotateLogicalRoots(panel) {
  const model = panel?._model;
  if (!model) return [];
  const roots = logicalRoots(panel);
  for (const root of roots) {
    root.userData ||= {};
    root.userData.ha3dLogicalRoot = true;
    root.userData.ha3dOriginalNodeName ||= root.name || "";
    rememberBaseTransform(root);
    root.traverse((node) => {
      node.userData ||= {};
      node.userData.ha3dLogicalRootObject = root;
    });
  }
  panel._ha3dLogicalRoots = roots;
  return roots;
}

function resolveLogicalRoot(panel, object) {
  if (!object || !panel?._model) return object || null;
  if (object.userData?.ha3dLogicalRootObject) return object.userData.ha3dLogicalRootObject;
  let node = object;
  while (node && node !== panel._model) {
    if (node.userData?.ha3dLogicalRoot) return node;
    if (node.parent === panel._model) return node;
    node = node.parent;
  }
  return object;
}

function objectKey(object) {
  return safeName(object) || object?.uuid || "";
}

function transformPayload(object) {
  return {
    position: object.position.toArray(),
    rotation: object.rotation.toArray(),
    scale: object.scale.toArray(),
  };
}

function applyLocalTransform(object, value) {
  if (!object || !value) return;
  if (Array.isArray(value.position)) object.position.fromArray(value.position);
  if (Array.isArray(value.rotation)) object.rotation.fromArray(value.rotation);
  if (Array.isArray(value.scale)) object.scale.fromArray(value.scale);
  object.updateMatrixWorld(true);
}

function setWorldMatrix(object, worldMatrix) {
  if (!object) return;
  const local = worldMatrix.clone();
  if (object.parent) {
    object.parent.updateMatrixWorld(true);
    local.premultiply(object.parent.matrixWorld.clone().invert());
  }
  local.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
}

function countMeshes(object) {
  let count = 0;
  object?.traverse?.((node) => { if (node.isMesh) count += 1; });
  return count;
}

function visualBounds(object) {
  if (!object) return null;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}

function visualCenter(object) {
  const box = visualBounds(object);
  return box ? box.getCenter(new THREE.Vector3()) : object?.getWorldPosition?.(new THREE.Vector3()) || new THREE.Vector3();
}

function ensureSelectionBox(panel, object = panel?._selectedObject) {
  if (!panel?._scene) return null;
  const target = resolveLogicalRoot(panel, object);
  if (!target || !panel._editorMode) {
    if (panel._ha3dSelectionBox) panel._ha3dSelectionBox.visible = false;
    return panel._ha3dSelectionBox || null;
  }
  if (!panel._ha3dSelectionBox) {
    panel._ha3dSelectionBox = new THREE.BoxHelper(target, 0x4fc3f7);
    panel._ha3dSelectionBox.name = "HA3D_EditorSelectionBox";
    panel._ha3dSelectionBox.userData.ha3dEditorHelper = true;
    panel._scene.add(panel._ha3dSelectionBox);
  } else {
    panel._ha3dSelectionBox.setFromObject(target);
  }
  panel._ha3dSelectionBox.visible = true;
  panel._ha3dSelectionBox.update();
  return panel._ha3dSelectionBox;
}

function ensurePivotProxy(panel, target = panel?._selectedObject, recenter = true) {
  target = resolveLogicalRoot(panel, target);
  if (!panel?._scene || !target) return null;

  let proxy = panel._ha3dTransformPivot;
  if (!proxy) {
    proxy = new THREE.Object3D();
    proxy.name = "HA3D_EditorVisualPivot";
    proxy.userData.ha3dEditorHelper = true;
    panel._scene.add(proxy);
    panel._ha3dTransformPivot = proxy;
  }

  panel._ha3dTransformTarget = target;
  if (recenter) {
    proxy.position.copy(visualCenter(target));
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    proxy.updateMatrixWorld(true);
  }

  panel._transformControls?.attach?.(proxy);
  if (panel._transformControls) {
    panel._transformControls.enabled = Boolean(panel._editorMode);
    panel._transformControls.visible = Boolean(panel._editorMode);
  }
  return proxy;
}

function captureProxyTransform(panel) {
  const proxy = panel?._ha3dTransformPivot;
  const target = resolveLogicalRoot(panel, panel?._ha3dTransformTarget || panel?._selectedObject);
  if (!proxy || !target) return;
  proxy.updateMatrixWorld(true);
  target.updateMatrixWorld(true);
  panel._ha3dProxyStartWorld = proxy.matrixWorld.clone();
  panel._ha3dTargetStartWorld = target.matrixWorld.clone();
}

function applyProxyDelta(panel) {
  if (panel?._ha3dApplyingProxyDelta) return;
  const proxy = panel?._ha3dTransformPivot;
  const target = resolveLogicalRoot(panel, panel?._ha3dTransformTarget || panel?._selectedObject);
  const proxyStart = panel?._ha3dProxyStartWorld;
  const targetStart = panel?._ha3dTargetStartWorld;
  if (!proxy || !target || !proxyStart || !targetStart) return;

  panel._ha3dApplyingProxyDelta = true;
  try {
    proxy.updateMatrixWorld(true);
    const delta = proxy.matrixWorld.clone().multiply(proxyStart.clone().invert());
    const newTargetWorld = delta.multiply(targetStart.clone());
    setWorldMatrix(target, newTargetWorld);
    ensureSelectionBox(panel, target);
    syncPreciseInputs(panel);
  } finally {
    panel._ha3dApplyingProxyDelta = false;
  }
}

function syncPreciseInputs(panel) {
  const object = resolveLogicalRoot(panel, panel?._selectedObject);
  const root = panel?.shadowRoot;
  if (!object || !root) return;
  const center = visualCenter(object);
  const values = { px: center.x, py: center.y, pz: center.z };
  for (const [key, value] of Object.entries(values)) {
    const input = root.querySelector(`[data-ha3d-transform="${key}"]`);
    if (input && document.activeElement !== input) input.value = Number(value).toFixed(4);
  }
}

function translateVisualCenterTo(object, desiredCenter) {
  if (!object) return;
  object.updateMatrixWorld(true);
  const currentCenter = visualCenter(object);
  const delta = desiredCenter.clone().sub(currentCenter);
  const translation = new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z);
  const world = translation.multiply(object.matrixWorld.clone());
  setWorldMatrix(object, world);
}

function installPreciseControls(panel) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  const object = resolveLogicalRoot(panel, panel?._selectedObject);
  if (!body || !object || body.querySelector("#ha3dPreciseTransform")) return;

  const section = document.createElement("div");
  section.id = "ha3dPreciseTransform";
  section.innerHTML = `
    <div class="ha3dRow">
      <label>Centro visual do objeto</label>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        <input data-ha3d-transform="px" type="number" step="0.01" title="Centro visual X">
        <input data-ha3d-transform="py" type="number" step="0.01" title="Centro visual Y (altura)">
        <input data-ha3d-transform="pz" type="number" step="0.01" title="Centro visual Z">
      </div>
      <span class="ha3dHint">X / Y / Z são do centro real da geometria, não do pivot importado do GLB.</span>
    </div>
    <div class="ha3dEditorActions">
      <button id="ha3dApplyPreciseTransform" class="secondary" type="button">Aplicar posição</button>
      <button id="ha3dResetObjectTransform" class="secondary" type="button">Restaurar posição do GLB</button>
    </div>
  `;
  body.prepend(section);
  syncPreciseInputs(panel);

  section.querySelector("#ha3dApplyPreciseTransform")?.addEventListener("click", async () => {
    const selected = resolveLogicalRoot(panel, panel._selectedObject);
    if (!selected) return;
    const current = visualCenter(selected);
    const read = (key, fallback) => {
      const value = Number(section.querySelector(`[data-ha3d-transform="${key}"]`)?.value);
      return Number.isFinite(value) ? value : fallback;
    };
    translateVisualCenterTo(selected, new THREE.Vector3(
      read("px", current.x),
      read("py", current.y),
      read("pz", current.z),
    ));
    ensurePivotProxy(panel, selected, true);
    ensureSelectionBox(panel, selected);
    syncPreciseInputs(panel);
    await panel._persistSelectedTransform?.();
  });

  section.querySelector("#ha3dResetObjectTransform")?.addEventListener("click", async () => {
    const selected = resolveLogicalRoot(panel, panel._selectedObject);
    const base = selected?.userData?.ha3dBaseTransformV2;
    if (!selected || !base) return;
    applyLocalTransform(selected, base);
    const key = objectKey(selected);
    const positions = { ...(panel._config?.object_positions || {}) };
    delete positions[key];
    try {
      await panel._saveConfigPatch?.({ object_positions: positions });
      ensurePivotProxy(panel, selected, true);
      ensureSelectionBox(panel, selected);
      syncPreciseInputs(panel);
      panel._setStatus?.("Posição original do GLB restaurada");
    } catch (error) {
      panel._setStatus?.(`Erro ao restaurar posição: ${error.message || error}`);
    }
  });
}

if (!proto.__ha3dEditorLogicalRootV2) {
  proto.__ha3dEditorLogicalRootV2 = true;

  proto._applySavedObjectPositions = function () {
    const saved = this._config?.object_positions || {};
    const roots = annotateLogicalRoots(this);
    for (const root of roots) {
      const value = saved[objectKey(root)];
      if (value) applyLocalTransform(root, value);
    }
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    annotateLogicalRoots(this);
    if (this._ha3dTransformPivot) this._ha3dTransformPivot.visible = false;
    ensureSelectionBox(this, null);
    return result;
  };

  proto._pickObject = function (event) {
    if (!this._model) return null;
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const hit = this._raycaster.intersectObject(this._model, true)
      .find((item) => !item.object?.userData?.ha3dEditorHelper);
    return resolveLogicalRoot(this, hit?.object || null);
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (object) {
    const target = resolveLogicalRoot(this, object);
    if (!target) return;
    const result = oldSelectForEditor?.call(this, target);
    this._selectedObject = target;
    ensurePivotProxy(this, target, true);
    ensureSelectionBox(this, target);
    syncPreciseInputs(this);
    const pieces = countMeshes(target);
    const name = objectKey(target) || "objeto";
    const center = visualCenter(target);
    this._setStatus?.(`Selecionado: ${name}${pieces > 1 ? ` · ${pieces} partes` : ""} · centro ${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}`);
    return result;
  };

  proto._beginObjectDrag = function (event, object) {
    const target = resolveLogicalRoot(this, object);
    if (!target || !this._editorMode) return;

    const orbitWasEnabled = this._controls?.enabled !== false;
    if (this._controls) this._controls.enabled = false;
    this._ha3dEditorDirectDrag = true;

    target.updateMatrixWorld(true);
    const startTargetWorld = target.matrixWorld.clone();
    const startCenter = visualCenter(target);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -startCenter.y);
    const point = new THREE.Vector3();

    const setPointer = (pointerEvent) => {
      const rect = this._renderer.domElement.getBoundingClientRect();
      this._pointer.set(
        ((pointerEvent.clientX - rect.left) / rect.width) * 2 - 1,
        -((pointerEvent.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this._raycaster.setFromCamera(this._pointer, this._camera);
    };

    setPointer(event);
    if (!this._raycaster.ray.intersectPlane(plane, point)) {
      this._ha3dEditorDirectDrag = false;
      if (this._controls) this._controls.enabled = orbitWasEnabled;
      return;
    }
    const offset = startCenter.clone().sub(point);

    const move = (moveEvent) => {
      setPointer(moveEvent);
      if (!this._raycaster.ray.intersectPlane(plane, point)) return;
      const desiredCenter = point.clone().add(offset);
      desiredCenter.y = startCenter.y;
      const delta = desiredCenter.clone().sub(startCenter);
      const translation = new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z);
      setWorldMatrix(target, translation.multiply(startTargetWorld.clone()));
      ensurePivotProxy(this, target, true);
      ensureSelectionBox(this, target);
      syncPreciseInputs(this);
    };

    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this._ha3dEditorDirectDrag = false;
      ensurePivotProxy(this, target, true);
      if (this._controls && !this._transformControls?.dragging) this._controls.enabled = orbitWasEnabled;
      await this._persistSelectedTransform?.();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  };

  const oldPersistSelectedTransform = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    const target = resolveLogicalRoot(this, this._selectedObject);
    if (!target) return oldPersistSelectedTransform?.apply(this, args);
    this._selectedObject = target;
    const key = objectKey(target);
    if (!key) return;
    const positions = {
      ...(this._config?.object_positions || {}),
      [key]: transformPayload(target),
    };
    try {
      await this._saveConfigPatch?.({ object_positions: positions });
      ensurePivotProxy(this, target, true);
      ensureSelectionBox(this, target);
      syncPreciseInputs(this);
      this._setStatus?.("Transformação do objeto completo salva");
    } catch (error) {
      this._setStatus?.(`Erro ao salvar transformação: ${error.message || error}`);
    }
  };

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installPreciseControls(this);
    return result;
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const result = oldToggleEditor?.apply(this, args);
    if (!this._editorMode) {
      if (this._ha3dSelectionBox) this._ha3dSelectionBox.visible = false;
      if (this._ha3dTransformPivot) this._ha3dTransformPivot.visible = false;
    } else if (this._selectedObject) {
      ensurePivotProxy(this, this._selectedObject, true);
      if (this._ha3dTransformPivot) this._ha3dTransformPivot.visible = true;
      ensureSelectionBox(this, this._selectedObject);
    }
    return result;
  };

  const oldInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    const result = oldInitViewer?.apply(this, args);
    queueMicrotask(() => {
      const controls = this._transformControls;
      if (!controls || controls.userData?.ha3dVisualPivotV2) return;
      controls.userData ||= {};
      controls.userData.ha3dVisualPivotV2 = true;
      controls.addEventListener("mouseDown", () => captureProxyTransform(this));
      controls.addEventListener("objectChange", () => applyProxyDelta(this));
      controls.addEventListener("mouseUp", () => {
        const target = resolveLogicalRoot(this, this._selectedObject);
        if (target) ensurePivotProxy(this, target, true);
        this._ha3dProxyStartWorld = null;
        this._ha3dTargetStartWorld = null;
      });
    });
    return result;
  };
}
