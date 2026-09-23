import "./ha3d-cinematic.js";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function installCinematicOffGuard(panel) {
  const toggle = panel.shadowRoot?.querySelector("#cinematicToggle");
  const testButton = panel.shadowRoot?.querySelector("#cinematicTest");
  if (!toggle || toggle.__ha3dCinematicOffGuardV1) return;
  toggle.__ha3dCinematicOffGuardV1 = true;

  const syncGuard = () => {
    const enabled = Boolean(toggle.checked);
    if (testButton) testButton.disabled = !enabled;
    if (enabled) return;

    clearTimeout(panel._cinematicBatchTimer);
    clearTimeout(panel._cinematicDrainTimer);
    panel._cinematicPending?.clear?.();
    if (Array.isArray(panel._cinematicQueue)) panel._cinematicQueue.length = 0;

    if (panel._cinematicActive || panel._cameraAnimating) {
      panel._cinematicActive = false;
      panel._cameraAnimating = false;
      if (panel._controls) {
        panel._controls.enabled = true;
        panel._controls.enableDamping = true;
        panel._controls.update();
      }
      panel._restoreCinematicUi?.();
      requestAnimationFrame(() => panel._applyCameraView?.("default"));
    } else {
      panel._restoreCinematicUi?.();
    }
  };

  toggle.addEventListener("change", syncGuard);
  if (testButton) {
    testButton.addEventListener(
      "click",
      (event) => {
        if (toggle.checked) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }

  syncGuard();
}

if (!proto.__ha3dCinematicUiLateInstall) {
  proto.__ha3dCinematicUiLateInstall = true;

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: true,
      enumerable: hassDescriptor.enumerable,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        queueMicrotask(() => {
          this._installCinematicControls?.();
          installCinematicOffGuard(this);
        });
      },
    });
  }

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    originalConnectedCallback.call(this);
    queueMicrotask(() => {
      this._installCinematicControls?.();
      installCinematicOffGuard(this);
    });
  };
}
