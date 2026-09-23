import "./ha3d-cinematic.js";

const CINEMATIC_KEY = "ha3d_lab_cinematic_enabled_v1";
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function rememberCamera(panel) {
  if (!panel._camera || !panel._controls) return;
  panel._ha3dCinematicRestoreV2 = {
    position: panel._camera.position.clone(),
    target: panel._controls.target.clone(),
    up: panel._camera.up.clone(),
    controlsEnabled: panel._controls.enabled,
    dampingEnabled: panel._controls.enableDamping,
  };
}

function cancelCinematic(panel) {
  clearTimeout(panel._cinematicBatchTimer);
  clearTimeout(panel._cinematicDrainTimer);
  panel._cinematicPending?.clear?.();
  if (Array.isArray(panel._cinematicQueue)) panel._cinematicQueue.length = 0;

  const wasCinematicActive = Boolean(panel._cinematicActive);
  panel._cinematicActive = false;

  if (wasCinematicActive) {
    panel._cameraAnimating = false;
    const restore = panel._ha3dCinematicRestoreV2;
    if (restore && panel._camera && panel._controls) {
      panel._camera.position.copy(restore.position);
      panel._controls.target.copy(restore.target);
      panel._camera.up.copy(restore.up);
      panel._camera.lookAt(panel._controls.target);
      panel._controls.enabled = restore.controlsEnabled;
      panel._controls.enableDamping = restore.dampingEnabled;
      panel._controls.update();
    }
  }

  panel._ha3dCinematicRestoreV2 = null;
  panel._restoreCinematicUi?.();
}

function installToggleGuard(panel) {
  const toggle = panel.shadowRoot?.querySelector("#cinematicToggle");
  const testButton = panel.shadowRoot?.querySelector("#cinematicTest");
  if (!toggle || toggle.__ha3dCinematicOffV2) return;
  toggle.__ha3dCinematicOffV2 = true;

  // Startup is read-only: persisted preference is the source of truth.
// Never write the checkbox's transient initial state back to storage here,
// because the control can exist for a frame before its checked state is synced.
const stored = localStorage.getItem(CINEMATIC_KEY);
const initialEnabled = stored === "0"
  ? false
  : stored === "1"
    ? true
    : (typeof panel._cinematicEnabled === "boolean" ? panel._cinematicEnabled : true);
panel._cinematicEnabled = initialEnabled;
toggle.checked = initialEnabled;
if (testButton) testButton.disabled = !initialEnabled;

const persistToggle = (event) => {
  const enabled = Boolean(toggle.checked);
  panel._cinematicEnabled = enabled;
  localStorage.setItem(CINEMATIC_KEY, enabled ? "1" : "0");
  if (testButton) testButton.disabled = !enabled;

  if (!enabled) cancelCinematic(panel);

  // Own the toggle event so the older guard cannot cancel unrelated camera
  // animations or force the default view after Cinematic is turned off.
  event.stopImmediatePropagation();
};

toggle.addEventListener("change", persistToggle, true);

if (testButton) {
  testButton.addEventListener(
    "click",
    (event) => {
      if (panel._cinematicEnabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}
}

if (!proto.__ha3dCinematicOffV2) {
  proto.__ha3dCinematicOffV2 = true;

  const originalInstallControls = proto._installCinematicControls;
  proto._installCinematicControls = function (...args) {
    const result = originalInstallControls?.apply(this, args);
    installToggleGuard(this);
    return result;
  };

  const originalQueue = proto._queueCinematicFocus;
  proto._queueCinematicFocus = function (...args) {
    if (!this._cinematicEnabled) return;
    return originalQueue?.apply(this, args);
  };

  const originalEnqueue = proto._enqueueCinematicBatch;
  proto._enqueueCinematicBatch = function (...args) {
    if (!this._cinematicEnabled) return;
    return originalEnqueue?.apply(this, args);
  };

  const originalDrain = proto._scheduleCinematicDrain;
  proto._scheduleCinematicDrain = function (...args) {
    if (!this._cinematicEnabled) {
      clearTimeout(this._cinematicDrainTimer);
      if (Array.isArray(this._cinematicQueue)) this._cinematicQueue.length = 0;
      this._restoreCinematicUi?.();
      return;
    }
    return originalDrain?.apply(this, args);
  };

  const originalRun = proto._runCinematicFocus;
  proto._runCinematicFocus = function (...args) {
    if (!this._cinematicEnabled) return;
    if (!this._cinematicActive && !this._cameraAnimating) rememberCamera(this);
    return originalRun?.apply(this, args);
  };

  const originalDisconnectedCallback = proto.disconnectedCallback;
  proto.disconnectedCallback = function () {
    cancelCinematic(this);
    originalDisconnectedCallback?.call(this);
  };

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    originalConnectedCallback?.call(this);
    queueMicrotask(() => {
      this._installCinematicControls?.();
      installToggleGuard(this);
    });
  };
}
