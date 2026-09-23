// Scene marker icon override only.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

if (!proto.__ha3dSceneSnowflakeIconV1) {
  proto.__ha3dSceneSnowflakeIconV1 = true;

  const originalBindEntityLightMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindEntityLightMarkers.apply(this, args);

    for (const [entity, binding] of this._lightBindings?.entries?.() || []) {
      if (entity.startsWith("scene.") && binding?.marker) {
        binding.marker.textContent = "❄️";
      }
    }

    return result;
  };
}
