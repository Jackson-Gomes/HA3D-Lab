import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function scalar(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function deviceClass(state) {
  return String(state?.attributes?.device_class || "").toLowerCase();
}

function anomalyReason(entity, state) {
  const current = String(state?.state || "").toLowerCase();
  if (current === "unavailable" || current === "unknown") return "TELEMETRY LOSS";
  if (String(entity).startsWith("vacuum.") && current === "error") return "VACUUM FAULT";

  const attrs = state?.attributes || {};
  const battery = scalar(attrs.battery_level ?? attrs.battery);
  if (battery != null && battery <= 20) return "ENERGY LOW";

  if (String(entity).startsWith("sensor.") && /battery|bateria/.test(String(entity).toLowerCase())) {
    const value = scalar(state?.state);
    if (value != null && value <= 20) return "ENERGY LOW";
  }

  if (
    String(entity).startsWith("binary_sensor.") &&
    ["door", "window", "opening"].includes(deviceClass(state)) &&
    current === "on"
  ) return "CONTACT OPEN";

  return null;
}

function ensureMaterials(panel) {
  if (!panel._ha3dXrayAnomalyMaterial) {
    panel._ha3dXrayAnomalyMaterial = new THREE.MeshBasicMaterial({
      color: 0xff2946,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }
  if (!panel._ha3dXrayAnomalyEdgeMaterial) {
    panel._ha3dXrayAnomalyEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0xff6072,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
}

function meshesForBoundObject(object) {
  const meshes = [];
  if (!object) return meshes;
  if (object.isMesh && !object.userData?.ha3dXrayOverlay) meshes.push(object);
  object.traverse?.((child) => {
    if (child === object) return;
    if (child.isMesh && !child.userData?.ha3dXrayOverlay) meshes.push(child);
  });
  return meshes;
}

function apply(panel) {
  if (!panel?._model || !isXrayActive(panel)) return;
  ensureMaterials(panel);

  const states = panel._hass?.states || {};
  const touched = new Set();

  for (const [entity, objects] of panel._objectsByEntity?.entries?.() || []) {
    const state = states[entity];
    const anomalous = Boolean(anomalyReason(entity, state));

    for (const object of objects || []) {
      for (const mesh of meshesForBoundObject(object)) {
        if (touched.has(mesh)) continue;
        touched.add(mesh);
        mesh.material = anomalous ? panel._ha3dXrayAnomalyMaterial : panel._ha3dXrayMaterial;
        for (const child of mesh.children || []) {
          if (!child?.userData?.ha3dXrayOverlay && child?.name !== "__HA3D_XRAY_EDGES__") continue;
          child.material = anomalous ? panel._ha3dXrayAnomalyEdgeMaterial : panel._ha3dXrayEdgeMaterial;
        }
      }
    }
  }
}

function pulse(panel) {
  if (!isXrayActive(panel) || !panel._ha3dXrayAnomalyMaterial || !panel._ha3dXrayAnomalyEdgeMaterial) return;
  const now = performance.now();
  const breath = (Math.sin(now * 0.00135) + 1) * 0.5;
  panel._ha3dXrayAnomalyMaterial.opacity = 0.22 + breath * 0.08;
  panel._ha3dXrayAnomalyEdgeMaterial.opacity = 0.82 + breath * 0.16;
}

function state(panel) {
  if (!panel._ha3dXrayAnomalyVisual) panel._ha3dXrayAnomalyVisual = { raf: 0, lastApply: 0 };
  return panel._ha3dXrayAnomalyVisual;
}

function frame(panel, now) {
  const st = state(panel);
  if (!panel.isConnected) { st.raf = 0; return; }
  if (isXrayActive(panel)) {
    if (now - st.lastApply > 600) {
      st.lastApply = now;
      apply(panel);
    }
    pulse(panel);
  } else {
    st.lastApply = 0;
  }
  st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function install(panel) {
  ensureMaterials(panel);
  apply(panel);
  const st = state(panel);
  if (!st.raf) st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function cleanup(panel) {
  const st = state(panel);
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

if (!proto.__ha3dXrayAnomalyVisualV1) {
  proto.__ha3dXrayAnomalyVisualV1 = true;

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
        if (isXrayActive(this)) queueMicrotask(() => apply(this));
      },
    });
  }

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
}
