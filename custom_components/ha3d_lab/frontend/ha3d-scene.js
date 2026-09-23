import * as THREE from "https://esm.sh/three@0.180.0";

const GLOBAL_LIGHT_KEY = "ha3d_lab_global_light_pct_v1";
const GLOBAL_LIGHT_TEMP_KEY = "ha3d_lab_global_light_kelvin_v1";
const GLOBAL_LIGHT_POS_KEY = "ha3d_lab_global_light_pos_v1";
const DEFAULT_GLOBAL_LIGHT = {
  intensity: 50,
  kelvin: 5200,
  x: 45,
  y: 85,
  z: 35,
};

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function readNumber(key, fallback, min, max) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function readPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GLOBAL_LIGHT_POS_KEY) || "null");
    if (!parsed) throw new Error("empty");
    return {
      x: clamp(parsed.x, -100, 100),
      y: clamp(parsed.y, -100, 100),
      z: clamp(parsed.z, -100, 100),
    };
  } catch (_error) {
    return {
      x: DEFAULT_GLOBAL_LIGHT.x,
      y: DEFAULT_GLOBAL_LIGHT.y,
      z: DEFAULT_GLOBAL_LIGHT.z,
    };
  }
}

function ensureSceneState(panel) {
  if (panel._ha3dSceneStateReadyV4) return;
  panel._ha3dSceneStateReadyV4 = true;
  panel._globalLightPct = readNumber(
    GLOBAL_LIGHT_KEY,
    DEFAULT_GLOBAL_LIGHT.intensity,
    0,
    100,
  );
  panel._globalLightKelvin = readNumber(
    GLOBAL_LIGHT_TEMP_KEY,
    DEFAULT_GLOBAL_LIGHT.kelvin,
    2000,
    10000,
  );
  panel._globalLightPosition = readPosition();
}

function kelvinToColor(kelvin) {
  const temp = clamp(kelvin, 1000, 40000) / 100;
  let red;
  let green;
  let blue;

  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }

  const toUnit = (channel) => clamp(channel, 0, 255) / 255;
  return new THREE.Color().setRGB(toUnit(red), toUnit(green), toUnit(blue), THREE.SRGBColorSpace);
}

function getSceneFrame(panel) {
  if (panel._model) {
    const box = new THREE.Box3().setFromObject(panel._model);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      return {
        center,
        scale: Math.max(size.x, size.y, size.z, 1),
      };
    }
  }

  return {
    center: panel._controls?.target?.clone?.() || new THREE.Vector3(),
    scale: 10,
  };
}

function installAndApplySceneControls(panel) {
  ensureSceneState(panel);
  panel._installGlobalLightControl?.();
  panel._applyGlobalLightSettings?.(false);
}

