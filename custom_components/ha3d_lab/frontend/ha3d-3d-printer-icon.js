const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

if (!proto.__ha3d3dPrinterIconV1) {
  proto.__ha3d3dPrinterIconV1 = true;

  const originalBindEntityMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = originalBindEntityMarkers.apply(this, args);

    for (const [entity, binding] of this._lightBindings?.entries?.() || []) {
      if (!binding?.marker) continue;
      const [domain, objectId = ""] = String(entity || "").toLowerCase().split(".", 2);
      if (domain !== "switch") continue;
      if (/(^|_)(impressora_3d|printer_3d)(_|$)/.test(objectId)) {
        binding.marker.textContent = "🧊";
      }
    }

    return result;
  };
}
