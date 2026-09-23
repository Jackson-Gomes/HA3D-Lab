import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const GLOBAL_COOLDOWN_MS = 55000;
const ENTITY_COOLDOWN_MS = 150000;
const MOVE_IN_MS = 1350;
const HOLD_MS = 1900;
const MOVE_OUT_MS = 1450;
const ORBIT_SPEED = 0.000025;

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function focusState(panel) {
  if (!panel._ha3dAiInspectionFocus) {
    panel._ha3dAiInspectionFocus = {
      active: false,
      pendingEntity: null,
      dueAt: 0,
      lastFocusAt: 0,
      perEntity: new Map(),
      knownAnomalies: new Set(),
      lastEvaluate: 0,
      lastUserActivity: 0,
      raf: 0,
      cameraRaf: 0,
      installedActivity: false,
    };
  }
  return panel._ha3dAiInspectionFocus;
}

function objectBounds(object) {
  try {
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) return box;
  } catch (_error) {}
  const p = new THREE.Vector3();
  object?.getWorldPosition?.(p);
  return new THREE.Box3(p.clone(), p.clone());
}

function ease(t) {
  return t * t * (3 - 2 * t);
}

function animateCamera(panel, fromPos, toPos, fromTarget, toTarget, duration) {
  return new Promise((resolve) => {
    const st = focusState(panel);
    const start = performance.now();
    const frame = (now) => {
      if (!st.active || !panel.isConnected || !isXrayActive(panel)) {
        st.cameraRaf = 0;
        resolve(false);
        return;
      }
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      const k = ease(t);
      panel._camera.position.lerpVectors(fromPos, toPos, k);
      panel._controls.target.lerpVectors(fromTarget, toTarget, k);
      panel._camera.up.set(0, 1, 0);
      panel._camera.lookAt(panel._controls.target);
      if (t < 1) st.cameraRaf = requestAnimationFrame(frame);
      else {
        st.cameraRaf = 0;
        resolve(true);
      }
    };
    st.cameraRaf = requestAnimationFrame(frame);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resumeIdleOrbit(panel) {
  if (!panel._ha3dIdleActive || !isXrayActive(panel) || !panel._ha3dIdleOrbit) return;
  const orbit = panel._ha3dIdleOrbit;
  orbit.last = performance.now();
  orbit.angle = Math.atan2(
    panel._camera.position.z - orbit.center.z,
    panel._camera.position.x - orbit.center.x,
  );

  const frame = (now) => {
    const st = focusState(panel);
    if (!panel._ha3dIdleActive || !isXrayActive(panel) || st.active) {
      panel._ha3dIdleRaf = 0;
      return;
    }
    const delta = Math.min(80, Math.max(0, now - (orbit.last || now)));
    orbit.last = now;
    orbit.angle += delta * ORBIT_SPEED;
    panel._camera.position.set(
      orbit.center.x + Math.cos(orbit.angle) * orbit.radius,
      orbit.center.y + orbit.height,
      orbit.center.z + Math.sin(orbit.angle) * orbit.radius,
    );
    panel._controls.target.copy(orbit.center);
    panel._camera.up.set(0, 1, 0);
    panel._camera.lookAt(orbit.center);
    panel._ha3dIdleRaf = requestAnimationFrame(frame);
  };

  panel._ha3dIdleRaf = requestAnimationFrame(frame);
}

function blueCalloutBusy(panel) {
  const blue = panel.shadowRoot?.querySelector("#ha3dTelemetryCard");
  return Boolean(blue?.classList.contains("visible"));
}

function redCalloutBusy(panel) {
  return Boolean(panel._ha3dOrganicTelemetry?.currentEntity);
}

function schedule(panel, entity, delayMs) {
  const st = focusState(panel);
  if (st.active || st.pendingEntity) return;
  st.pendingEntity = entity;
  st.dueAt = Date.now() + delayMs;

  // Let the camera inspect first; the existing red callout is released on arrival.
  const organic = panel._ha3dOrganicTelemetry;
  if (organic?.dueAt?.set) organic.dueAt.set(entity, st.dueAt + MOVE_IN_MS + 250);
}

function refreshCandidates(panel) {
  const st = focusState(panel);
  const anomalies = panel._ha3dOrganicTelemetry?.anomalies;
  if (!(anomalies instanceof Map)) return;

  const current = new Set(anomalies.keys());
  const now = Date.now();
  const globallyReady = now - st.lastFocusAt >= GLOBAL_COOLDOWN_MS;

  if (!st.active && !st.pendingEntity && globallyReady && isXrayActive(panel)) {
    for (const entity of current) {
      if (st.knownAnomalies.has(entity)) continue;
      if (now - (st.perEntity.get(entity) || 0) < ENTITY_COOLDOWN_MS) continue;
      if (Math.random() < 0.55) {
        schedule(panel, entity, 3800 + Math.random() * 5200);
        break;
      }
    }
  }

  st.knownAnomalies = current;
}

async function startFocus(panel, entity) {
  const st = focusState(panel);
  if (panel._ha3dAiExplorationActive) return false;
  const object = panel._objectsByEntity?.get?.(entity)?.[0];
  const organic = panel._ha3dOrganicTelemetry;
  if (!object || !(organic?.anomalies instanceof Map) || !organic.anomalies.has(entity)) return false;
  if (!isXrayActive(panel) || st.active) return false;
  if (performance.now() - st.lastUserActivity < 4500) return false;
  if (blueCalloutBusy(panel) || redCalloutBusy(panel)) return false;

  st.active = true;
  panel._ha3dAiFocusActive = true;

  if (panel._ha3dIdleRaf) cancelAnimationFrame(panel._ha3dIdleRaf);
  panel._ha3dIdleRaf = 0;

  const savedPos = panel._camera.position.clone();
  const savedTarget = panel._controls.target.clone();
  const box = objectBounds(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.12) * 0.5;

  let dir = savedPos.clone().sub(center);
  let distance = dir.length();
  if (distance < 0.001) {
    dir.set(1, 0.65, 1).normalize();
    distance = 2;
  } else dir.normalize();

  const focusDistance = Math.min(distance * 0.72, Math.max(radius * 4.2, distance * 0.40));
  const focusPos = center.clone().add(dir.multiplyScalar(focusDistance));
  focusPos.y += radius * 0.22;
  const focusTarget = center.clone();
  focusTarget.y += Math.min(radius * 0.18, 0.2);

  const arrived = await animateCamera(panel, savedPos, focusPos, savedTarget, focusTarget, MOVE_IN_MS);
  if (!arrived) {
    st.active = false;
    panel._ha3dAiFocusActive = false;
    return false;
  }

  if (organic?.dueAt?.set) organic.dueAt.set(entity, Date.now());
  await delay(HOLD_MS);

  if (!st.active || !isXrayActive(panel)) {
    st.active = false;
    panel._ha3dAiFocusActive = false;
    return false;
  }

  await animateCamera(
    panel,
    panel._camera.position.clone(),
    savedPos,
    panel._controls.target.clone(),
    savedTarget,
    MOVE_OUT_MS,
  );

  st.active = false;
  panel._ha3dAiFocusActive = false;
  st.lastFocusAt = Date.now();
  st.perEntity.set(entity, st.lastFocusAt);
  resumeIdleOrbit(panel);
  return true;
}

function evaluate(panel) {
  const st = focusState(panel);
  if (!isXrayActive(panel)) {
    st.pendingEntity = null;
    st.dueAt = 0;
    return;
  }

  if (panel._ha3dAiExplorationActive) {
    if (st.pendingEntity) st.dueAt = Date.now() + 1800;
    return;
  }

  refreshCandidates(panel);
  if (st.active || !st.pendingEntity || Date.now() < st.dueAt) return;

  const entity = st.pendingEntity;
  const anomalies = panel._ha3dOrganicTelemetry?.anomalies;
  if (!(anomalies instanceof Map) || !anomalies.has(entity)) {
    st.pendingEntity = null;
    st.dueAt = 0;
    return;
  }

  if (blueCalloutBusy(panel) || redCalloutBusy(panel)) {
    st.dueAt = Date.now() + 2200;
    return;
  }

  st.pendingEntity = null;
  st.dueAt = 0;
  startFocus(panel, entity);
}

function frame(panel, now) {
  const st = focusState(panel);
  if (!panel.isConnected) { st.raf = 0; return; }

  if (now - st.lastEvaluate > 1000) {
    st.lastEvaluate = now;
    evaluate(panel);

    // A persistent anomaly may be inspected later even if its first appearance was skipped.
    if (
      !st.active && !st.pendingEntity && isXrayActive(panel) &&
      Date.now() - st.lastFocusAt >= GLOBAL_COOLDOWN_MS
    ) {
      const anomalies = panel._ha3dOrganicTelemetry?.anomalies;
      if (anomalies instanceof Map && anomalies.size && Math.random() < 0.018) {
        const candidates = Array.from(anomalies.keys()).filter(
          (entity) => Date.now() - (st.perEntity.get(entity) || 0) >= ENTITY_COOLDOWN_MS,
        );
        if (candidates.length) schedule(panel, candidates[Math.floor(Math.random() * candidates.length)], 3000 + Math.random() * 4500);
      }
    }
  }

  st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function installActivity(panel) {
  const st = focusState(panel);
  if (st.installedActivity) return;
  const target = panel._renderer?.domElement || panel.shadowRoot?.querySelector("#stage") || panel.shadowRoot;
  if (!target?.addEventListener) return;
  const mark = () => { st.lastUserActivity = performance.now(); };
  target.addEventListener("pointerdown", mark, { passive: true });
  target.addEventListener("wheel", mark, { passive: true });
  target.addEventListener("touchstart", mark, { passive: true });
  st.installedActivity = true;
}

function install(panel) {
  if (!panel?.shadowRoot) return;
  installActivity(panel);
  refreshCandidates(panel);
  const st = focusState(panel);
  if (!st.raf) st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function cleanup(panel) {
  const st = focusState(panel);
  if (st.raf) cancelAnimationFrame(st.raf);
  if (st.cameraRaf) cancelAnimationFrame(st.cameraRaf);
  st.raf = 0;
  st.cameraRaf = 0;
  st.active = false;
  panel._ha3dAiFocusActive = false;
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

if (!proto.__ha3dAiInspectionFocusV1) {
  proto.__ha3dAiInspectionFocusV1 = true;

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

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: hassDescriptor.configurable ?? true,
      enumerable: hassDescriptor.enumerable ?? false,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        refreshCandidates(this);
        if (this.isConnected) queueMicrotask(() => install(this));
      },
    });
  }

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 350);
}
