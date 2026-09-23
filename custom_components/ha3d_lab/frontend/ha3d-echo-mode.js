import * as THREE from "https://esm.sh/three@0.180.0";

const ECHO_MODE_KEY = "ha3d_lab_echo_mode_v1";
const GRAPHICS_QUALITY_KEY = "ha3d_lab_texture_quality_pct_v1";
const ECHO_TEXTURE_QUALITY = 50;
const ECHO_PIXEL_RATIO = 0.65;

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function cloneView(view) {
  if (!view?.position || !view?.target) return null;
  return {
    position: [...view.position],
    target: [...view.target],
    up: [...(view.up || [0, 1, 0])],
  };
}

function readNormalGraphicsQuality(panel) {
  if (Number.isFinite(Number(panel?._graphicsQuality))) {
    return Math.max(0, Math.min(100, Number(panel._graphicsQuality)));
  }
  const raw = localStorage.getItem(GRAPHICS_QUALITY_KEY);
  if (raw === null) return 100;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
}

function ensureEchoState(panel) {
  if (typeof panel._ha3dEchoEnabled !== "boolean") {
    panel._ha3dEchoEnabled = localStorage.getItem(ECHO_MODE_KEY) === "1";
  }
}

function captureNormalProfile(panel) {
  ensureEchoState(panel);
  if (panel._ha3dEchoNormalProfile) return panel._ha3dEchoNormalProfile;

  panel._ha3dEchoNormalProfile = {
    pixelRatio: panel._renderer?.getPixelRatio?.() ?? null,
    shadowEnabled: panel._renderer?.shadowMap?.enabled ?? null,
    shadowAutoUpdate: panel._renderer?.shadowMap?.autoUpdate ?? null,
    graphicsQuality: readNormalGraphicsQuality(panel),
    defaultView: cloneView(panel._defaultView),
  };
  return panel._ha3dEchoNormalProfile;
}

function rotatedTopView(panel) {
  if (!panel?._model) return null;
  const box = new THREE.Box3().setFromObject(panel._model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z) || 1;

  const az = THREE.MathUtils.degToRad(0);
  const el = THREE.MathUtils.degToRad(89);
  const r = max * 1.48;
  const position = center.clone().add(
    new THREE.Vector3(
      Math.cos(el) * Math.cos(az) * r,
      Math.sin(el) * r,
      Math.cos(el) * Math.sin(az) * r,
    ),
  );

  return {
    position: position.toArray(),
    target: center.toArray(),
    up: [1, 0, 0],
  };
}

function normalTopView(panel) {
  if (!panel?._model) return null;
  const box = new THREE.Box3().setFromObject(panel._model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z) || 1;
  const az = THREE.MathUtils.degToRad(0);
  const el = THREE.MathUtils.degToRad(89);
  const r = max * 1.48;
  const position = center.clone().add(
    new THREE.Vector3(
      Math.cos(el) * Math.cos(az) * r,
      Math.sin(el) * r,
      Math.cos(el) * Math.sin(az) * r,
    ),
  );
  return { position: position.toArray(), target: center.toArray(), up: [0, 0, -1] };
}

function applyViewImmediate(panel, view) {
  if (!view || !panel?._camera || !panel?._controls) return;
  panel._camera.position.set(...view.position);
  panel._controls.target.set(...view.target);
  panel._camera.up.set(...(view.up || [0, 1, 0])).normalize();
  panel._camera.lookAt(panel._controls.target);
  panel._camera.updateProjectionMatrix();
  panel._controls.update();
}

function applyRendererProfile(panel) {
  if (!panel?._renderer) return;
  captureNormalProfile(panel);
  panel._renderer.setPixelRatio(ECHO_PIXEL_RATIO);
  if (panel._renderer.shadowMap) {
    panel._renderer.shadowMap.enabled = false;
    panel._renderer.shadowMap.autoUpdate = false;
  }
  panel._resize?.();
}

function restoreRendererProfile(panel) {
  const profile = panel._ha3dEchoNormalProfile;
  if (!panel?._renderer || !profile) return;
  if (Number.isFinite(profile.pixelRatio)) panel._renderer.setPixelRatio(profile.pixelRatio);
  if (panel._renderer.shadowMap) {
    if (typeof profile.shadowEnabled === "boolean") panel._renderer.shadowMap.enabled = profile.shadowEnabled;
    if (typeof profile.shadowAutoUpdate === "boolean") panel._renderer.shadowMap.autoUpdate = profile.shadowAutoUpdate;
  }
  panel._resize?.();
}

function applyTextureProfile(panel) {
  panel._applyGraphicsQuality?.(ECHO_TEXTURE_QUALITY, false);
  const slider = panel.shadowRoot?.querySelector("#graphicsTextureSlider");
  if (slider) slider.disabled = true;
}

function restoreTextureProfile(panel) {
  const quality = panel._ha3dEchoNormalProfile?.graphicsQuality;
  if (Number.isFinite(quality)) panel._applyGraphicsQuality?.(quality, false);
  const slider = panel.shadowRoot?.querySelector("#graphicsTextureSlider");
  if (slider) slider.disabled = false;
}

