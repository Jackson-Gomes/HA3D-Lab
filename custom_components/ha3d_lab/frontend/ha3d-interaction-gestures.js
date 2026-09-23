import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const HOLD_MS = 650;
const MOVE_CANCEL_PX = 10;
const editorXrayState = new WeakMap();

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function isEditorHelper(object) {
  return Boolean(
    object?.userData?.ha3dEditorHelper
    || object?.userData?.ha3dFloatingWidgetId
    || object?.userData?.ha3dVirtualLightId
  );
}

function sameLockedObject(panel, object) {
  const locked = panel?._ha3dEditorLockedObject;
  if (!locked || !object) return !locked;
  if (object === locked) return true;
  if (object.userData?.ha3dLogicalRootObject === locked) return true;
  let node = object.parent;
  while (node) {
    if (node === locked) return true;
    node = node.parent;
  }
  return false;
}

function updateLockBadge(panel) {
  const header = panel?.shadowRoot?.querySelector("#ha3dEditor .ha3dEditorHead");
  if (!header) return;
  let badge = header.querySelector("#ha3dEditorLockBadge");
  if (!panel._editorMode || !panel._ha3dEditorLockedObject) {
    badge?.remove?.();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "ha3dEditorLockBadge";
    badge.style.cssText = "font-size:10px;padding:3px 7px;border:1px solid rgba(77,231,255,.4);border-radius:99px;color:#9af4ff;background:rgba(3,35,49,.72);white-space:nowrap";
    header.insertBefore(badge, header.querySelector("button"));
  }
  const name = objectKey(panel._ha3dEditorLockedObject) || "objeto";
  badge.textContent = `🔒 ${name}`;
}

function rememberEditorMesh(mesh) {
  let state = editorXrayState.get(mesh);
  if (!state) {
    state = {
      material: mesh.material,
      renderOrder: mesh.renderOrder,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      edge: null,
      accent: null,
    };
    editorXrayState.set(mesh, state);
  }
  return state;
}

