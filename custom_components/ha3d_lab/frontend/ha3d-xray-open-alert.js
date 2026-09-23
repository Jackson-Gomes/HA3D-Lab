import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isDoorWindowSensor(entity, state) {
  if (!String(entity || "").startsWith("binary_sensor.")) return false;

  const deviceClass = String(state?.attributes?.device_class || "").toLowerCase();
  if (["window", "door", "opening"].includes(deviceClass)) return true;

  const objectId = String(entity).slice("binary_sensor.".length).toLowerCase();
  return /(^|_)(janela|porta|window|door)(_|$)/.test(objectId);
}

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function ensureAlertMaterials(panel) {
  if (!panel._ha3dXrayOpenMaterial) {
    panel._ha3dXrayOpenMaterial = new THREE.MeshBasicMaterial({
      color: 0xff263f,
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }

  if (!panel._ha3dXrayOpenEdgeMaterial) {
    panel._ha3dXrayOpenEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0xff596b,
      transparent: true,
      opacity: 0.98,
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

function setMeshAlert(panel, mesh, open) {
  if (!mesh?.isMesh) return;

  mesh.material = open ? panel._ha3dXrayOpenMaterial : panel._ha3dXrayMaterial;

  for (const child of mesh.children || []) {
    if (!child?.userData?.ha3dXrayOverlay && child?.name !== "__HA3D_XRAY_EDGES__") continue;
    child.material = open ? panel._ha3dXrayOpenEdgeMaterial : panel._ha3dXrayEdgeMaterial;
  }
}

function applyOpenAlerts(panel) {
  if (!panel?._model || !isXrayActive(panel)) return;
  ensureAlertMaterials(panel);

  const states = panel._hass?.states || {};
  const touched = new Set();

  for (const [entity, objects] of panel._objectsByEntity?.entries?.() || []) {
    const state = states[entity];
    if (!isDoorWindowSensor(entity, state)) continue;

    const open = state?.state === "on";
    for (const object of objects || []) {
      for (const mesh of meshesForBoundObject(object)) {
        if (touched.has(mesh)) continue;
        touched.add(mesh);
        setMeshAlert(panel, mesh, open);
      }
    }
  }
}

function installObserver(panel) {
  const root = panel?.shadowRoot?.querySelector("#root");
  if (!root || root.__ha3dXrayOpenAlertObserver) return;

  const observer = new MutationObserver(() => {
    if (isXrayActive(panel)) queueMicrotask(() => applyOpenAlerts(panel));
  });
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  root.__ha3dXrayOpenAlertObserver = observer;

  if (isXrayActive(panel)) applyOpenAlerts(panel);
}

function install(panel) {
  ensureAlertMaterials(panel);
  installObserver(panel);
  if (isXrayActive(panel)) applyOpenAlerts(panel);
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

if (!proto.__ha3dXrayOpenAlertV1) {
  proto.__ha3dXrayOpenAlertV1 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => install(this));
    return result;
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
        if (isXrayActive(this)) queueMicrotask(() => applyOpenAlerts(this));
      },
    });
  }

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
