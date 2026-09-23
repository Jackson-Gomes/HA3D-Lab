import * as THREE from "https://esm.sh/three@0.180.0";

const IDLE_MS = 15000;
const IDLE_ENTER_MS = 1800;
const EXIT_HOLD_MS = 1000;
const ORBIT_SPEED = 0.000025;
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const meshState = new WeakMap();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idleAllowed(panel) {
  return Boolean(
    panel?.isConnected &&
      panel._cinematicEnabled &&
      panel._model &&
      panel._camera &&
      panel._controls &&
      !panel._cinematicActive &&
      !panel._ha3dIdleExitSequence,
  );
}

function ensureState(panel) {
  localStorage.removeItem("ha3d_lab_xray_theme_v1");

  if (typeof panel._ha3dIdleActive !== "boolean") panel._ha3dIdleActive = false;
  if (!panel._ha3dIdleTimer) panel._ha3dIdleTimer = 0;
  if (!panel._ha3dIdleRaf) panel._ha3dIdleRaf = 0;
  if (typeof panel._ha3dResumeIdleAfterCinematic !== "boolean") {
    panel._ha3dResumeIdleAfterCinematic = false;
  }

  if (!panel._ha3dXrayMaterial) {
    panel._ha3dXrayMaterial = new THREE.MeshBasicMaterial({
      color: 0x0bbcff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }

  if (!panel._ha3dXrayEdgeMaterial) {
    panel._ha3dXrayEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0x4de7ff,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }
}

function ensureStyle(panel) {
  if (!panel.shadowRoot) return;
  let style = panel.shadowRoot.querySelector("#ha3dXrayThemeStyle");
  if (!style) {
    style = document.createElement("style");
    style.id = "ha3dXrayThemeStyle";
    panel.shadowRoot.appendChild(style);
  }

  style.textContent = `
    #topbar,#viewsPanel,#meta,#markers,#markerFilterBar,#scenePrefixMenu{
      transition:opacity .28s ease;
    }
    #root.ha3d-idle-xray #topbar,
    #root.ha3d-idle-xray #viewsPanel,
    #root.ha3d-idle-xray #meta,
    #root.ha3d-idle-xray #markers,
    #root.ha3d-idle-xray #markerFilterBar,
    #root.ha3d-idle-xray #scenePrefixMenu{
      opacity:0!important;
      pointer-events:none!important;
    }
  `;

  panel.shadowRoot.querySelector("#xrayThemeButton")?.remove();
}

function ensureMeshXray(panel, mesh) {
  let state = meshState.get(mesh);
  if (!state) {
    state = {
      material: mesh.material,
      renderOrder: mesh.renderOrder,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      edge: null,
    };
    meshState.set(mesh, state);
  }

  if (!state.edge && mesh.geometry?.attributes?.position) {
    try {
      const geometry = new THREE.EdgesGeometry(mesh.geometry, 28);
      const edge = new THREE.LineSegments(geometry, panel._ha3dXrayEdgeMaterial);
      edge.name = "__HA3D_XRAY_EDGES__";
      edge.userData.ha3dXrayOverlay = true;
      edge.frustumCulled = mesh.frustumCulled;
      edge.renderOrder = 3;
      edge.visible = false;
      mesh.add(edge);
      state.edge = edge;
    } catch (error) {
      console.warn("[HA3D] X-Ray edges skipped", mesh.name, error);
    }
  }

  return state;
}

function applyModelXray(panel, enabled) {
  ensureState(panel);
  const model = panel._model;
  if (!model) return;

  model.traverse((object) => {
    if (!object.isMesh || object.userData?.ha3dXrayOverlay) return;

    let state = meshState.get(object);
    if (enabled) state = ensureMeshXray(panel, object);
    else if (!state) return;

    if (enabled) {
      object.material = panel._ha3dXrayMaterial;
      object.renderOrder = 1;
      object.castShadow = false;
      object.receiveShadow = false;
      if (state.edge) state.edge.visible = true;
    } else {
      object.material = state.material;
      object.renderOrder = state.renderOrder;
      object.castShadow = state.castShadow;
      object.receiveShadow = state.receiveShadow;
      if (state.edge) state.edge.visible = false;
    }
  });
}

function applyBackground(panel, enabled) {
  if (!panel._scene) return;

  if (!panel._ha3dXrayBackgroundCaptured) {
    panel._ha3dXrayBackgroundCaptured = true;
    panel._ha3dXrayOriginalBackground = panel._scene.background?.clone?.() ?? panel._scene.background ?? null;
  }

  if (enabled) {
    panel._scene.background = new THREE.Color(0x01070b);
  } else {
    const original = panel._ha3dXrayOriginalBackground;
    panel._scene.background = original?.clone?.() ?? original ?? null;
  }
}

function applyXray(panel, enabled) {
  applyBackground(panel, enabled);
  applyModelXray(panel, enabled);
}

function disposeOldModel(model) {
  if (!model) return;
  const edges = [];
  model.traverse((object) => {
    if (!object.isMesh) return;
    const state = meshState.get(object);
    if (state?.edge) edges.push([object, state.edge]);
  });
  for (const [mesh, edge] of edges) {
    mesh.remove(edge);
    edge.geometry?.dispose?.();
  }
}

function clearIdleTimer(panel) {
  clearTimeout(panel._ha3dIdleTimer);
  panel._ha3dIdleTimer = 0;
}

function clearIdleAnimation(panel) {
  if (panel._ha3dIdleRaf) cancelAnimationFrame(panel._ha3dIdleRaf);
  panel._ha3dIdleRaf = 0;
}

function armIdle(panel, wait = IDLE_MS) {
  ensureState(panel);
  clearIdleTimer(panel);
  if (!panel.isConnected || !panel._cinematicEnabled || !panel._model || panel._ha3dIdleActive) return;

  panel._ha3dIdleTimer = setTimeout(() => {
    panel._ha3dIdleTimer = 0;
    if (!idleAllowed(panel) || panel._cameraAnimating) {
      if (panel.isConnected && panel._cinematicEnabled && !panel._ha3dIdleActive) armIdle(panel, 1800);
      return;
    }
    enterIdle(panel);
  }, wait);
}

function idlePerspective(panel) {
  const box = new THREE.Box3().setFromObject(panel._model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z, 1);
  const direction = new THREE.Vector3(1.08, 0.78, 1.15).normalize();
  const position = center.clone().add(direction.multiplyScalar(max * 1.62));
  return { center, position, max };
}

function startIdleCamera(panel) {
  const { center, position } = idlePerspective(panel);
  const startPos = panel._camera.position.clone();
  const startTarget = panel._controls.target.clone();
  const startUp = panel._camera.up.clone();
  const endUp = new THREE.Vector3(0, 1, 0);
  const begun = performance.now();

  panel._ha3dIdleOrbit = {
    center,
    radius: Math.max(0.001, Math.hypot(position.x - center.x, position.z - center.z)),
    height: position.y - center.y,
    angle: Math.atan2(position.z - center.z, position.x - center.x),
    last: 0,
  };

  const frame = (now) => {
    if (!panel._ha3dIdleActive) return;
    const elapsed = now - begun;

    if (elapsed < IDLE_ENTER_MS) {
      const t0 = Math.max(0, Math.min(1, elapsed / IDLE_ENTER_MS));
      const t = t0 * t0 * (3 - 2 * t0);
      panel._camera.position.lerpVectors(startPos, position, t);
      panel._controls.target.lerpVectors(startTarget, center, t);
      panel._camera.up.copy(startUp).lerp(endUp, t).normalize();
      panel._camera.lookAt(panel._controls.target);
    } else {
      const orbit = panel._ha3dIdleOrbit;
      const delta = orbit.last ? Math.min(80, now - orbit.last) : 16;
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
    }

    panel._ha3dIdleRaf = requestAnimationFrame(frame);
  };

  panel._ha3dIdleRaf = requestAnimationFrame(frame);
}

function enterIdle(panel) {
  ensureState(panel);
  if (!idleAllowed(panel) || panel._cameraAnimating || panel._ha3dIdleActive) return false;

  clearIdleTimer(panel);
  clearIdleAnimation(panel);
  panel._ha3dIdleActive = true;
  panel._ha3dIdleControlsState = {
    enabled: panel._controls.enabled,
    damping: panel._controls.enableDamping,
  };

  panel._controls.enabled = false;
  panel._controls.enableDamping = false;
  panel._cameraAnimating = true;

  panel.shadowRoot?.querySelector("#viewsPanel")?.classList.remove("open");
  panel.shadowRoot?.querySelector("#scenePrefixMenu")?.classList.remove("open");
  panel.shadowRoot?.querySelector("#root")?.classList.add("ha3d-idle-xray");

  applyXray(panel, true);
  startIdleCamera(panel);
  return true;
}

function stopIdle(panel) {
  ensureState(panel);
  clearIdleTimer(panel);
  clearIdleAnimation(panel);

  if (!panel._ha3dIdleActive) {
    applyXray(panel, false);
    panel.shadowRoot?.querySelector("#root")?.classList.remove("ha3d-idle-xray");
    return false;
  }

  panel._ha3dIdleActive = false;
  panel.shadowRoot?.querySelector("#root")?.classList.remove("ha3d-idle-xray");
  applyXray(panel, false);

  const controlsState = panel._ha3dIdleControlsState;
  if (panel._controls && controlsState) {
    panel._controls.enabled = controlsState.enabled;
    panel._controls.enableDamping = controlsState.damping;
    panel._controls.update();
  }
  panel._ha3dIdleControlsState = null;
  panel._ha3dIdleOrbit = null;
  panel._cameraAnimating = false;
  return true;
}

function waitForCamera(panel, timeoutMs = 8000) {
  const started = performance.now();
  return new Promise((resolve) => {
    const poll = () => {
      if (!panel._cameraAnimating || performance.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function exitIdleFromUser(panel) {
  if (!panel._ha3dIdleActive || panel._ha3dIdleExitSequence) return;

  panel._ha3dResumeIdleAfterCinematic = false;
  stopIdle(panel);
  panel._ha3dIdleExitSequence = true;

  try {
    panel._applyCameraView?.("top");
    await waitForCamera(panel);
    await delay(EXIT_HOLD_MS);
    panel._applyCameraView?.("default");
    await waitForCamera(panel);
  } finally {
    panel._ha3dIdleExitSequence = false;
    armIdle(panel);
  }
}

function exitIdleForCinematic(panel) {
  if (!panel._ha3dIdleActive) return;
  panel._ha3dResumeIdleAfterCinematic = true;
  stopIdle(panel);
}

function installInteractionHooks(panel) {
  const root = panel.shadowRoot?.querySelector("#root");
  if (!root || root.__ha3dIdleXrayHooks) return;
  root.__ha3dIdleXrayHooks = true;

  const activity = (event) => {
    if (panel._ha3dIdleActive) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      exitIdleFromUser(panel);
      return;
    }
    armIdle(panel);
  };

  root.addEventListener("pointerdown", activity, true);
  root.addEventListener("wheel", activity, { capture: true, passive: false });
}

function install(panel) {
  ensureState(panel);
  ensureStyle(panel);
  installInteractionHooks(panel);
  armIdle(panel);
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

if (!proto.__ha3dXrayIdleV2) {
  proto.__ha3dXrayIdleV2 = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    ensureState(this);
    originalConnectedCallback?.call(this);
    queueMicrotask(() => install(this));
  };

  const originalDisconnectedCallback = proto.disconnectedCallback;
  proto.disconnectedCallback = function () {
    clearIdleTimer(this);
    clearIdleAnimation(this);
    stopIdle(this);
    return originalDisconnectedCallback?.call(this);
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const previousModel = this._model;
    stopIdle(this);
    const result = await originalLoadModel.apply(this, args);
    if (previousModel && previousModel !== this._model) disposeOldModel(previousModel);
    ensureStyle(this);
    armIdle(this);
    return result;
  };

  const originalEnqueue = proto._enqueueCinematicBatch;
  proto._enqueueCinematicBatch = function (...args) {
    if (this._ha3dIdleActive) exitIdleForCinematic(this);
    return originalEnqueue?.apply(this, args);
  };

  const originalRun = proto._runCinematicFocus;
  proto._runCinematicFocus = function (...args) {
    if (this._ha3dIdleActive) exitIdleForCinematic(this);
    clearIdleTimer(this);
    return originalRun?.apply(this, args);
  };

  const originalRestoreCinematicUi = proto._restoreCinematicUi;
  proto._restoreCinematicUi = function (...args) {
    const result = originalRestoreCinematicUi?.apply(this, args);

    if (
      this._ha3dResumeIdleAfterCinematic &&
      this._cinematicEnabled &&
      !this._cinematicActive &&
      !(this._cinematicQueue?.length)
    ) {
      this._ha3dResumeIdleAfterCinematic = false;
      clearIdleTimer(this);
      this._ha3dIdleTimer = setTimeout(() => {
        if (this.isConnected) enterIdle(this);
      }, 650);
    } else {
      armIdle(this);
    }
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
