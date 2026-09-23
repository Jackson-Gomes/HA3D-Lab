const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function installTouchGuard(panel) {
  const root = panel?.shadowRoot;
  if (!root || root.querySelector("#ha3dTouchGuardStyle")) return;

  const style = document.createElement("style");
  style.id = "ha3dTouchGuardStyle";
  style.textContent = `
    :host, #root, #stage, canvas, #markers, #topbar, #meta, .glass, button, label, summary,
    .ha3dFloatCard, .ha3dHint, .ha3dRow, .ha3dEditorHead, .ha3dEditorActions {
      -webkit-user-select:none!important;
      user-select:none!important;
      -webkit-touch-callout:none!important;
    }
    input, textarea, select, [contenteditable="true"], [contenteditable=""] {
      -webkit-user-select:text!important;
      user-select:text!important;
      -webkit-touch-callout:default!important;
    }
  `;
  root.appendChild(style);

  const preventSelection = (event) => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  };

  root.addEventListener("selectstart", preventSelection, true);
  root.addEventListener("contextmenu", preventSelection, true);
  panel._ha3dTouchGuardCleanup = () => {
    root.removeEventListener("selectstart", preventSelection, true);
    root.removeEventListener("contextmenu", preventSelection, true);
  };
}

if (!proto.__ha3dIpadTouchGuardV1) {
  proto.__ha3dIpadTouchGuardV1 = true;

  const oldRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = oldRenderShell?.apply(this, args);
    installTouchGuard(this);
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    queueMicrotask(() => installTouchGuard(this));
    return result;
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    this._ha3dTouchGuardCleanup?.();
    this._ha3dTouchGuardCleanup = null;
    return oldDisconnected?.apply(this, args);
  };
}
