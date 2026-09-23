import * as THREE from "https://esm.sh/three@0.180.0";

const CUSTOM_VIEWS_KEY = "ha3d_lab_custom_views_v1";
const FISHEYE_KEY = "ha3d_lab_fisheye_strength_v1";
const DEFAULT_FOV = 45;
const MIN_STRENGTH = 0;
const MAX_STRENGTH = 100;

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function clampStrength(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, numeric));
}

function readStrength() {
  try {
    return clampStrength(localStorage.getItem(FISHEYE_KEY) ?? 0);
  } catch (_error) {
    return 0;
  }
}

function currentStrength(panel) {
  return clampStrength(panel?._ha3dFisheyeStrength ?? readStrength());
}

function persistStrength(value) {
  try {
    localStorage.setItem(FISHEYE_KEY, String(clampStrength(value)));
  } catch (_error) {}
}

function persistCustomViews(panel) {
  try {
    localStorage.setItem(CUSTOM_VIEWS_KEY, JSON.stringify(panel._customViews || []));
  } catch (error) {
    console.warn("[HA3D] Failed to persist custom-view fisheye", error);
  }
}

function syncUi(panel) {
  const slider = panel.shadowRoot?.querySelector("#cameraLensSlider");
  const value = panel.shadowRoot?.querySelector("#cameraLensValue");
  if (!slider || !value) return;

  const strength = Math.round(currentStrength(panel));
  slider.value = String(strength);
  value.textContent = `${strength}%`;
}

function setStrength(panel, value, persist = true) {
  const strength = clampStrength(value);
  panel._ha3dFisheyeStrength = strength;
  if (panel._ha3dFisheyeUniforms?.uStrength) {
    panel._ha3dFisheyeUniforms.uStrength.value = strength / 100;
  }
  if (persist) persistStrength(strength);
  syncUi(panel);
}

function disposeFisheye(panel) {
  panel._ha3dFisheyeTarget?.dispose?.();
  panel._ha3dFisheyeQuadGeometry?.dispose?.();
  panel._ha3dFisheyeMaterial?.dispose?.();
  panel._ha3dFisheyeTarget = null;
  panel._ha3dFisheyeQuadGeometry = null;
  panel._ha3dFisheyeMaterial = null;
  panel._ha3dFisheyeScene = null;
  panel._ha3dFisheyeCamera = null;
  panel._ha3dFisheyeUniforms = null;
}

