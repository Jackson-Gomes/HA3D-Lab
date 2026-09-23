import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const MEDIA_BLUE = new THREE.Color(0x3a7bff);
const MEDIA_PURPLE_BLUE = new THREE.Color(0x754dff);

function effectiveState(panel, config) {
  if (config?.entity_id) {
    const state = panel?._hass?.states?.[config.entity_id];
    if (!state || state.state === "unknown" || state.state === "unavailable") return { on: false, brightness: 1 };
    const brightness = Number(state.attributes?.brightness);
    return {
      on: state.state === "on",
      brightness: Number.isFinite(brightness) ? Math.max(0, Math.min(1, brightness / 255)) : 1,
    };
  }
  return { on: config?.enabled !== false, brightness: 1 };
}

function updateEffects(panel, timeMs) {
  const t = Number(timeMs || 0) * 0.001;

  for (const runtime of panel?._ha3dVirtualLights?.values?.() || []) {
    const config = runtime?.config;
    const light = runtime?.light;
    if (!config || !light || !light.isSpotLight || config.effect !== "tv_flicker") continue;

    const state = effectiveState(panel, config);
    if (!state.on) {
      light.intensity = 0;
      continue;
    }

    const base = Math.max(0, Number(config.intensity) || 0) * state.brightness;
    if (!(base > 0)) {
      light.intensity = 0;
      continue;
    }

    // Same organic rhythm used by the existing TV effect: a slow color drift
    // plus a faster non-binary intensity modulation so it never looks like a
    // simple blinking light.
    const colorWave = 0.5 + 0.5 * Math.sin(t * 1.45 + 0.35 * Math.sin(t * 0.63));
    const flicker = 0.88 + 0.12 * (0.5 + 0.5 * Math.sin(t * 5.2 + 0.45 * Math.sin(t * 2.1)));

    light.intensity = base * flicker;
    light.color.copy(MEDIA_BLUE).lerp(MEDIA_PURPLE_BLUE, colorWave);
    light.castShadow = Boolean(config.cast_shadow && light.intensity > 0);
  }
}

if (!proto.__ha3dVirtualLightEffectsV1) {
  proto.__ha3dVirtualLightEffectsV1 = true;

  // _updateLightMarkers already runs once per animation frame immediately before
  // render, so piggyback here instead of creating a second render loop.
  const oldUpdateLightMarkers = proto._updateLightMarkers;
  proto._updateLightMarkers = function (...args) {
    const result = oldUpdateLightMarkers?.apply(this, args);
    updateEffects(this, performance.now());
    return result;
  };
}
