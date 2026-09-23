const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function lockState(panel) {
  if (!panel._ha3dCalloutLaneLock) {
    panel._ha3dCalloutLaneLock = { raf: 0 };
  }
  return panel._ha3dCalloutLaneLock;
}

function visibleCard(card) {
  if (!card?.classList?.contains("visible")) return false;
  const rect = card.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return !(
    a.right <= b.left + 4 ||
    a.left >= b.right - 4 ||
    a.bottom <= b.top + 4 ||
    a.top >= b.bottom - 4
  );
}

function enforceLaneLock(panel) {
  const placement = panel._ha3dCalloutEdgePlacement;
  if (!placement) return;

  const blueCard = panel.shadowRoot?.querySelector("#ha3dTelemetryCard");
  const redCard = panel.shadowRoot?.querySelector("#ha3dOrganicAlertCard");
  if (!visibleCard(blueCard) || !visibleCard(redCard)) return;

  const blue = placement.blue;
  const red = placement.red;
  if (!blue?.band || !red?.band) return;

  // Red anomaly callouts have priority. Blue telemetry moves to the opposite lane.
  if (blue.band === red.band) {
    blue.band = red.band === "top" ? "bottom" : "top";
    blue.gap = Math.max(Number(blue.gap) || 0, 122);
    return;
  }

  // On short screens, opposite lanes can still touch. Push blue farther outward.
  const blueRect = blueCard.getBoundingClientRect();
  const redRect = redCard.getBoundingClientRect();
  if (overlaps(blueRect, redRect)) {
    blue.gap = Math.min(190, Math.max(Number(blue.gap) || 0, 132) + 12);
  }
}

function frame(panel) {
  const st = lockState(panel);
  if (!panel.isConnected) {
    st.raf = 0;
    return;
  }

  if (isXrayActive(panel)) enforceLaneLock(panel);
  st.raf = requestAnimationFrame(() => frame(panel));
}

function install(panel) {
  if (!panel?.shadowRoot) return;
  const st = lockState(panel);
  if (!st.raf) st.raf = requestAnimationFrame(() => frame(panel));
}

function cleanup(panel) {
  const st = lockState(panel);
  if (st.raf) cancelAnimationFrame(st.raf);
  st.raf = 0;
}

function collectPanels(root, found = new Set()) {
  if (!root?.querySelectorAll) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "ha3d-lab-panel") found.add(element);
    if (element.shadowRoot) collectPanels(element.shadowRoot, found);
  }
  return found;
}

function installOnExistingPanels() {
  for (const panel of collectPanels(document)) install(panel);
}

if (!proto.__ha3dCalloutLaneLockV1) {
  proto.__ha3dCalloutLaneLockV1 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => install(this));
    return result;
  };

  const originalDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    cleanup(this);
    return originalDisconnected?.apply(this, args);
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await originalLoadModel?.apply(this, args);
    queueMicrotask(() => install(this));
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
