const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function ensureTransformHelper(panel) {
  const controls = panel?._transformControls;
  const scene = panel?._scene;
  if (!controls || !scene) return null;

  const helper = controls.getHelper?.() || controls;
  if (helper?.isObject3D && helper.parent !== scene) scene.add(helper);
  if (helper?.isObject3D) helper.visible = Boolean(panel._editorMode && panel._selectedObject);
  return helper;
}

function currentMode(panel) {
  return panel?._transformControls?.getMode?.() || panel?._transformControls?.mode || "translate";
}

if (!proto.__ha3dEditorDragHotfixV1) {
  proto.__ha3dEditorDragHotfixV1 = true;

  const oldInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    const result = oldInitViewer?.apply(this, args);
    queueMicrotask(() => ensureTransformHelper(this));
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    queueMicrotask(() => ensureTransformHelper(this));
    return result;
  };

  const oldSelectForEditor = proto._selectForEditor;
  proto._selectForEditor = function (object) {
    const result = oldSelectForEditor?.call(this, object);
    const helper = ensureTransformHelper(this);
    if (object && this._transformControls) {
      this._transformControls.attach?.(object);
      this._transformControls.enabled = true;
      this._transformControls.visible = true;
      if (helper?.isObject3D) helper.visible = true;
    }
    return result;
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    const result = oldToggleEditor?.apply(this, args);
    const helper = ensureTransformHelper(this);
    if (!this._editorMode) {
      this._transformControls?.detach?.();
      if (this._transformControls) {
        this._transformControls.enabled = false;
        this._transformControls.visible = false;
      }
      if (helper?.isObject3D) helper.visible = false;
      if (this._controls) this._controls.enabled = true;
    }
    return result;
  };

  const oldBeginObjectDrag = proto._beginObjectDrag;
  proto._beginObjectDrag = function (event, object) {
    if (!object || !this._editorMode) return;

    const orbitWasEnabled = this._controls?.enabled !== false;
    if (this._controls) this._controls.enabled = false;
    this._ha3dEditorDirectDrag = true;

    const restore = () => {
      window.removeEventListener("pointerup", restore, true);
      window.removeEventListener("pointercancel", restore, true);
      this._ha3dEditorDirectDrag = false;
      if (this._controls && !this._transformControls?.dragging) {
        this._controls.enabled = orbitWasEnabled;
      }
    };

    window.addEventListener("pointerup", restore, true);
    window.addEventListener("pointercancel", restore, true);

    return oldBeginObjectDrag?.call(this, event, object);
  };

  const oldWireUi = proto._wireUi;
  proto._wireUi = function (...args) {
    const result = oldWireUi?.apply(this, args);
    const canvas = this._renderer?.domElement;
    if (!canvas || canvas.__ha3dEditorDirectDragV1) return result;
    canvas.__ha3dEditorDirectDragV1 = true;

    canvas.addEventListener("pointerdown", (event) => {
      if (!this._editorMode || event.button !== 0 || this._robotCalibrationMarker) return;

      // If the TransformControls gizmo has captured an axis, let it own the drag.
      // This preserves rotate/scale and axis-constrained translate behavior.
      if (this._transformControls?.axis) return;
      if (currentMode(this) !== "translate") return;

      const object = this._pickObject?.(event);
      if (!object) return;

      this._selectForEditor?.(object);
      this._beginObjectDrag?.(event, object);
      event.preventDefault();
    });

    return result;
  };

  queueMicrotask(() => {
    const walk = (root) => {
      if (!root?.querySelectorAll) return;
      for (const el of root.querySelectorAll("*")) {
        if (el.localName === "ha3d-lab-panel") ensureTransformHelper(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
  });
}
