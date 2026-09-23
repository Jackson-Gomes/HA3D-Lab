import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const inspectionState = new WeakMap();

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function boundsFor(object) {
  if (!object) return null;
  object.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}

function centerFor(object) {
  const box = boundsFor(object);
  return box ? box.getCenter(new THREE.Vector3()) : object?.getWorldPosition?.(new THREE.Vector3()) || new THREE.Vector3();
}

function rememberMesh(mesh) {
  let state = inspectionState.get(mesh);
  if (!state) {
    state = {
      material: mesh.material,
      renderOrder: mesh.renderOrder,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      edge: null,
      accent: null,
    };
    inspectionState.set(mesh, state);
  }
  return state;
}

function ensureMaterials(panel) {
  if (!panel._ha3dInspectXrayMaterial) {
    panel._ha3dInspectXrayMaterial = new THREE.MeshBasicMaterial({
      color: 0x0bbcff,
      transparent: true,
      opacity: 0.10,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }
  if (!panel._ha3dInspectEdgeMaterial) {
    panel._ha3dInspectEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0x4de7ff,
      transparent: true,
      opacity: 0.44,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
  if (!panel._ha3dInspectAccentMaterial) {
    panel._ha3dInspectAccentMaterial = new THREE.LineBasicMaterial({
      color: 0x9af4ff,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
}

function ensureEdge(panel, mesh, accent = false) {
  const state = rememberMesh(mesh);
  const key = accent ? "accent" : "edge";
  if (!state[key] && mesh.geometry?.attributes?.position) {
    try {
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 28),
        accent ? panel._ha3dInspectAccentMaterial : panel._ha3dInspectEdgeMaterial,
      );
      edge.name = accent ? "__HA3D_INSPECT_ACCENT__" : "__HA3D_INSPECT_XRAY__";
      edge.userData.ha3dObjectInspectionOverlay = true;
      edge.renderOrder = accent ? 34 : 32;
      edge.visible = false;
      mesh.add(edge);
      state[key] = edge;
    } catch (_error) {}
  }
  return state[key];
}

function restoreInspection(panel) {
  panel?._model?.traverse?.((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dObjectInspectionOverlay) return;
    const state = inspectionState.get(mesh);
    if (!state) return;
    if (mesh.material === panel._ha3dInspectXrayMaterial) mesh.material = state.material;
    mesh.renderOrder = state.renderOrder;
    mesh.castShadow = state.castShadow;
    mesh.receiveShadow = state.receiveShadow;
    if (state.edge) state.edge.visible = false;
    if (state.accent) state.accent.visible = false;
  });
}

function selectedSet(object) {
  const set = new Set();
  if (!object) return set;
  set.add(object);
  object.traverse?.((node) => set.add(node));
  return set;
}

function applyInspection(panel, selected) {
  restoreInspection(panel);
  if (!panel?._model || !selected || panel._editorMode) return;
  ensureMaterials(panel);
  const keep = selectedSet(selected);

  panel._model.traverse((mesh) => {
    if (!mesh?.isMesh || mesh.userData?.ha3dObjectInspectionOverlay || mesh.userData?.ha3dEditorHelper) return;
    const state = rememberMesh(mesh);
    if (keep.has(mesh)) {
      mesh.material = state.material;
      mesh.renderOrder = Math.max(4, state.renderOrder || 0);
      mesh.castShadow = state.castShadow;
      mesh.receiveShadow = state.receiveShadow;
      const accent = ensureEdge(panel, mesh, true);
      if (accent) accent.visible = true;
      if (state.edge) state.edge.visible = false;
    } else {
      mesh.material = panel._ha3dInspectXrayMaterial;
      mesh.renderOrder = 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const edge = ensureEdge(panel, mesh, false);
      if (edge) edge.visible = true;
      if (state.accent) state.accent.visible = false;
    }
  });
}

function clearInspection(panel) {
  panel._ha3dObjectInspection = null;
  panel._ha3dInspectorAnchorKey = null;
  panel._ha3dInspectorObject = null;
  panel._ha3dObjectZoomToken = (panel._ha3dObjectZoomToken || 0) + 1;
  restoreInspection(panel);
}

function ease(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function zoomTo(panel, object, strong = false) {
  if (!panel?._camera || !panel?._controls || !object || panel._editorMode || panel._cinematicActive) return;
  const box = boundsFor(object);
  if (!box) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const objectScale = Math.max(size.x, size.y, size.z, Math.max(0.001, Number(panel._modelScale) || 10) * 0.012);
  const sceneScale = Math.max(0.001, Number(panel._modelScale) || 10);
  const startPos = panel._camera.position.clone();
  const startTarget = panel._controls.target.clone();
  let direction = startPos.clone().sub(center);
  const currentDistance = Math.max(direction.length(), 0.01);
  if (direction.lengthSq() < 1e-8) direction.set(1, 0.45, 1);
  direction.normalize();

  const ratio = strong ? 0.46 : 0.72;
  const minimum = strong
    ? Math.max(objectScale * 2.0, sceneScale * 0.045)
    : Math.max(objectScale * 2.8, sceneScale * 0.07);
  const desired = Math.min(currentDistance * ratio, minimum);
  if (!(desired < currentDistance * 0.98)) return;

  const endPos = center.clone().add(direction.multiplyScalar(desired));
  const token = (panel._ha3dObjectZoomToken || 0) + 1;
  panel._ha3dObjectZoomToken = token;
  const oldEnabled = panel._controls.enabled;
  panel._controls.enabled = false;
  panel._cameraAnimating = true;
  const started = performance.now();
  const duration = strong ? 520 : 420;

  const frame = (now) => {
    if (panel._ha3dObjectZoomToken !== token || panel._editorMode) {
      if (panel._ha3dObjectZoomToken === token) {
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

function inspect(panel, object, strong = false) {
  if (!object || panel._editorMode) return;
  panel._ha3dObjectInspection = object;
  panel._ha3dInspectorObject = object;
  panel._ha3dInspectorAnchorKey = objectKey(object);
  applyInspection(panel, object);
  zoomTo(panel, object, strong);
  panel._setStatus?.(`${strong ? "Aproximado" : "Selecionado"}: ${objectKey(object) || "objeto"}`);
}

if (!proto.__ha3dObjectInspectionV1) {
  proto.__ha3dObjectInspectionV1 = true;

  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._robotCalibrationMarker) return;
    if (this._editorMode) return oldPick?.call(this, event);
    if (performance.now() < (this._ha3dSuppressTapUntil || 0)) return;

    const object = this._pickObject?.(event);
    if (!object) {
      clearInspection(this);
      return;
    }

    // One click selects/highlights and makes a short approach. The second click
    // of a double-click keeps the same selection and moves the camera closer.
    inspect(this, object, Number(event?.detail || 0) >= 2);
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const entering = !this._editorMode;
    if (entering) clearInspection(this);
    const result = oldToggleEditor?.apply(this, args);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    clearInspection(this);
    return oldLoadModel?.apply(this, args);
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    clearInspection(this);
    return oldDisconnected?.apply(this, args);
  };
}