if (!proto.__ha3dSceneLightTunedV4) {
  proto.__ha3dSceneLightTunedV4 = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    ensureSceneState(this);
    originalConnectedCallback.call(this);
    queueMicrotask(() => installAndApplySceneControls(this));
  };

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: true,
      enumerable: hassDescriptor.enumerable,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        queueMicrotask(() => installAndApplySceneControls(this));
      },
    });
  }

  const originalInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    ensureSceneState(this);
    const result = originalInitViewer.apply(this, args);

    const hemi = this._scene?.children?.find((item) => item?.isHemisphereLight);
    if (hemi) {
      this._ha3dGlobalAmbient = hemi;
      if (!Number.isFinite(hemi.userData?.ha3dBaseIntensity)) {
        hemi.userData.ha3dBaseIntensity = hemi.intensity || 0.55;
      }
      if (!hemi.userData?.ha3dBaseGroundColor) {
        hemi.userData.ha3dBaseGroundColor = hemi.groundColor?.clone?.();
      }
    }

    this._ensureGlobalDirectionalLight?.();
    this._applyGlobalLightSettings?.(false);
    return result;
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await originalLoadModel.apply(this, args);
    this._applyGlobalLightSettings?.(false);
    return result;
  };

  const originalRestoreUnboundModelLights = proto._restoreUnboundModelLights;
  proto._restoreUnboundModelLights = function (...args) {
    const result = originalRestoreUnboundModelLights.apply(this, args);

    const boundLights = new Set(
      [...(this._lightBindings?.values?.() || [])]
        .map((binding) => binding.light)
        .filter(Boolean),
    );

    for (const light of this._modelLights || []) {
      if (boundLights.has(light)) continue;
      if (!Number.isFinite(light.userData?.ha3dFillBaseIntensity)) {
        light.userData.ha3dFillBaseIntensity = light.intensity || 0;
      }
      light.intensity = light.userData.ha3dFillBaseIntensity * 0.30;
      light.castShadow = false;
    }

    return result;
  };

  proto._ensureGlobalDirectionalLight = function () {
    if (!this._scene) return null;
    if (this._ha3dGlobalDirectional?.parent === this._scene) return this._ha3dGlobalDirectional;

    const light = new THREE.DirectionalLight(0xffffff, 0);
    light.name = "HA3D_GlobalDirectional";
    light.castShadow = false;

    const target = new THREE.Object3D();
    target.name = "HA3D_GlobalDirectionalTarget";

    light.target = target;
    this._scene.add(target);
    this._scene.add(light);

    this._ha3dGlobalDirectional = light;
    this._ha3dGlobalDirectionalTarget = target;
    return light;
  };

  proto._applyGlobalLightSettings = function (persist = true) {
    ensureSceneState(this);

    const pct = clamp(this._globalLightPct, 0, 100);
    const kelvin = clamp(this._globalLightKelvin, 2000, 10000);
    const pos = this._globalLightPosition || { ...DEFAULT_GLOBAL_LIGHT };

    if (persist) {
      localStorage.setItem(GLOBAL_LIGHT_KEY, String(pct));
      localStorage.setItem(GLOBAL_LIGHT_TEMP_KEY, String(kelvin));
      localStorage.setItem(
        GLOBAL_LIGHT_POS_KEY,
        JSON.stringify({ x: pos.x, y: pos.y, z: pos.z }),
      );
    }

    const color = kelvinToColor(kelvin);
    const hemi = this._ha3dGlobalAmbient || this._scene?.children?.find((item) => item?.isHemisphereLight);
    if (hemi) {
      this._ha3dGlobalAmbient = hemi;
      if (!Number.isFinite(hemi.userData?.ha3dBaseIntensity)) {
        hemi.userData.ha3dBaseIntensity = hemi.intensity || 0.55;
      }
      // Keep a soft ambient fill while the directional light provides position.
      hemi.intensity = hemi.userData.ha3dBaseIntensity * (pct / 100);
      hemi.color.copy(color);
    }

    const directional = this._ensureGlobalDirectionalLight?.();
    if (directional) {
      directional.color.copy(color);
      // At 50%, ambient + directional is close to the original overall level.
      directional.intensity = 0.55 * (pct / 100);

      const { center, scale } = getSceneFrame(this);
      const x = clamp(pos.x, -100, 100) / 100;
      const y = clamp(pos.y, -100, 100) / 100;
      const z = clamp(pos.z, -100, 100) / 100;
      const vector = new THREE.Vector3(x, y, z);
      if (vector.lengthSq() < 0.0001) vector.set(0.01, 1, 0.01);
      vector.normalize().multiplyScalar(scale * 1.6);

      directional.position.copy(center).add(vector);
      this._ha3dGlobalDirectionalTarget?.position.copy(center);
      this._ha3dGlobalDirectionalTarget?.updateMatrixWorld();
    }

    const intensitySlider = this.shadowRoot?.querySelector("#globalLightSlider");
    const intensityValue = this.shadowRoot?.querySelector("#globalLightValue");
    const temperatureSlider = this.shadowRoot?.querySelector("#globalLightTemperature");
    const temperatureValue = this.shadowRoot?.querySelector("#globalLightTemperatureValue");

    if (intensitySlider) intensitySlider.value = String(pct);
    if (intensityValue) intensityValue.textContent = `${Math.round(pct)}%`;
    if (temperatureSlider) temperatureSlider.value = String(Math.round(kelvin));
    if (temperatureValue) temperatureValue.textContent = `${Math.round(kelvin)} K`;

    for (const axis of ["x", "y", "z"]) {
      const slider = this.shadowRoot?.querySelector(`#globalLightPos${axis.toUpperCase()}`);
      const label = this.shadowRoot?.querySelector(`#globalLightPos${axis.toUpperCase()}Value`);
      const value = Math.round(clamp(pos[axis], -100, 100));
      if (slider) slider.value = String(value);
      if (label) label.textContent = `${value > 0 ? "+" : ""}${value}`;
    }
  };

  proto._installGlobalLightControl = function () {
    ensureSceneState(this);
    if (!this.shadowRoot || this.shadowRoot.querySelector("#globalLightSection")) return;

    const viewsPanel = this.shadowRoot.querySelector("#viewsPanel");
    if (!viewsPanel) return;

    const style = document.createElement("style");
    style.textContent = `
      #viewsPanel{max-height:calc(100vh - 92px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
      #globalLightSection{margin:9px 0 11px;padding:10px 1px 11px;border-top:1px solid rgba(255,255,255,.11);border-bottom:1px solid rgba(255,255,255,.11)}
      .globalLightHeader,.globalLightRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .globalLightHeader{margin-bottom:8px}.globalLightRow{margin-top:9px}
      .globalLightTitle{font-size:13px;font-weight:700}.globalLightLabel{font-size:12px;font-weight:600;opacity:.9}
      .globalLightValue{font-size:12px;opacity:.72;white-space:nowrap;min-width:58px;text-align:right}
      .globalLightSlider{width:100%;accent-color:var(--primary-color,#03a9f4)}
      .globalLightAxis{display:grid;grid-template-columns:18px 1fr 42px;gap:8px;align-items:center;margin-top:7px}
      .globalLightAxis span{font-size:11px;opacity:.72}.globalLightAxis .axisValue{text-align:right}
      .globalLightHint{font-size:11px;opacity:.62;line-height:1.4;margin-top:8px}
      .globalLightReset{width:100%;margin-top:10px;background:#24262c;font-size:12px;min-height:34px;padding:7px 8px}
    `;
    this.shadowRoot.appendChild(style);

    const p = this._globalLightPosition;
    const section = document.createElement("div");
    section.id = "globalLightSection";
    section.innerHTML = `
      <div class="globalLightHeader">
        <span class="globalLightTitle">Luz geral</span>
        <span id="globalLightValue" class="globalLightValue">${Math.round(this._globalLightPct)}%</span>
      </div>
      <div class="globalLightLabel">Intensidade</div>
      <input id="globalLightSlider" class="globalLightSlider" type="range" min="0" max="100" step="5" value="${this._globalLightPct}">

      <div class="globalLightRow">
        <span class="globalLightLabel">Temperatura</span>
        <span id="globalLightTemperatureValue" class="globalLightValue">${Math.round(this._globalLightKelvin)} K</span>
      </div>
      <input id="globalLightTemperature" class="globalLightSlider" type="range" min="2000" max="10000" step="100" value="${this._globalLightKelvin}">

      <div class="globalLightRow"><span class="globalLightLabel">Posição</span><span class="globalLightValue">direção da luz</span></div>
      <div class="globalLightAxis"><span>X</span><input id="globalLightPosX" class="globalLightSlider" type="range" min="-100" max="100" step="5" value="${p.x}"><span id="globalLightPosXValue" class="axisValue">${p.x}</span></div>
      <div class="globalLightAxis"><span>Y</span><input id="globalLightPosY" class="globalLightSlider" type="range" min="-100" max="100" step="5" value="${p.y}"><span id="globalLightPosYValue" class="axisValue">${p.y}</span></div>
      <div class="globalLightAxis"><span>Z</span><input id="globalLightPosZ" class="globalLightSlider" type="range" min="-100" max="100" step="5" value="${p.z}"><span id="globalLightPosZValue" class="axisValue">${p.z}</span></div>

      <button id="globalLightReset" class="globalLightReset" type="button">Resetar luz geral</button>
      <div class="globalLightHint">Ajusta apenas a iluminação do viewer. Não altera nenhuma luz real do Home Assistant.</div>
    `;

    const cinematic = viewsPanel.querySelector("#cinematicSection");
    const viewGrid = viewsPanel.querySelector(".viewGrid");
    if (cinematic?.nextSibling) viewsPanel.insertBefore(section, cinematic.nextSibling);
    else if (viewGrid) viewsPanel.insertBefore(section, viewGrid);
    else viewsPanel.prepend(section);

    section.querySelector("#globalLightSlider")?.addEventListener("input", (event) => {
      this._globalLightPct = clamp(event.target.value, 0, 100);
      this._applyGlobalLightSettings?.(true);
    });

    section.querySelector("#globalLightTemperature")?.addEventListener("input", (event) => {
      this._globalLightKelvin = clamp(event.target.value, 2000, 10000);
      this._applyGlobalLightSettings?.(true);
    });

    for (const axis of ["x", "y", "z"]) {
      const id = `#globalLightPos${axis.toUpperCase()}`;
      section.querySelector(id)?.addEventListener("input", (event) => {
        this._globalLightPosition[axis] = clamp(event.target.value, -100, 100);
        this._applyGlobalLightSettings?.(true);
      });
    }

    section.querySelector("#globalLightReset")?.addEventListener("click", () => {
      this._globalLightPct = DEFAULT_GLOBAL_LIGHT.intensity;
      this._globalLightKelvin = DEFAULT_GLOBAL_LIGHT.kelvin;
      this._globalLightPosition = {
        x: DEFAULT_GLOBAL_LIGHT.x,
        y: DEFAULT_GLOBAL_LIGHT.y,
        z: DEFAULT_GLOBAL_LIGHT.z,
      };
      this._applyGlobalLightSettings?.(true);
    });

    this._applyGlobalLightSettings?.(false);
  };

  // Also handle the case where this module finishes loading after the panel
  // has already connected. This avoids requiring a Home Assistant restart.
  queueMicrotask(() => {
    document.querySelectorAll("ha3d-lab-panel").forEach((panel) => {
      installAndApplySceneControls(panel);
    });
  });
}
