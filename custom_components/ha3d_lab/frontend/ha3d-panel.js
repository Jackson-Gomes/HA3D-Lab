import * as THREE from "https://esm.sh/three@0.180.0";
import { OrbitControls } from "https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js";

const LIGHT_INTENSITY_SCALE = 0.40;
const CUSTOM_VIEWS_KEY = "ha3d_lab_custom_views_v1";

// Compatibility fallback for the original APT0307 GLB.
// Generic models should prefer exact entity_id node names or explicit bindings.
const LEGACY_LIGHTS = [
  { entity: "light.luz_da_sala", match: ["sala"], name: "Luz da Sala" },
  { entity: "light.luz_do_corredor", match: ["corredor"], name: "Luz do corredor" },
  { entity: "light.luz_do_quarto_do_joca", match: ["joca"], name: "Luz do quarto do Joca" },
  { entity: "light.luz_do_escritorio", match: ["escritorio", "escritório"], name: "Luz do escritório" },
  { entity: "light.luz_do_quarto", match: ["quarto"], exclude: ["joca"], name: "Luz do Quarto" },
  { entity: "light.luz_da_tv", match: ["tv"], name: "Luz da TV" },
  { entity: "light.escritorio_tomada_escritorio_socket_1", match: ["abajur"], name: "Abajur escritório" },
];

