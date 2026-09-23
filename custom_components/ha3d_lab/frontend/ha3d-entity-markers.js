import * as THREE from "https://esm.sh/three@0.180.0";

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const MEDIA_LIGHT_PREFIX = "LightNode_media_player.";
const MEDIA_BLUE = new THREE.Color(0x3a7bff);
const MEDIA_PURPLE_BLUE = new THREE.Color(0x754dff);
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function originalName(object) {
  return object?.userData?.ha3dOriginalNodeName || object?.name || "";
}

function iconForEntity(entity) {
  const [domain, objectId = ""] = String(entity || "").toLowerCase().split(".", 2);

  if (domain === "light") return "💡";

  if (domain === "media_player") {
    if (/(xbox|playstation|console|game|gaming)/.test(objectId)) return "🎮";
    if (/(alexa|echo|speaker|som|audio)/.test(objectId)) return "🔊";
    if (/(tv|televis|television)/.test(objectId)) return "📺";
    return "▶️";
  }

  if (domain === "switch") {
    if (/(impressora|printer)/.test(objectId)) return "🖨️";
    if (/(xbox|playstation|console|game|gaming)/.test(objectId)) return "🎮";
    return "🔌";
  }

  const domainIcons = {
    vacuum: "🤖",
    climate: "❄️",
    camera: "📷",
    binary_sensor: "📡",
    sensor: "📊",
    lock: "🔒",
    cover: "🪟",
    fan: "🌀",
    button: "🔘",
    script: "▶️",
    automation: "⚙️",
    device_tracker: "📍",
    person: "👤",
    weather: "🌤️",
    alarm_control_panel: "🚨",
  };

  return domainIcons[domain] || "🔘";
}

function rememberOriginalNames(gltf) {
  gltf?.scene?.traverse((object) => {
    const association = gltf.parser?.associations?.get(object);
    const nodeIndex = association?.nodes;
    const nodeName = Number.isInteger(nodeIndex)
      ? gltf.parser?.json?.nodes?.[nodeIndex]?.name
      : null;
    if (nodeName) object.userData.ha3dOriginalNodeName = nodeName;
  });
}

function mediaEntityForLight(light) {
  let node = light;
  while (node) {
    const name = originalName(node);
    if (name.startsWith(MEDIA_LIGHT_PREFIX)) {
      const entity = name.slice("LightNode_".length);
      return ENTITY_ID.test(entity) ? entity : null;
    }
    node = node.parent;
  }
  return null;
}

