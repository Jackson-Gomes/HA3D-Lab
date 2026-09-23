import * as THREE from "https://esm.sh/three@0.180.0";
import "./ha3d-ui.js";

const GRAPHICS_QUALITY_KEY = "ha3d_lab_texture_quality_pct_v1";
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function readQuality() {
  const saved = Number(localStorage.getItem(GRAPHICS_QUALITY_KEY));
  return Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 100;
}

function ensureGraphicsState(panel) {
  if (panel._ha3dGraphicsReady) return;
  panel._ha3dGraphicsReady = true;
  panel._graphicsQuality = readQuality();
  panel._graphicsTextureGroups = [];
}

function meshTextureScore(mesh) {
  try {
    const geometry = mesh.geometry;
    if (!geometry) return 1;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const size = geometry.boundingBox?.getSize(new THREE.Vector3()) || new THREE.Vector3(1, 1, 1);
    const worldScale = mesh.getWorldScale(new THREE.Vector3(1, 1, 1));
    size.multiply(worldScale);
    const xy = Math.abs(size.x * size.y);
    const xz = Math.abs(size.x * size.z);
    const yz = Math.abs(size.y * size.z);
    return Math.max(xy, xz, yz, size.length(), 0.0001);
  } catch (_error) {
    return 1;
  }
}

if (!proto.__ha3dGraphicsPatchedV2) {
  proto.__ha3dGraphicsPatchedV2 = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    ensureGraphicsState(this);
    originalConnectedCallback.call(this);
    queueMicrotask(() => this._installGraphicsControls?.());
  };

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: true,
      enumerable: hassDescriptor.enumerable,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        queueMicrotask(() => this._installGraphicsControls?.());
      },
    });
  }

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    ensureGraphicsState(this);
    const result = await originalLoadModel.apply(this, args);
    this._collectGraphicsTextures?.();
    this._applyGraphicsQuality?.(this._graphicsQuality, false);
    return result;
  };

  proto._installGraphicsControls = function () {
    ensureGraphicsState(this);
    if (!this.shadowRoot || this.shadowRoot.querySelector("#graphicsSection")) return;

    this.shadowRoot.querySelector("#graphicsButton")?.remove();
    this.shadowRoot.querySelector("#graphicsPanel")?.remove();

    const viewsPanel = this.shadowRoot.querySelector("#viewsPanel");
    if (!viewsPanel) return;

    const style = document.createElement("style");
    style.textContent = `
      #graphicsSection{margin:10px 0 11px;padding:11px 1px 12px;border-top:1px solid rgba(255,255,255,.11);border-bottom:1px solid rgba(255,255,255,.11)}
      .graphicsHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
      .graphicsTitle{font-size:13px;font-weight:700}.graphicsValue{font-size:12px;opacity:.72;white-space:nowrap}
      .graphicsSlider{width:100%;accent-color:var(--primary-color,#03a9f4)}
      .graphicsHint{font-size:11px;opacity:.62;line-height:1.4;margin-top:7px}
    `;
    this.shadowRoot.appendChild(style);

    const section = document.createElement("div");
    section.id = "graphicsSection";
    section.innerHTML = `
      <div class="graphicsHeader">
        <span class="graphicsTitle">Qualidade gráfica · Texturas</span>
        <span id="graphicsTextureValue" class="graphicsValue">${this._graphicsQuality}%</span>
      </div>
      <input id="graphicsTextureSlider" class="graphicsSlider" type="range" min="0" max="100" step="5" value="${this._graphicsQuality}">
      <div id="graphicsTextureStatus" class="graphicsHint">Aguardando modelo 3D…</div>
      <div class="graphicsHint">100% mantém todas as texturas. Reduza para aliviar memória e GPU em celulares e TVs.</div>
    `;

    const saveButton = viewsPanel.querySelector("#saveViewButton");
    if (saveButton) viewsPanel.insertBefore(section, saveButton);
    else viewsPanel.appendChild(section);

    const slider = section.querySelector("#graphicsTextureSlider");
    slider?.addEventListener("input", () => {
      this._applyGraphicsQuality?.(Number(slider.value), true);
    });

    this._updateGraphicsUi?.();
  };

  proto._collectGraphicsTextures = function () {
    ensureGraphicsState(this);
    this._graphicsTextureGroups = [];
    if (!this._model) {
      this._updateGraphicsUi?.();
      return;
    }

    const groups = new Map();
    this._model.updateMatrixWorld(true);

    this._model.traverse((mesh) => {
      if (!mesh?.isMesh) return;
      const score = meshTextureScore(mesh);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      for (const material of materials) {
        const texture = material?.map;
        if (!material || !texture) continue;
        const key = texture.source?.uuid || texture.image?.src || texture.uuid;
        if (!key) continue;
        let group = groups.get(key);
        if (!group) {
          group = { key, score: 0, slots: new Map() };
          groups.set(key, group);
        }
        group.score += score;
        if (!group.slots.has(material.uuid)) group.slots.set(material.uuid, { material, texture });
      }
    });

    this._graphicsTextureGroups = [...groups.values()]
      .map((group) => ({ ...group, slots: [...group.slots.values()] }))
      .sort((a, b) => b.score - a.score);

    this._updateGraphicsUi?.();
  };

  proto._applyGraphicsQuality = function (quality, persist = true) {
    ensureGraphicsState(this);
    const pct = Math.max(0, Math.min(100, Math.round(Number(quality) || 0)));
    this._graphicsQuality = pct;
    if (persist) localStorage.setItem(GRAPHICS_QUALITY_KEY, String(pct));

    const groups = this._graphicsTextureGroups || [];
    const enabledCount = pct >= 100 ? groups.length : Math.round(groups.length * pct / 100);

    groups.forEach((group, index) => {
      const enabled = index < enabledCount;
      for (const slot of group.slots) {
        const desired = enabled ? slot.texture : null;
        if (slot.material.map !== desired) {
          slot.material.map = desired;
          slot.material.needsUpdate = true;
        }
      }
    });

    this._updateGraphicsUi?.();
  };

  proto._updateGraphicsUi = function () {
    if (!this.shadowRoot) return;
    const slider = this.shadowRoot.querySelector("#graphicsTextureSlider");
    const value = this.shadowRoot.querySelector("#graphicsTextureValue");
    const status = this.shadowRoot.querySelector("#graphicsTextureStatus");
    if (slider) slider.value = String(this._graphicsQuality ?? 100);
    if (value) value.textContent = `${this._graphicsQuality ?? 100}%`;

    const total = this._graphicsTextureGroups?.length || 0;
    if (!status) return;
    if (!this._model) {
      status.textContent = "Aguardando modelo 3D…";
      return;
    }
    const enabled = (this._graphicsQuality ?? 100) >= 100
      ? total
      : Math.round(total * (this._graphicsQuality ?? 100) / 100);
    status.textContent = `Texturas base ativas: ${enabled}/${total}`;
  };
}