function normalizeName(value) {
  return (value || "")
    .replace(/^LightNode_/, "")
    .replaceAll("_", " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function ease(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

class HA3DPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._panel = null;
    this._config = null;
    this._model = null;
    this._modelLights = [];
    this._objectsByEntity = new Map();
    this._lightBindings = new Map();
    this._boundCount = 0;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._resizeObserver = null;
    this._initialized = false;
    this._cameraAnimating = false;
    this._customViews = this._readCustomViews();
  }

  set hass(value) {
    this._hass = value;
    if (this.isConnected) {
      this._updateAdminUi();
      this._syncLightStates();
    }
  }

  get hass() {
    return this._hass;
  }

  set panel(value) {
    this._panel = value;
  }

  set narrow(_value) {}
  set route(_value) {}

  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this._renderShell();
    this._initViewer();
    this._wireUi();
    this._renderCustomViews();
    this._waitForHassAndLoad();
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._renderer?.setAnimationLoop(null);
    this._renderer?.dispose();
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;width:100%;height:100%;min-height:100vh;background:#111;color:var(--primary-text-color,#fff);font-family:var(--paper-font-body1_-_font-family,system-ui,sans-serif);overflow:hidden}
        *{box-sizing:border-box}#root{position:relative;width:100%;height:100vh;overflow:hidden}#stage{position:absolute;inset:0}
        canvas{display:block;width:100%;height:100%;touch-action:none}
        #topbar{position:absolute;top:max(12px,env(safe-area-inset-top));left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));display:flex;align-items:center;gap:10px;z-index:20;pointer-events:none}
        .glass{background:color-mix(in srgb,var(--card-background-color,#15171d) 88%,transparent);border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 35px rgba(0,0,0,.28);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
        #brand{pointer-events:auto;min-width:0;padding:10px 14px;border-radius:14px;display:flex;align-items:baseline;gap:10px}
        #brand strong{font-size:15px;letter-spacing:.02em}#status{opacity:.7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #actions{margin-left:auto;display:flex;gap:8px;pointer-events:auto}
        button{appearance:none;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 13px;background:color-mix(in srgb,var(--primary-color,#03a9f4) 82%,#111);color:#fff;font:inherit;font-weight:600;cursor:pointer}
        button.secondary{background:rgba(30,32,39,.88)}button:disabled{opacity:.45;cursor:default}
        #empty{position:absolute;inset:0;display:grid;place-items:center;z-index:10;pointer-events:none}
        #emptyCard{width:min(520px,calc(100vw - 36px));padding:28px;border-radius:22px;text-align:center;pointer-events:auto}
        #emptyCard h2{margin:0 0 8px;font-size:22px}#emptyCard p{margin:0 0 18px;opacity:.72;line-height:1.45}#emptyCard code{font-size:12px;opacity:.9}
        #markers{position:absolute;inset:0;z-index:12;pointer-events:none}
        .lightMarker{position:absolute;width:34px;height:34px;min-height:34px;padding:0;border-radius:50%;transform:translate(-50%,-50%);font-size:18px;background:#202020e8;border:1px solid #666;color:#bbb;box-shadow:0 3px 12px #0008;backdrop-filter:blur(6px);pointer-events:auto}
        .lightMarker.on{background:#f3c94be8;border-color:#ffe993;color:#111;box-shadow:0 0 14px #ffd84f99}.lightMarker.unavailable{border-color:#a34b42;color:#ffb1a8}
        #viewsPanel{display:none;position:absolute;top:max(66px,calc(env(safe-area-inset-top) + 58px));right:max(12px,env(safe-area-inset-right));z-index:30;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:16px}
        #viewsPanel.open{display:block}.viewsTitle{font-size:14px;font-weight:700;margin:1px 2px 10px}.viewGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.viewGrid button{background:#24262c;font-size:12px;min-height:38px;padding:7px 8px}.saveView{width:100%;margin-top:9px;background:#18304a}.customViews{display:grid;gap:7px;margin-top:9px}.customRow{display:grid;grid-template-columns:1fr auto;gap:6px}.customRow button:first-child{text-align:left;background:#24262c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.customRow button:last-child{width:40px;padding:0;background:#3a2424}
        #meta{position:absolute;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:15;padding:8px 10px;border-radius:12px;font-size:11px;opacity:.75;pointer-events:none}
        input[type=file]{display:none}
        @media(max-width:600px){#brand{max-width:42vw}#brand strong{font-size:14px}#status{display:none}#actions button{padding:10px 11px}#meta{display:none}}
      </style>
      <div id="root">
        <div id="stage"></div>
        <div id="markers"></div>
        <div id="topbar">
          <div id="brand" class="glass"><strong>HA3D</strong><span id="status">Iniciando…</span></div>
          <div id="actions">
            <button id="viewsButton" class="secondary" type="button">Vistas</button>
            <button id="uploadButton" type="button">Subir GLB</button>
            <input id="fileInput" type="file" accept=".glb,model/gltf-binary">
          </div>
        </div>
        <div id="viewsPanel" class="glass">
          <div class="viewsTitle">Vistas da câmera</div>
          <div class="viewGrid">
            <button data-view="default" type="button">Padrão</button>
            <button data-view="top" type="button">Superior</button>
            <button data-view="a1" type="button">Ângulo 1</button>
            <button data-view="a2" type="button">Ângulo 2</button>
            <button data-view="a3" type="button">Ângulo 3</button>
            <button data-view="a4" type="button">Ângulo 4</button>
            <button data-view="low" type="button">Baixa</button>
          </div>
          <button id="saveViewButton" class="saveView" type="button">Salvar vista atual</button>
          <div id="customViews" class="customViews"></div>
        </div>
        <div id="empty"><div id="emptyCard" class="glass"><h2>Seu Home Assistant em 3D</h2><p>Suba um arquivo GLB. Objetos cujo nome seja um <code>entity_id</code> existente serão vinculados automaticamente.</p><button id="emptyUploadButton" type="button">Escolher GLB</button></div></div>
        <div id="meta" class="glass">0 vínculos</div>
      </div>
    `;
  }

  _initViewer() {
    const stage = this.shadowRoot.querySelector("#stage");
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x111111);
    this._camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    this._camera.position.set(7, 7, 7);

    this._renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 0.95;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(this._renderer.domElement);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;

    const ambient = new THREE.HemisphereLight(0xfff4e6, 0x556070, 0.55);
    ambient.castShadow = false;
    this._scene.add(ambient);

    this._loader = new GLTFLoader();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(stage);
    this._resize();

    this._renderer.setAnimationLoop(() => {
      if (!this._cameraAnimating) this._controls.update();
      this._updateLightMarkers();
      this._renderer.render(this._scene, this._camera);
    });
  }

  _wireUi() {
    const fileInput = this.shadowRoot.querySelector("#fileInput");
    const choose = () => fileInput.click();
    this.shadowRoot.querySelector("#uploadButton").addEventListener("click", choose);
    this.shadowRoot.querySelector("#emptyUploadButton").addEventListener("click", choose);
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) await this._uploadModel(file);
    });

    const viewsPanel = this.shadowRoot.querySelector("#viewsPanel");
    this.shadowRoot.querySelector("#viewsButton").addEventListener("click", (event) => {
      event.stopPropagation();
      viewsPanel.classList.toggle("open");
    });
    this.shadowRoot.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => this._applyCameraView(button.dataset.view));
    });
    this.shadowRoot.querySelector("#saveViewButton").addEventListener("click", () => this._saveCurrentView());
    this.shadowRoot.querySelector("#root").addEventListener("pointerdown", (event) => {
      if (!viewsPanel.contains(event.target) && event.target.id !== "viewsButton") viewsPanel.classList.remove("open");
    });

    this._renderer.domElement.addEventListener("click", (event) => this._pick(event));
    this._updateAdminUi();
  }

  async _waitForHassAndLoad() {
    for (let i = 0; i < 100 && !this._hass; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!this._hass) {
      this._setStatus("Home Assistant indisponível");
      return;
    }
    await this._loadConfig();
  }

  async _loadConfig() {
    try {
      this._setStatus("Lendo configuração…");
      this._config = await this._hass.callApi("GET", "ha3d_lab_lab/config");
      if (this._config?.model_url) await this._loadModel(this._versionedModelUrl(this._config.model_url, this._config.model_revision));
      else {
        this._showEmpty(true);
        this._setStatus("Envie um modelo GLB");
      }
    } catch (error) {
      console.error("[HA3D] config", error);
      this._showEmpty(true);
      this._setStatus("Erro ao carregar configuração");
    }
  }

  async _uploadModel(file) {
    if (!this._hass?.user?.is_admin) return;
    if (!file.name.toLowerCase().endsWith(".glb")) {
      this._setStatus("Selecione um arquivo .glb");
      return;
    }
    const form = new FormData();
    form.append("file", file, file.name);
    this._setStatus(`Enviando ${file.name}…`);
    this._setUploadEnabled(false);
    try {
      const response = await this._hass.fetchWithAuth("/api/ha3d_lab/model", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this._config = { ...(this._config || {}), model_url: result.model_url, model_revision: result.model_revision };
      await this._loadModel(this._versionedModelUrl(result.model_url, result.model_revision));
    } catch (error) {
      console.error("[HA3D] upload", error);
      this._setStatus(`Falha no upload: ${error.message || error}`);
    } finally {
      this._setUploadEnabled(true);
    }
  }

  _versionedModelUrl(url, revision) {
    if (!url || !revision) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(revision)}`;
  }

  async _loadModel(url) {
    this._setStatus("Carregando modelo 3D…");
    const gltf = await this._loader.loadAsync(url);
    if (this._model) this._scene.remove(this._model);
    this._clearMarkers();

    this._model = gltf.scene;
    this._collectModelLights(this._model);
    this._scene.add(this._model);

    // Preserve every exported GLB material and texture.
    this._model.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    this._indexBindings();
    this._fit(this._model);
    this._bindModelLights();
    this._bindEntityLightMarkers();
    this._restoreUnboundModelLights();
    this._syncLightStates();

    this._showEmpty(false);
    this._setStatus(`Pronto · ${this._boundCount} vínculos · ${this._modelLights.length} luzes 3D`);
  }

  _collectModelLights(object) {
    this._modelLights = [];
    object.traverse((light) => {
      if (!light.isLight) return;
      const originalIntensity = Number(light.intensity || 0);
      light.userData.ha3dBaseIntensity = Math.max(0, originalIntensity * LIGHT_INTENSITY_SCALE) || 40;
      light.userData.ha3dOriginalIntensity = originalIntensity;
      light.userData.ha3dOriginalColor = light.color?.clone?.() || new THREE.Color(0xffffff);
      light.userData.ha3dOriginalCastShadow = Boolean(light.castShadow);
      light.userData.ha3dBaseDistance = Number(light.distance || 0);
      light.intensity = 0;
      light.castShadow = false;
      this._modelLights.push(light);
    });
  }

  _indexBindings() {
    this._objectsByEntity.clear();
    this._boundCount = 0;
    const explicit = this._config?.bindings || {};
    const autoBind = this._config?.auto_bind !== false;
    const states = this._hass?.states || {};

    this._model?.traverse((object) => {
      if (!object.name) return;
      const entityId = explicit[object.name] || (autoBind && states[object.name] ? object.name : null);
      if (!entityId || !states[entityId]) return;
      object.userData.ha3dEntityId = entityId;
      if (!this._objectsByEntity.has(entityId)) {
        this._objectsByEntity.set(entityId, []);
        this._boundCount += 1;
      }
      this._objectsByEntity.get(entityId).push(object);
    });
  }

  _directLightMapping(light) {
    const states = this._hass?.states || {};
    const explicit = this._config?.bindings || {};
    let node = light;
    while (node && node !== this._model?.parent) {
      const name = node.name;
      if (name) {
        const lightNodeEntity = name.startsWith("LightNode_") ? name.slice("LightNode_".length) : null;
        const entityId = explicit[name] || (states[name] ? name : null) || (lightNodeEntity && states[lightNodeEntity] ? lightNodeEntity : null);
        if (entityId && states[entityId]) {
          return { entity: entityId, name: states[entityId].attributes?.friendly_name || entityId };
        }
      }
      if (node === this._model) break;
      node = node.parent;
    }
    return null;
  }

  _mappingForLight(light) {
    const direct = this._directLightMapping(light);
    if (direct) return direct;

    const states = this._hass?.states || {};
    const name = normalizeName(light.name);

    // Scene/global lights are visual lighting, not Home Assistant entities.
    if (/(global|geral|ambient|ambiente|world|mundo|sun|sol)/.test(name)) return null;

    for (const map of LEGACY_LIGHTS) {
      const matches = map.match.some((token) => name.includes(normalizeName(token)));
      const excluded = (map.exclude || []).some((token) => name.includes(normalizeName(token)));
      if (matches && !excluded && states[map.entity]) return map;
    }
    return null;
  }

  _makeLightMarker(entity, name, anchor, light = null) {
    if (this._lightBindings.has(entity)) {
      const binding = this._lightBindings.get(entity);
      if (light && !binding.lights.includes(light)) binding.lights.push(light);
      return binding;
    }
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "lightMarker";
    marker.textContent = "💡";
    marker.title = name;
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      this._openNativeMoreInfo(entity);
    });
    this.shadowRoot.querySelector("#markers").appendChild(marker);
    const binding = { entity, name, anchor, light, lights: light ? [light] : [], marker };
    this._lightBindings.set(entity, binding);
    return binding;
  }

  _bindModelLights() {
    const counted = new Set(this._objectsByEntity.keys());
    for (const light of this._modelLights) {
      const map = this._mappingForLight(light);
      if (!map) continue;
      const existing = this._lightBindings.get(map.entity);
      if (existing) {
        if (!existing.lights.includes(light)) existing.lights.push(light);
        existing.light ||= light;
      } else {
        this._makeLightMarker(map.entity, map.name, light, light);
      }
      if (!counted.has(map.entity)) {
        counted.add(map.entity);
        this._boundCount += 1;
      }
    }
  }

  _bindEntityLightMarkers() {
    const states = this._hass?.states || {};
    for (const [entity, objects] of this._objectsByEntity.entries()) {
      if (!entity.startsWith("light.") || this._lightBindings.has(entity) || !objects.length) continue;
      this._makeLightMarker(entity, states[entity]?.attributes?.friendly_name || entity, objects[0], null);
    }
    this.shadowRoot.querySelector("#meta").textContent = `${this._boundCount} vínculos`;
  }

  _restoreUnboundModelLights() {
    const boundLights = new Set(
      [...this._lightBindings.values()].flatMap((binding) => binding.lights || []).filter(Boolean),
    );
    for (const light of this._modelLights) {
      if (boundLights.has(light)) continue;
      light.intensity = light.userData.ha3dBaseIntensity || 0;
      light.color.copy(light.userData.ha3dOriginalColor || new THREE.Color(0xffffff));
      light.castShadow = Boolean(light.userData.ha3dOriginalCastShadow);
    }
  }

  _syncLightStates() {
    if (!this._hass || !this._lightBindings.size) return;
    for (const binding of this._lightBindings.values()) {
      const state = this._hass.states?.[binding.entity];
      if (!state) continue;
      const attrs = state.attributes || {};
      const unavailable = state.state === "unavailable" || state.state === "unknown";
      const on = state.state === "on";
      const brightness = Number.isFinite(Number(attrs.brightness)) ? Number(attrs.brightness) : 255;

      for (const light of binding.lights || []) {
        const base = light.userData.ha3dBaseIntensity || 1;
        light.intensity = on && !unavailable ? base * Math.max(0.05, brightness / 255) : 0;
        const rgb = attrs.rgb_color;
        const hs = attrs.hs_color;
        if (Array.isArray(rgb) && rgb.length >= 3) {
          light.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        } else if (Array.isArray(hs) && hs.length >= 2) {
          light.color.setHSL((((Number(hs[0]) % 360) + 360) % 360) / 360, Math.max(0, Math.min(100, Number(hs[1]))) / 100, 0.5);
        } else {
          light.color.copy(light.userData.ha3dOriginalColor || new THREE.Color(0xffffff));
        }
        light.castShadow = on && !unavailable;
        if (light.castShadow && light.shadow) {
          light.shadow.mapSize.set(512, 512);
          light.shadow.bias = -0.0005;
          light.shadow.normalBias = 0.05;
        }
      }

      binding.marker.classList.toggle("on", on && !unavailable);
      binding.marker.classList.toggle("unavailable", unavailable);
      binding.marker.title = unavailable ? `${binding.name} — indisponível` : binding.name;
    }
  }

  _updateLightMarkers() {
    if (!this._lightBindings.size || !this._camera) return;
    const stage = this.shadowRoot.querySelector("#stage");
    const point = new THREE.Vector3();
    for (const binding of this._lightBindings.values()) {
      binding.anchor.getWorldPosition(point);
      point.project(this._camera);
      const visible = point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1.15 && Math.abs(point.y) <= 1.15;
      binding.marker.style.visibility = visible ? "visible" : "hidden";
      if (!visible) continue;
      binding.marker.style.left = `${(point.x * 0.5 + 0.5) * stage.clientWidth}px`;
      binding.marker.style.top = `${(-point.y * 0.5 + 0.5) * stage.clientHeight}px`;
    }
  }

  _clearMarkers() {
    this._lightBindings.clear();
    const markers = this.shadowRoot?.querySelector("#markers");
    if (markers) markers.innerHTML = "";
  }

  _pick(event) {
    if (!this._model) return;
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const hit = this._raycaster.intersectObject(this._model, true)[0]?.object;
    let node = hit;
    while (node && !node.userData?.ha3dEntityId) node = node.parent;
    if (node?.userData?.ha3dEntityId) this._openNativeMoreInfo(node.userData.ha3dEntityId);
  }

  _openNativeMoreInfo(entityId) {
    if (!entityId) return;
    const detail = { entityId };
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail, bubbles: true, composed: true }));

    // Fallback for HA builds where the panel event is not caught above the shadow root.
    try {
      const root = document.querySelector("home-assistant");
      if (root) root.dispatchEvent(new CustomEvent("hass-more-info", { detail, bubbles: true, composed: true }));
    } catch (_error) {}
  }

  _fit(object) {
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z) || 1;
    this._controls.target.copy(center);
    this._camera.near = Math.max(max / 10000, 0.01);
    this._camera.far = max * 50;
    this._camera.position.set(center.x + max * 0.75, center.y + max * 0.75, center.z + max * 0.75);
    this._camera.up.set(0, 1, 0);
    this._camera.updateProjectionMatrix();
    this._controls.update();
    this._defaultView = this._captureCameraView();
  }

  _captureCameraView() {
    return {
      position: [this._camera.position.x, this._camera.position.y, this._camera.position.z],
      target: [this._controls.target.x, this._controls.target.y, this._controls.target.z],
      up: [this._camera.up.x, this._camera.up.y, this._camera.up.z],
    };
  }

  _applyCameraView(name) {
    if (!this._model || this._cameraAnimating) return;
    if (name === "default" && this._defaultView) {
      this._animateCameraTo(this._defaultView);
      return;
    }

    const box = new THREE.Box3().setFromObject(this._model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z) || 1;
    const presets = {
      top: { az: 0, el: 89, dist: 1.48, up: [0, 0, -1] },
      a1: { az: 35, el: 43, dist: 1.26 },
      a2: { az: 125, el: 43, dist: 1.26 },
      a3: { az: 215, el: 43, dist: 1.26 },
      a4: { az: 305, el: 43, dist: 1.26 },
      low: { az: 35, el: 27, dist: 1.18 },
    };
    const preset = presets[name];
    if (!preset) return;
    const az = THREE.MathUtils.degToRad(preset.az);
    const el = THREE.MathUtils.degToRad(preset.el);
    const r = max * preset.dist;
    const position = center.clone().add(new THREE.Vector3(Math.cos(el) * Math.cos(az) * r, Math.sin(el) * r, Math.cos(el) * Math.sin(az) * r));
    this._animateCameraTo({ position: position.toArray(), target: center.toArray(), up: preset.up || [0, 1, 0] });
  }

  _animateCameraTo(view, duration = 900) {
    if (!view?.position || !view?.target || this._cameraAnimating) return;
    const startPos = this._camera.position.clone();
    const startTarget = this._controls.target.clone();
    const startUp = this._camera.up.clone();
    const targetPos = new THREE.Vector3(...view.position);
    const targetTarget = new THREE.Vector3(...view.target);
    const targetUp = new THREE.Vector3(...(view.up || [0, 1, 0]));
    const started = performance.now();
    const oldDamping = this._controls.enableDamping;
    this._cameraAnimating = true;
    this._controls.enabled = false;
    this._controls.enableDamping = false;

    const frame = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const u = ease(t);
      this._camera.position.lerpVectors(startPos, targetPos, u);
      this._controls.target.lerpVectors(startTarget, targetTarget, u);
      this._camera.up.lerpVectors(startUp, targetUp, u).normalize();
      this._camera.lookAt(this._controls.target);
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      this._camera.position.copy(targetPos);
      this._controls.target.copy(targetTarget);
      this._camera.up.copy(targetUp);
      this._camera.lookAt(this._controls.target);
      this._controls.enabled = true;
      this._controls.enableDamping = oldDamping;
      this._cameraAnimating = false;
      this._controls.update();
    };
    requestAnimationFrame(frame);
  }

  _readCustomViews() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CUSTOM_VIEWS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  _saveCurrentView() {
    if (!this._model) return;
    const name = `Vista ${this._customViews.length + 1}`;
    this._customViews.push({ id: `${Date.now()}`, name, view: this._captureCameraView() });
    localStorage.setItem(CUSTOM_VIEWS_KEY, JSON.stringify(this._customViews));
    this._renderCustomViews();
  }

  _renderCustomViews() {
    const host = this.shadowRoot?.querySelector("#customViews");
    if (!host) return;
    host.innerHTML = "";
    for (const saved of this._customViews) {
      const row = document.createElement("div");
      row.className = "customRow";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = saved.name;
      open.addEventListener("click", () => this._animateCameraTo(saved.view));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Excluir vista";
      remove.addEventListener("click", () => {
        this._customViews = this._customViews.filter((item) => item.id !== saved.id);
        localStorage.setItem(CUSTOM_VIEWS_KEY, JSON.stringify(this._customViews));
        this._renderCustomViews();
      });
      row.append(open, remove);
      host.appendChild(row);
    }
  }

  _resize() {
    if (!this._renderer) return;
    const stage = this.shadowRoot.querySelector("#stage");
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(width, height, false);
  }

  _updateAdminUi() {
    if (!this.shadowRoot) return;
    const isAdmin = Boolean(this._hass?.user?.is_admin);
    this.shadowRoot.querySelector("#uploadButton").style.display = isAdmin ? "inline-block" : "none";
    this.shadowRoot.querySelector("#emptyUploadButton").style.display = isAdmin ? "inline-block" : "none";
  }

  _setUploadEnabled(enabled) {
    for (const selector of ["#uploadButton", "#emptyUploadButton"]) {
      const button = this.shadowRoot.querySelector(selector);
      if (button) button.disabled = !enabled;
    }
  }

  _showEmpty(show) {
    this.shadowRoot.querySelector("#empty").style.display = show ? "grid" : "none";
  }

  _setStatus(text) {
    const node = this.shadowRoot?.querySelector("#status");
    if (node) node.textContent = text;
  }
}

// Extension modules must use this exact Three.js module instance. Mixing two
// module instances makes Object3D.add reject otherwise valid objects.
HA3DPanel.HA3D_THREE = THREE;

if (!customElements.get("ha3d-lab-panel")) customElements.define("ha3d-lab-panel", HA3DPanel);
