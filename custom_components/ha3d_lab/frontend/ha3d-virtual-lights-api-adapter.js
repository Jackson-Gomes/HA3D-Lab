const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

if (!proto.__ha3dVirtualLightsApiAdapterV1) {
  proto.__ha3dVirtualLightsApiAdapterV1 = true;
  const oldSaveConfigPatch = proto._saveConfigPatch;

  proto._saveConfigPatch = async function (patch) {
    if (
      patch
      && Object.prototype.hasOwnProperty.call(patch, "virtual_lights")
      && Object.keys(patch).length === 1
    ) {
      this._config = await this._hass.callApi("POST", "ha3d_lab_lab/virtual_lights", patch);
      return this._config;
    }
    return oldSaveConfigPatch?.call(this, patch);
  };
}
