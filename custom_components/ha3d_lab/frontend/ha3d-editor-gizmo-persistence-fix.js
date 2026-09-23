const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const GIZMO_SIZE = 1.25;
const GIZMO_CLICK_GUARD_MS = 220;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function numericTransform(object) {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

function configureGizmo(panel) {
  const controls = panel?._transformControls;
  if (!controls) return;

  if (typeof controls.setSize === "function") controls.setSize(GIZMO_SIZE);
  else controls.size = GIZMO_SIZE;

  if (controls.userData?.ha3dGizmoPersistenceFixV1) return;
  controls.userData ||= {};
  controls.userData.ha3dGizmoPersistenceFixV1 = true;

  const guard = (extra = GIZMO_CLICK_GUARD_MS) => {
    panel._ha3dSuppressModelPickUntil = nowMs() + extra;
  };

  controls.addEventListener("mouseDown", () => {
    panel._ha3dGizmoPointerActive = true;
    guard();
  });

  controls.addEventListener("dragging-changed", (event) => {
    panel._ha3dGizmoPointerActive = Boolean(event.value);
    if (event.value) guard();
  });

  controls.addEventListener("mouseUp", () => {
    panel._ha3dGizmoPointerActive = false;
    guard();
  });
}

function gizmoOwnsPointer(panel) {
  if (!panel?._editorMode) return false;
  const controls = panel._transformControls;
  return Boolean(
    panel._ha3dGizmoPointerActive
    || controls?.dragging
    || nowMs() < (panel._ha3dSuppressModelPickUntil || 0)
  );
}

if (!proto.__ha3dEditorGizmoPersistenceFixV1) {
  proto.__ha3dEditorGizmoPersistenceFixV1 = true;

  const oldInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    const result = oldInitViewer?.apply(this, args);
    queueMicrotask(() => configureGizmo(this));
    return result;
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (...args) {
    const result = oldSelectForEditor?.apply(this, args);
    configureGizmo(this);
    return result;
  };

  const oldPick = proto._pick;
  proto._pick = function (event) {
    // Suppress only a real TransformControls click/drag and its immediate
    // trailing canvas click. Merely hovering an axis must never block model picking.
    if (gizmoOwnsPointer(this)) return;
    return oldPick?.call(this, event);
  };

  const oldPickObject = proto._pickObject;
  proto._pickObject = function (event) {
    if (gizmoOwnsPointer(this)) return null;
    return oldPickObject?.call(this, event) || null;
  };

  const oldPersistSelectedTransform = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    const object = this._selectedObject;
    const key = objectKey(object);
    if (!object || !key || !this._saveConfigPatch) {
      return oldPersistSelectedTransform?.apply(this, args);
    }

    const positions = {
      ...(this._config?.object_positions || {}),
      [key]: numericTransform(object),
    };

    try {
      await this._saveConfigPatch({ object_positions: positions });
      if (!this._config?.object_positions?.[key]) {
        throw new Error("Home Assistant não confirmou object_positions");
      }
      this._setStatus?.(`Posição salva: ${key}`);
    } catch (error) {
      console.error("[HA3D] failed to persist object transform", key, error);
      this._setStatus?.(`Erro ao salvar posição: ${error.message || error}`);
    }
  };
}
