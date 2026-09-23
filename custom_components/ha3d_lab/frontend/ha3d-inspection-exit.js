const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const EXIT_DELAY_MS = 230;

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function sameObject(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ak = objectKey(a);
  const bk = objectKey(b);
  return Boolean(ak && bk && ak === bk);
}

function captureReturnView(panel) {
  if (panel._ha3dInspectionReturnView || !panel._camera || !panel._controls) return;
  panel._ha3dInspectionReturnView = {
    position: panel._camera.position.clone(),
    target: panel._controls.target.clone(),
  };
}

function cancelExitTimer(panel) {
  if (panel._ha3dInspectionExitTimer) clearTimeout(panel._ha3dInspectionExitTimer);
  panel._ha3dInspectionExitTimer = 0;
}

function animateReturn(panel) {
  const view = panel._ha3dInspectionReturnView;
  panel._ha3dInspectionReturnView = null;
  if (!view || !panel._camera || !panel._controls || panel._editorMode) return;

  panel._ha3dObjectZoomToken = (panel._ha3dObjectZoomToken || 0) + 1;
  const startPos = panel._camera.position.clone();
  const startTarget = panel._controls.target.clone();
  const oldEnabled = panel._controls.enabled;
  panel._controls.enabled = false;
  panel._cameraAnimating = true;
  const started = performance.now();
  const duration = 420;
  const token = (panel._ha3dInspectionReturnToken || 0) + 1;
  panel._ha3dInspectionReturnToken = token;

  const ease = (t) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  };

  const frame = (now) => {
    if (panel._ha3dInspectionReturnToken !== token || panel._editorMode) {
      if (panel._ha3dInspectionReturnToken === token) {
        panel._controls.enabled = oldEnabled;
        panel._cameraAnimating = false;
      }
      return;
    }
    const t = ease((now - started) / duration);
    panel._camera.position.lerpVectors(startPos, view.position, t);
    panel._controls.target.lerpVectors(startTarget, view.target, t);
    panel._camera.lookAt(panel._controls.target);
    if (t < 1) requestAnimationFrame(frame);
    else {
      panel._controls.enabled = oldEnabled;
      panel._cameraAnimating = false;
      panel._controls.update?.();
    }
  };
  requestAnimationFrame(frame);
}

function clearThroughInspection(panel, oldPick, event) {
  cancelExitTimer(panel);
  const own = Object.prototype.hasOwnProperty.call(panel, "_pickObject");
  const original = panel._pickObject;
  try {
    panel._pickObject = () => null;
    oldPick?.call(panel, event || { detail: 1 });
  } finally {
    if (own) panel._pickObject = original;
    else delete panel._pickObject;
  }
  animateReturn(panel);
  panel._setStatus?.("Seleção encerrada");
}

if (!proto.__ha3dInspectionExitV1) {
  proto.__ha3dInspectionExitV1 = true;

  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._editorMode || this._robotCalibrationMarker) return oldPick?.call(this, event);
    if (performance.now() < (this._ha3dSuppressTapUntil || 0)) return;

    const object = this._pickObject?.(event);
    const selected = this._ha3dObjectInspection || this._ha3dInspectorObject;
    const detail = Number(event?.detail || 0);

    // A true empty hit exits immediately. In most apartment models the floor
    // occupies nearly the entire viewport, so same-object single click is the
    // dependable touch-friendly exit gesture.
    if (!object) {
      if (selected) clearThroughInspection(this, oldPick, event);
      else oldPick?.call(this, event);
      return;
    }

    if (detail >= 2) {
      cancelExitTimer(this);
      if (!selected) captureReturnView(this);
      return oldPick?.call(this, event);
    }

    if (selected && sameObject(object, selected)) {
      cancelExitTimer(this);
      this._ha3dInspectionExitTimer = setTimeout(() => {
        this._ha3dInspectionExitTimer = 0;
        if (!this._editorMode && (this._ha3dObjectInspection || this._ha3dInspectorObject)) {
          clearThroughInspection(this, oldPick, event);
        }
      }, EXIT_DELAY_MS);
      return;
    }

    cancelExitTimer(this);
    if (!selected) captureReturnView(this);
    return oldPick?.call(this, event);
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    if (!this._ha3dInspectionExitKeyHandler) {
      this._ha3dInspectionExitKeyHandler = (event) => {
        if (event.key !== "Escape" || this._editorMode || !(this._ha3dObjectInspection || this._ha3dInspectorObject)) return;
        clearThroughInspection(this, oldPick, { detail: 1 });
      };
      window.addEventListener("keydown", this._ha3dInspectionExitKeyHandler);
    }
    return result;
  };

  const oldToggleEditor = proto._toggleEditor;
  proto._toggleEditor = function (...args) {
    cancelExitTimer(this);
    this._ha3dInspectionReturnView = null;
    this._ha3dInspectionReturnToken = (this._ha3dInspectionReturnToken || 0) + 1;
    return oldToggleEditor?.apply(this, args);
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    cancelExitTimer(this);
    this._ha3dInspectionReturnView = null;
    return oldLoadModel?.apply(this, args);
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    cancelExitTimer(this);
    if (this._ha3dInspectionExitKeyHandler) {
      window.removeEventListener("keydown", this._ha3dInspectionExitKeyHandler);
      this._ha3dInspectionExitKeyHandler = null;
    }
    this._ha3dInspectionReturnView = null;
    return oldDisconnected?.apply(this, args);
  };
}
