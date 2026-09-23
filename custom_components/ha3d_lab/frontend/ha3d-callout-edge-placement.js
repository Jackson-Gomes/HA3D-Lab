import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function objectBounds(object) {
  try {
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) return box;
  } catch (_error) {}
  const point = new THREE.Vector3();
  object?.getWorldPosition?.(point);
  return new THREE.Box3(point.clone(), point.clone());
}

function placementState(panel) {
  if (!panel._ha3dCalloutEdgePlacement) {
    panel._ha3dCalloutEdgePlacement = {
      blue: { entity: null, band: null, gap: 100, lateral: 0 },
      red: { entity: null, band: null, gap: 112, lateral: 0 },
      raf: 0,
    };
  }
  return panel._ha3dCalloutEdgePlacement;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function refreshPlacement(track, entity, y, height, cardHeight, isAlert) {
  if (track.entity === entity && track.band) return;

  track.entity = entity;
  const preferred = y <= height * 0.5 ? "top" : "bottom";
  const topRoom = y - cardHeight - 24;
  const bottomRoom = height - y - cardHeight - 24;

  let band = preferred;
  if (preferred === "top" && topRoom < 48 && bottomRoom > topRoom) band = "bottom";
  if (preferred === "bottom" && bottomRoom < 48 && topRoom > bottomRoom) band = "top";

  track.band = band;
  track.gap = isAlert ? randomBetween(112, 168) : randomBetween(92, 145);
  track.lateral = randomBetween(-18, 18);
}

function overlapsRect(a, b, margin = 0) {
  return !(
    a.right + margin <= b.left ||
    a.left >= b.right + margin ||
    a.bottom + margin <= b.top ||
    a.top >= b.bottom + margin
  );
}

function reserveAmbientStatus(panel, track, cardX, cardY, cardWidth, cardHeight, layerRect, height) {
  if (track.band !== "bottom") return { cardX, cardY };
  const status = panel.shadowRoot?.querySelector("#ha3dAmbientStatus");
  if (!status) return { cardX, cardY };

  const statusRectRaw = status.getBoundingClientRect?.();
  if (!statusRectRaw?.width || !statusRectRaw?.height) return { cardX, cardY };

  const statusRect = {
    left: statusRectRaw.left - layerRect.left,
    right: statusRectRaw.right - layerRect.left,
    top: statusRectRaw.top - layerRect.top,
    bottom: statusRectRaw.bottom - layerRect.top,
  };
  const predicted = {
    left: cardX,
    right: cardX + cardWidth,
    top: cardY,
    bottom: cardY + cardHeight,
  };

  if (!overlapsRect(predicted, statusRect, 20)) return { cardX, cardY };

  const leftSlot = statusRect.left - cardWidth - 26;
  if (leftSlot >= 14) {
    return { cardX: Math.min(cardX, leftSlot), cardY };
  }

  // Very narrow viewport: protect the clock/weather block and move the callout upward.
  track.band = "top";
  return {
    cardX,
    cardY: Math.max(18, Math.min(height * 0.26 - cardHeight * 0.55, height - cardHeight - 18)),
  };
}

function layoutCallout(panel, options) {
  const {
    entity,
    object,
    card,
    leader,
    track,
    isAlert = false,
  } = options;

  if (!entity || !object || !card || !leader || !panel._camera || !panel._renderer) {
    track.entity = null;
    track.band = null;
    return;
  }

  const poly = leader.querySelector("polyline");
  const dot = leader.querySelector("circle");
  if (!poly || !dot) return;

  const box = objectBounds(object);
  const point = box.getCenter(new THREE.Vector3());
  point.y = Math.max(point.y, box.max.y);
  point.project(panel._camera);

  if (point.z < -1 || point.z > 1) return;

  const canvasRect = panel._renderer.domElement.getBoundingClientRect();
  const layerRect = card.parentElement?.getBoundingClientRect?.() || canvasRect;
  const width = layerRect.width || canvasRect.width;
  const height = layerRect.height || canvasRect.height;
  if (!width || !height) return;

  const x = (point.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left - layerRect.left;
  const y = (-point.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top - layerRect.top;
  const cardWidth = Math.min(card.offsetWidth || (isAlert ? 270 : 250), width * 0.58);
  const cardHeight = Math.max(card.offsetHeight || 118, 118);

  refreshPlacement(track, entity, y, height, cardHeight, isAlert);

  let goRight = x <= width * 0.5;
  const horizontalGap = (isAlert ? 84 : 76) + track.lateral;
  const fitsRight = x + horizontalGap + cardWidth <= width - 14;
  const fitsLeft = x - horizontalGap - cardWidth >= 14;
  if (goRight && !fitsRight && fitsLeft) goRight = false;
  if (!goRight && !fitsLeft && fitsRight) goRight = true;

  let cardX = goRight
    ? x + horizontalGap
    : x - cardWidth - horizontalGap;

  const topZoneCeiling = height * (isAlert ? 0.27 : 0.29);
  const bottomZoneFloor = height * (isAlert ? 0.69 : 0.67);
  let cardY;

  if (track.band === "top") {
    const desired = y - cardHeight - track.gap;
    const zoneTarget = topZoneCeiling - cardHeight * 0.55;
    cardY = Math.min(desired, zoneTarget);
  } else {
    const desired = y + track.gap;
    cardY = Math.max(desired, bottomZoneFloor);
  }

  cardX = Math.max(14, Math.min(width - cardWidth - 14, cardX));
  cardY = Math.max(18, Math.min(height - cardHeight - 18, cardY));

  const reserved = reserveAmbientStatus(panel, track, cardX, cardY, cardWidth, cardHeight, layerRect, height);
  cardX = Math.max(14, Math.min(width - cardWidth - 14, reserved.cardX));
  cardY = Math.max(18, Math.min(height - cardHeight - 18, reserved.cardY));

  card.style.left = `${cardX}px`;
  card.style.top = `${cardY}px`;

  const edgeX = goRight ? cardX : cardX + cardWidth;
  const edgeY = track.band === "top"
    ? cardY + cardHeight - 20
    : cardY + 20;
  const bendX = goRight
    ? Math.min(edgeX - 18, x + 42)
    : Math.max(edgeX + 18, x - 42);
  const middleY = y + (edgeY - y) * 0.28;

  poly.setAttribute(
    "points",
    `${x.toFixed(1)},${y.toFixed(1)} ${bendX.toFixed(1)},${middleY.toFixed(1)} ${edgeX.toFixed(1)},${edgeY.toFixed(1)}`
  );
  dot.setAttribute("cx", x.toFixed(1));
  dot.setAttribute("cy", y.toFixed(1));
}

function frame(panel) {
  const st = placementState(panel);
  if (!panel.isConnected) {
    st.raf = 0;
    return;
  }

  if (isXrayActive(panel)) {
    const blue = panel._ha3dLiveTelemetry;
    const blueCard = panel.shadowRoot?.querySelector("#ha3dTelemetryCard");
    const blueLeader = panel.shadowRoot?.querySelector("#ha3dTelemetryLeader");
    if (blue?.calloutEntity && blue?.targetObject && blueCard?.classList.contains("visible")) {
      layoutCallout(panel, {
        entity: blue.calloutEntity,
        object: blue.targetObject,
        card: blueCard,
        leader: blueLeader,
        track: st.blue,
      });
    } else {
      st.blue.entity = null;
      st.blue.band = null;
    }

    const organic = panel._ha3dOrganicTelemetry;
    const redCard = panel.shadowRoot?.querySelector("#ha3dOrganicAlertCard");
    const redLeader = panel.shadowRoot?.querySelector("#ha3dOrganicAlertLeader");
    const redEntity = organic?.currentEntity;
    const redObject = redEntity ? panel._objectsByEntity?.get?.(redEntity)?.[0] : null;
    if (redEntity && redObject && redCard?.classList.contains("visible")) {
      layoutCallout(panel, {
        entity: redEntity,
        object: redObject,
        card: redCard,
        leader: redLeader,
        track: st.red,
        isAlert: true,
      });
    } else {
      st.red.entity = null;
      st.red.band = null;
    }
  }

  st.raf = requestAnimationFrame(() => frame(panel));
}

function install(panel) {
  if (!panel?.shadowRoot) return;
  const st = placementState(panel);
  if (!st.raf) st.raf = requestAnimationFrame(() => frame(panel));
}

function cleanup(panel) {
  const st = placementState(panel);
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

if (!proto.__ha3dCalloutEdgePlacementV1) {
  proto.__ha3dCalloutEdgePlacementV1 = true;

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
