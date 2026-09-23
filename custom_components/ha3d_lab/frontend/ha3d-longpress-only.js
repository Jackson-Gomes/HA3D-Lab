const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

if (!proto.__ha3dLongPressOnlyV1) {
  proto.__ha3dLongPressOnlyV1 = true;

  const oldPick = proto._pick;
  proto._pick = function (event) {
    if (this._robotCalibrationMarker || this._editorMode) return oldPick?.call(this, event);
    // Normal-view geometry is intentionally inert. Selection/editing is owned
    // exclusively by the long-press gesture installed in interaction-gestures.
    return;
  };
}