function ensurePostProcess(panel) {
  const renderer = panel?._renderer;
  if (!renderer || renderer.__ha3dFisheyeRenderV1) return Boolean(renderer);

  const uniforms = {
    tDiffuse: { value: null },
    uStrength: { value: currentStrength(panel) / 100 },
    uAspect: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uStrength;
      uniform float uAspect;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        vec2 metric = vec2(p.x * uAspect, p.y);
        float maxRadius = length(vec2(uAspect, 1.0));
        float radius = length(metric);

        if (radius > 0.00001 && uStrength > 0.0001) {
          float normalizedRadius = clamp(radius / maxRadius, 0.0, 1.0);
          float exponent = mix(1.0, 2.65, uStrength);
          float mappedRadius = pow(normalizedRadius, exponent) * maxRadius;
          metric *= mappedRadius / radius;
        }

        vec2 warped = vec2(metric.x / uAspect, metric.y);
        vec2 sampleUv = clamp(warped * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = texture2D(tDiffuse, sampleUv);
      }
    `,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  panel._ha3dFisheyeUniforms = uniforms;
  panel._ha3dFisheyeMaterial = material;
  panel._ha3dFisheyeQuadGeometry = geometry;
  panel._ha3dFisheyeScene = postScene;
  panel._ha3dFisheyeCamera = postCamera;

  const baseRender = renderer.render.bind(renderer);
  const bufferSize = new THREE.Vector2();

  renderer.render = (scene, camera) => {
    const strength = currentStrength(panel);
    if (strength <= 0 || scene === postScene) return baseRender(scene, camera);

    renderer.getDrawingBufferSize(bufferSize);
    const width = Math.max(1, Math.floor(bufferSize.x));
    const height = Math.max(1, Math.floor(bufferSize.y));

    let target = panel._ha3dFisheyeTarget;
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      panel._ha3dFisheyeTarget = target;
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
    }

    uniforms.uStrength.value = strength / 100;
    uniforms.uAspect.value = width / height;
    uniforms.tDiffuse.value = target.texture;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    baseRender(scene, camera);
    renderer.setRenderTarget(previousTarget);
    baseRender(postScene, postCamera);
  };

  renderer.__ha3dFisheyeRenderV1 = true;
  return true;
}

function ensureControl(panel) {
  const viewsPanel = panel.shadowRoot?.querySelector("#viewsPanel");
  if (!viewsPanel) return false;

  // The previous 0.1.14 control used these same IDs for FOV. Reuse the slot,
  // but replace its contents completely so only one slider remains.
  if (!panel.shadowRoot.querySelector("#ha3dCameraLensStyle")) {
    const style = document.createElement("style");
    style.id = "ha3dCameraLensStyle";
    panel.shadowRoot.appendChild(style);
  }

  panel.shadowRoot.querySelector("#ha3dCameraLensStyle").textContent = `
    #cameraLensControl{
      margin-top:10px;
      padding:10px 10px 9px;
      border-radius:12px;
      background:#202229;
      border:1px solid rgba(255,255,255,.09);
    }
    #cameraLensHeader{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:7px;
      font-size:12px;
      font-weight:700;
    }
    #cameraLensValue{
      min-width:38px;
      text-align:right;
      opacity:.78;
      font-variant-numeric:tabular-nums;
    }
    #cameraLensSlider{
      width:100%;
      margin:0;
      accent-color:var(--primary-color,#03a9f4);
      cursor:pointer;
    }
    #cameraLensScale{
      display:flex;
      justify-content:space-between;
      margin-top:4px;
      font-size:10px;
      opacity:.52;
    }
  `;

  let control = panel.shadowRoot.querySelector("#cameraLensControl");
  if (!control) {
    control = document.createElement("div");
    control.id = "cameraLensControl";
    const saveButton = viewsPanel.querySelector("#saveViewButton");
    viewsPanel.insertBefore(control, saveButton || null);
  }

  if (!control.__ha3dFisheyeControlV1) {
    control.__ha3dFisheyeControlV1 = true;
    control.innerHTML = `
      <div id="cameraLensHeader">
        <span>Olho de peixe</span>
        <span id="cameraLensValue">0%</span>
      </div>
      <input id="cameraLensSlider" type="range" min="${MIN_STRENGTH}" max="${MAX_STRENGTH}" step="1" value="0" aria-label="Intensidade do olho de peixe">
      <div id="cameraLensScale"><span>Normal</span><span>Fisheye</span></div>
    `;

    const slider = control.querySelector("#cameraLensSlider");
    slider.addEventListener("input", (event) => {
      event.stopPropagation();
      setStrength(panel, event.target.value, true);
    });
  }

  // Remove any FOV left behind by the previous implementation. Fisheye is now
  // the only camera-lens control.
  if (panel._camera && panel._camera.fov !== DEFAULT_FOV) {
    panel._camera.fov = DEFAULT_FOV;
    panel._camera.updateProjectionMatrix?.();
  }

  if (!Number.isFinite(panel._ha3dFisheyeStrength)) {
    panel._ha3dFisheyeStrength = readStrength();
  }
  ensurePostProcess(panel);
  setStrength(panel, panel._ha3dFisheyeStrength, false);
  return true;
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
  for (const panel of collectPanels(document)) ensureControl(panel);
}

if (!proto.__ha3dCameraFisheyeV1) {
  proto.__ha3dCameraFisheyeV1 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => ensureControl(this));
    requestAnimationFrame(() => ensureControl(this));
    return result;
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await originalLoadModel?.apply(this, args);
    ensureControl(this);
    return result;
  };

  const originalSaveCurrentView = proto._saveCurrentView;
  proto._saveCurrentView = function (...args) {
    const before = new Set((this._customViews || []).map((item) => item.id));
    const result = originalSaveCurrentView?.apply(this, args);
    const added = (this._customViews || []).find((item) => !before.has(item.id));
    if (added?.view) {
      delete added.view.fov;
      added.view.fisheye = currentStrength(this);
      persistCustomViews(this);
      this._renderCustomViews?.();
    }
    return result;
  };

  const originalAnimateCameraTo = proto._animateCameraTo;
  proto._animateCameraTo = function (view, ...args) {
    if (Number.isFinite(Number(view?.fisheye))) setStrength(this, view.fisheye, true);
    return originalAnimateCameraTo?.call(this, view, ...args);
  };

  const originalDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    disposeFisheye(this);
    return originalDisconnected?.apply(this, args);
  };

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