function ensureEditorXrayMaterials(panel) {
  if (!panel._ha3dEditorLockXrayMaterial) {
    panel._ha3dEditorLockXrayMaterial = new THREE.MeshBasicMaterial({
      color: 0x0bbcff,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }
  if (!panel._ha3dEditorLockXrayEdgeMaterial) {
    panel._ha3dEditorLockXrayEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0x4de7ff,
      transparent: true,
      opacity: 0.52,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
  if (!panel._ha3dEditorLockAccentMaterial) {
    panel._ha3dEditorLockAccentMaterial = new THREE.LineBasicMaterial({
      color: 0x9af4ff,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
}

function ensureEditorEdge(panel, mesh, kind) {
  const state = rememberEditorMesh(mesh);
  const key = kind === "accent" ? "accent" : "edge";
  if (!state[key] && mesh.geometry?.attributes?.position) {
    try {
      const material = kind === "accent"
        ? panel._ha3dEditorLockAccentMaterial
        : panel._ha3dEditorLockXrayEdgeMaterial;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 28), material);
      edge.name = kind === "accent" ? "__HA3D_EDITOR_LOCK_ACCENT__" : "__HA3D_EDITOR_LOCK_XRAY__";
      edge.userData.ha3dEditorLockOverlay = true;
      edge.renderOrder = kind === "accent" ? 42 : 40;
      edge.visible = false;
      mesh.add(edge);
      state[key] = edge;
    } catch (_error) {}
  }
  return state[key];
}

function selectedMeshSet(object) {
  const selected = new Set();
  if (!object) return selected;
  selected.add(object);
  object.traverse?.((node) => selected.add(node));
  return selected;
}

function restoreEditorXray(panel) {
  panel?._model?.traverse?.((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dEditorLockOverlay) return;
    const state = editorXrayState.get(mesh);
    if (!state) return;
    if (mesh.material === panel._ha3dEditorLockXrayMaterial) mesh.material = state.material;
    mesh.renderOrder = state.renderOrder;
    mesh.castShadow = state.castShadow;
    mesh.receiveShadow = state.receiveShadow;
    if (state.edge) state.edge.visible = false;
    if (state.accent) state.accent.visible = false;
  });
}

function applyEditorLockXray(panel, selected) {
  restoreEditorXray(panel);
  if (!panel?._editorMode || !panel?._ha3dEditorLockedObject || !panel?._model || !selected) return;
  ensureEditorXrayMaterials(panel);
  const keepNormal = selectedMeshSet(selected);

  panel._model.traverse((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dEditorLockOverlay || mesh.userData?.ha3dEditorHelper) return;
    const state = rememberEditorMesh(mesh);
    if (keepNormal.has(mesh)) {
      mesh.material = state.material;
      mesh.renderOrder = Math.max(4, state.renderOrder || 0);
      mesh.castShadow = state.castShadow;
      mesh.receiveShadow = state.receiveShadow;
      const accent = ensureEditorEdge(panel, mesh, "accent");
      if (accent) accent.visible = true;
      if (state.edge) state.edge.visible = false;
    } else {
      mesh.material = panel._ha3dEditorLockXrayMaterial;
      mesh.renderOrder = 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const edge = ensureEditorEdge(panel, mesh, "xray");
      if (edge) edge.visible = true;
      if (state.accent) state.accent.visible = false;
    }
  });
}

function installCardGuard(panel) {
  const layer = panel?.shadowRoot?.querySelector("#ha3dFloatingWidgetLayer");
  if (!layer || layer.dataset.ha3dIconOnlyEntities === "1") return;
  layer.dataset.ha3dIconOnlyEntities = "1";
  layer.addEventListener("click", (event) => {
    if (!event.target?.closest?.(".ha3dFloatCard")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function installLongPress(panel) {
  const canvas = panel?._renderer?.domElement;
  if (!canvas || canvas.dataset.ha3dGestureLock === "2") return;
  canvas.dataset.ha3dGestureLock = "2";

  canvas.addEventListener("pointerdown", (event) => {
    if (panel._editorMode || panel._robotCalibrationMarker || event.button > 0) return;
    const object = panel._pickObject?.(event);
    if (!object || isEditorHelper(object)) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let timer = 0;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    const move = (moveEvent) => {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > MOVE_CANCEL_PX) cleanup();
    };
    const release = () => cleanup();

    timer = setTimeout(() => {
      cleanup();
      panel._ha3dSuppressTapUntil = performance.now() + 700;
      panel._ha3dEditorLockedObject = object;
      if (!panel._editorMode) panel._toggleEditor?.();
      panel._selectForEditor?.(object);
      const selected = panel._selectedObject || object;
      panel._ha3dEditorLockedObject = selected;
      applyEditorLockXray(panel, selected);
      updateLockBadge(panel);
      const name = objectKey(selected) || "objeto";
      panel._setStatus?.(`Editor travado em: ${name}`);
    }, HOLD_MS);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release, { once: true });
    window.addEventListener("pointercancel", release, { once: true });
  });
}

if (!proto.__ha3dInteractionGesturesV2) {
  proto.__ha3dInteractionGesturesV2 = true;

  // Geometry never opens/toggles Home Assistant entities anymore. Entity
  // interaction is intentionally owned by the on-screen HA markers only.
  proto._runEntityAction = async function () {};

  const oldWireUi = proto._wireUi;
  proto._wireUi = function (...args) {
    const result = oldWireUi?.apply(this, args);
    installLongPress(this);
    installCardGuard(this);
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    queueMicrotask(() => {
      installLongPress(this);
      installCardGuard(this);
      updateLockBadge(this);
    });
    return result;
  };

  // Click and double-click on geometry are intentionally neutral now. The
  // reliable interaction gesture is the long-press, which enters locked edit.
  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._robotCalibrationMarker) return;

    if (this._editorMode) {
      const object = this._pickObject?.(event);
      if (this._ha3dEditorLockedObject && object && !isEditorHelper(object) && !sameLockedObject(this, object)) return;
      return oldPick?.call(this, event);
    }

    if (performance.now() < (this._ha3dSuppressTapUntil || 0)) return;
    return;
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (object, ...args) {
    if (
      this._editorMode
      && this._ha3dEditorLockedObject
      && object
      && !isEditorHelper(object)
      && !sameLockedObject(this, object)
    ) {
      this._setStatus?.(`Editor travado em: ${objectKey(this._ha3dEditorLockedObject) || "objeto"}`);
      updateLockBadge(this);
      return this._selectedObject;
    }
    const result = oldSelectForEditor?.call(this, object, ...args);
    if (this._editorMode && this._ha3dEditorLockedObject) applyEditorLockXray(this, this._selectedObject || this._ha3dEditorLockedObject);
    updateLockBadge(this);
    return result;
  };

  const oldBeginObjectDrag = proto._beginObjectDrag;
  proto._beginObjectDrag = function (event, object, ...args) {
    if (
      this._editorMode
      && this._ha3dEditorLockedObject
      && object
      && !isEditorHelper(object)
      && !sameLockedObject(this, object)
    ) return;
    return oldBeginObjectDrag?.call(this, event, object, ...args);
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const wasEditing = Boolean(this._editorMode);
    const result = oldToggleEditor?.apply(this, args);
    if (wasEditing && !this._editorMode) {
      restoreEditorXray(this);
      this._ha3dEditorLockedObject = null;
    } else if (this._editorMode && this._ha3dEditorLockedObject) {
      applyEditorLockXray(this, this._selectedObject || this._ha3dEditorLockedObject);
    }
    updateLockBadge(this);
    installCardGuard(this);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    restoreEditorXray(this);
    this._ha3dEditorLockedObject = null;
    const result = await oldLoadModel?.apply(this, args);
    updateLockBadge(this);
    return result;
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    restoreEditorXray(this);
    return oldDisconnected?.apply(this, args);
  };
}