if (!proto.__ha3dExactEntityMarkersV1) {
  proto.__ha3dExactEntityMarkersV1 = true;

  // Preserve the original glTF node name because GLTFLoader may sanitize the
  // Object3D name used internally by Three.js.
  const originalInitViewer = proto._initViewer;
  proto._initViewer = function (...args) {
    const result = originalInitViewer.apply(this, args);
    const loader = this._loader;
    if (loader?.loadAsync && !loader.__ha3dExactNameHook) {
      loader.__ha3dExactNameHook = true;
      const loadAsync = loader.loadAsync.bind(loader);
      loader.loadAsync = async (...loadArgs) => {
        const gltf = await loadAsync(...loadArgs);
        rememberOriginalNames(gltf);
        return gltf;
      };
    }

    // Run the lightweight media glow immediately before each existing render.
    // This leaves the proven animation loop untouched.
    const renderer = this._renderer;
    if (renderer?.render && !renderer.__ha3dMediaFxHook) {
      renderer.__ha3dMediaFxHook = true;
      const render = renderer.render.bind(renderer);
      renderer.render = (...renderArgs) => {
        this._updateMediaLightFx?.(performance.now());
        return render(...renderArgs);
      };
    }
    return result;
  };

  // Keep the existing GLB-light collection logic, adding only a media tag for
  // lights whose original glTF node is LightNode_media_player.<entity_id>.
  const originalCollectModelLights = proto._collectModelLights;
  proto._collectModelLights = function (...args) {
    const result = originalCollectModelLights.apply(this, args);
    for (const light of this._modelLights || []) {
      const entity = mediaEntityForLight(light);
      if (!entity) continue;
      light.userData.ha3dMediaFx = true;
      light.userData.ha3dMediaEntityId = entity;
      light.userData.ha3dMediaBaseIntensity = Number(light.userData.ha3dBaseIntensity || light.intensity || 0);
    }
    return result;
  };

  proto._updateMediaLightFx = function (timeMs) {
    if (!this._modelLights?.length) return;
    const t = Number(timeMs || 0) * 0.001;

    for (const light of this._modelLights) {
      if (!light.userData?.ha3dMediaFx) continue;

      const entity = light.userData.ha3dMediaEntityId;
      const state = this._hass?.states?.[entity];
      const unavailable = state && (state.state === "unavailable" || state.state === "unknown");
      const off = state?.state === "off";

      if (unavailable || off) {
        light.intensity = 0;
        continue;
      }

      const base = Number(light.userData.ha3dMediaBaseIntensity || light.userData.ha3dBaseIntensity || 0);
      if (!(base > 0)) continue;

      // Two slow waves keep the effect organic instead of looking like a blink.
      const colorWave = 0.5 + 0.5 * Math.sin(t * 1.45 + 0.35 * Math.sin(t * 0.63));
      const flicker = 0.88 + 0.12 * (0.5 + 0.5 * Math.sin(t * 5.2 + 0.45 * Math.sin(t * 2.1)));

      light.intensity = base * flicker;
      light.color.copy(MEDIA_BLUE).lerp(MEDIA_PURPLE_BLUE, colorWave);
    }
  };

  // Keep every existing binding behavior, then add only exact entity_id node
  // names. The entity does not need to be present in hass.states yet; this lets
  // Home Assistant finish loading after the GLB without losing the anchor.
  const originalIndexBindings = proto._indexBindings;
  proto._indexBindings = function (...args) {
    originalIndexBindings.apply(this, args);

    const explicit = this._config?.bindings || {};
    const autoBind = this._config?.auto_bind !== false;

    this._model?.traverse((object) => {
      const name = originalName(object);
      if (!name) return;

      const mapped = explicit[name] || explicit[object.name];
      const entity = mapped || (autoBind && ENTITY_ID.test(name) ? name : null);
      if (!entity || !ENTITY_ID.test(entity)) return;

      object.userData.ha3dEntityId = entity;
      if (!this._objectsByEntity.has(entity)) this._objectsByEntity.set(entity, []);
      const objects = this._objectsByEntity.get(entity);
      if (!objects.includes(object)) objects.push(object);
    });

    this._boundCount = this._objectsByEntity.size;
  };

  // Reuse the proven circular marker, changing only the emoji according to the
  // entity domain. Specific device names refine media_player/switch where useful.
  const originalBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindMarkers.apply(this, args);
    const states = this._hass?.states || {};

    for (const [entity, objects] of this._objectsByEntity.entries()) {
      if (!states[entity] || !objects.length) continue;

      if (!this._lightBindings.has(entity)) {
        this._makeLightMarker(
          entity,
          states[entity].attributes?.friendly_name || entity,
          objects[0],
          null,
        );
      }

      const binding = this._lightBindings.get(entity);
      if (binding?.marker) binding.marker.textContent = iconForEntity(entity);
    }

    this._boundCount = this._lightBindings.size;
    const meta = this.shadowRoot?.querySelector("#meta");
    if (meta) meta.textContent = `${this._boundCount} vínculos`;
    return result;
  };

  // HA sends a new hass object whenever states change. If a matching entity was
  // not available on the first frame, create its marker as soon as it appears.
  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: hassDescriptor.configurable ?? true,
      enumerable: hassDescriptor.enumerable ?? false,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        if (!this.isConnected || !this._model) return;
        this._bindEntityLightMarkers?.();
        this._syncLightStates?.();
      },
    });
  }
}
