// Replace the Vistas text button with a compact gear icon.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

function applyViewsIcon(panel) {
  const button = panel?.shadowRoot?.querySelector("#viewsButton");
  if (!button) return false;
  button.textContent = "⚙️";
  button.title = "Vistas";
  button.setAttribute("aria-label", "Vistas");
  return true;
}

function collectHa3dPanels(root, found = new Set()) {
  if (!root?.querySelectorAll) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "ha3d-lab-panel") found.add(element);
    if (element.shadowRoot) collectHa3dPanels(element.shadowRoot, found);
  }
  return found;
}

function applyToExistingPanels() {
  for (const panel of collectHa3dPanels(document)) applyViewsIcon(panel);
}

const proto = Panel.prototype;
if (!proto.__ha3dViewsIconV2) {
  proto.__ha3dViewsIconV2 = true;

  // Future instances: apply immediately after the panel creates its shell.
  const originalRenderShell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = originalRenderShell?.apply(this, args);
    applyViewsIcon(this);
    return result;
  };

  // Existing instance: Home Assistant nests panels inside open shadow roots,
  // so document.querySelectorAll("ha3d-lab-panel") alone is not sufficient.
  queueMicrotask(applyToExistingPanels);
  requestAnimationFrame(applyToExistingPanels);
  setTimeout(applyToExistingPanels, 250);
  setTimeout(applyToExistingPanels, 1000);
}