function syncEchoUi(panel) {
  const button = panel.shadowRoot?.querySelector("#echoModeButton");
  if (button) {
    button.textContent = panel._ha3dEchoEnabled ? "Modo Echo · Ligado" : "Modo Echo · Desligado";
    button.classList.toggle("active", panel._ha3dEchoEnabled);
    button.setAttribute("aria-pressed", panel._ha3dEchoEnabled ? "true" : "false");
  }
  const slider = panel.shadowRoot?.querySelector("#graphicsTextureSlider");
  if (slider) slider.disabled = panel._ha3dEchoEnabled;
}

function installEchoButton(panel) {
  ensureEchoState(panel);
  if (!panel?.shadowRoot) return false;

  const viewsPanel = panel.shadowRoot.querySelector("#viewsPanel");
  if (!viewsPanel) return false;

  if (!panel.shadowRoot.querySelector("#ha3dEchoModeStyle")) {
    const style = document.createElement("style");
    style.id = "ha3dEchoModeStyle";
    style.textContent = `
      #echoModeButton{width:100%;margin-top:9px;background:#24262c;font-size:12px;min-height:38px;padding:7px 8px}
      #echoModeButton.active{background:color-mix(in srgb,var(--primary-color,#03a9f4) 72%,#18304a)}
      #graphicsTextureSlider:disabled{opacity:.48}
    `;
    panel.shadowRoot.appendChild(style);
  }

  let button = panel.shadowRoot.querySelector("#echoModeButton");
  if (!button) {
    button = document.createElement("button");
    button.id = "echoModeButton";
    button.type = "button";
    button.title = "Perfil leve para Echo Show: 50% de texturas, renderização reduzida, sem sombras e vista Superior girada 90°";
    const saveButton = viewsPanel.querySelector("#saveViewButton");
    if (saveButton) viewsPanel.insertBefore(button, saveButton);
    else viewsPanel.appendChild(button);

    button.addEventListener("click", () => {
      setEchoMode(panel, !panel._ha3dEchoEnabled, true, true);
    });
  }

  syncEchoUi(panel);
  return true;
}

function setEchoMode(panel, enabled, persist = true, animate = false) {
  ensureEchoState(panel);
  const next = Boolean(enabled);

  if (next) {
    captureNormalProfile(panel);
    panel._ha3dEchoEnabled = true;
    if (persist) localStorage.setItem(ECHO_MODE_KEY, "1");

    applyRendererProfile(panel);
    applyTextureProfile(panel);

    const view = rotatedTopView(panel);
    if (view) {
      if (!panel._ha3dEchoNormalProfile.defaultView) {
        panel._ha3dEchoNormalProfile.defaultView = cloneView(panel._defaultView) || normalTopView(panel);
      }
      panel._defaultView = cloneView(view);
      if (animate && !panel._cameraAnimating) panel._animateCameraTo?.(view);
      else if (!animate) applyViewImmediate(panel, view);
    }
  } else {
    panel._ha3dEchoEnabled = false;
    if (persist) localStorage.setItem(ECHO_MODE_KEY, "0");

    restoreRendererProfile(panel);
    restoreTextureProfile(panel);

    const normalDefault = cloneView(panel._ha3dEchoNormalProfile?.defaultView) || normalTopView(panel);
    if (normalDefault) {
      panel._defaultView = cloneView(normalDefault);
      if (animate && !panel._cameraAnimating) panel._animateCameraTo?.(normalDefault);
    }

    panel._ha3dEchoNormalProfile = null;
  }

  syncEchoUi(panel);
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
  for (const panel of collectPanels(document)) {
    installEchoButton(panel);
    if (panel._ha3dEchoEnabled) {
      applyRendererProfile(panel);
      applyTextureProfile(panel);
      const view = rotatedTopView(panel);
      if (view) {
        panel._defaultView = cloneView(view);
        if (!panel._cameraAnimating) applyViewImmediate(panel, view);
      }
    }
  }
}

if (!proto.__ha3dEchoModeV2) {
  proto.__ha3dEchoModeV2 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    ensureEchoState(this);
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => installEchoButton(this));
    requestAnimationFrame(() => installEchoButton(this));
    return result;
  };

  const originalInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    ensureEchoState(this);
    const result = originalInitViewer?.apply(this, args);
    if (this._ha3dEchoEnabled) applyRendererProfile(this);
    return result;
  };

  const originalFit = proto._fit;
  proto._fit = function (...args) {
    ensureEchoState(this);
    const result = originalFit?.apply(this, args);

    if (this._ha3dEchoEnabled) {
      const profile = captureNormalProfile(this);
      profile.defaultView = cloneView(this._defaultView) || profile.defaultView;
      const view = rotatedTopView(this);
      if (view) {
        this._defaultView = cloneView(view);
        applyViewImmediate(this, view);
      }
    }
    return result;
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await originalLoadModel?.apply(this, args);
    ensureEchoState(this);
    installEchoButton(this);
    if (this._ha3dEchoEnabled) {
      applyRendererProfile(this);
      applyTextureProfile(this);
      const view = rotatedTopView(this);
      if (view) this._defaultView = cloneView(view);
    }
    syncEchoUi(this);
    return result;
  };

  const originalInstallGraphicsControls = proto._installGraphicsControls;
  proto._installGraphicsControls = function (...args) {
    const result = originalInstallGraphicsControls?.apply(this, args);
    installEchoButton(this);
    if (this._ha3dEchoEnabled) applyTextureProfile(this);
    return result;
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
