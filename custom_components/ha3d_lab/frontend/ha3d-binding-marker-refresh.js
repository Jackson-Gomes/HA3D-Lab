import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function advancedConfigForRoot(panel, root, entityId) {
  const key = objectKey(root);
  const direct = panel?._config?.advanced_bindings?.[key];
  if (direct?.entity_id === entityId) return direct;
  return Object.values(panel?._config?.advanced_bindings || {})
    .find((config) => config?.entity_id === entityId) || null;
}

function findAnchor(panel, key, config = null) {
  const wanted = String(config?.anchor || key || "").trim();
  if (!wanted || !panel?._model) return null;
  let found = null;
  panel._model.traverse((object) => {
    if (found) return;
    const original = String(object?.userData?.ha3dOriginalNodeName || "").trim();
    const current = String(object?.name || "").trim();
    if (original === wanted || current === wanted) found = object;
  });
  return found;
}

function prioritizeRootForEntity(panel, root, entityId) {
  if (!root || !entityId || !panel?._objectsByEntity) return;

  // A manual binding is authoritative for the selected logical object. Remove
  // that root from any previous entity bucket, then place it first in the new
  // bucket so marker creation uses it as the visual anchor.
  for (const [entity, objects] of [...panel._objectsByEntity.entries()]) {
    const filtered = (objects || []).filter((object) => object !== root);
    if (filtered.length) panel._objectsByEntity.set(entity, filtered);
    else panel._objectsByEntity.delete(entity);
  }

  root.userData ||= {};
  root.userData.ha3dEntityId = entityId;
  const current = panel._objectsByEntity.get(entityId) || [];
  panel._objectsByEntity.set(entityId, [root, ...current.filter((object) => object !== root)]);
  panel._boundCount = panel._objectsByEntity.size;
}

function useVisualCenterForMarker(panel, binding, root, entityId, configOverride = null) {
  if (!binding || !root) return;
  const config = configOverride || advancedConfigForRoot(panel, root, entityId);
  binding.anchor = root;
  // GLB pivots are often at 0,0,0 or at a parent origin. The editor marker
  // renderer understands ha3dAnchorBounds and projects the center of the
  // object's world-space bounding box instead of the imported pivot.
  binding.ha3dAnchorBounds = true;
  binding.ha3dMarkerOffset = new THREE.Vector3(...(config?.marker_offset || [0, 0, 0]));
}

function rebuildMarkerSet(panel) {
  panel._clearMarkers?.();
  panel._bindModelLights?.();
  panel._bindEntityLightMarkers?.();
  panel._bindAdvancedMarkers?.();
}

function restorePersistedManualBindings(panel) {
  if (!panel?._model) return;

  // Important: logical roots and secondary assets are annotated by modules that
  // finish after the base model loader. Re-index only now, when the same keys
  // used by the editor are actually present in the runtime scene graph.
  panel._indexBindings?.();
  rebuildMarkerSet(panel);

  // Reapply visual-center anchoring for every persisted advanced binding. This
  // also restores markers that were visible immediately after Save but used to
  // disappear after closing/reopening HA3D because startup indexed too early.
  for (const [key, config] of Object.entries(panel._config?.advanced_bindings || {})) {
    const entityId = String(config?.entity_id || "").trim();
    if (!entityId) continue;
    const root = findAnchor(panel, key, config);
    if (!root) continue;
    const binding = panel._lightBindings?.get?.(entityId);
    if (binding) useVisualCenterForMarker(panel, binding, root, entityId, config);
  }

  panel._syncLightStates?.();
  panel._updateLightMarkers?.();
  const meta = panel.shadowRoot?.querySelector("#meta");
  if (meta) meta.textContent = `${panel._lightBindings?.size || 0} vínculos`;
}

function rebuildMarkersForManualBinding(panel, root, entityId) {
  if (!panel?._model || !root || !entityId) return;

  // Re-run the normal index first so every pre-existing/automatic binding is
  // preserved, then make the freshly saved manual binding the primary anchor.
  panel._indexBindings?.();
  prioritizeRootForEntity(panel, root, entityId);
  rebuildMarkerSet(panel);

  // A light may already have created its marker through LightNode mapping.
  // Manual binding still owns the marker position, so re-anchor it explicitly
  // to the visual center of the selected logical object.
  const binding = panel._lightBindings?.get?.(entityId);
  useVisualCenterForMarker(panel, binding, root, entityId);

  panel._syncLightStates?.();
  panel._updateLightMarkers?.();
  const meta = panel.shadowRoot?.querySelector("#meta");
  if (meta) meta.textContent = `${panel._lightBindings?.size || 0} vínculos`;
}

if (!proto.__ha3dBindingMarkerRefreshV3) {
  proto.__ha3dBindingMarkerRefreshV3 = true;

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    restorePersistedManualBindings(this);
    return result;
  };

  const oldSaveEditorBinding = proto._saveEditorBinding;
  proto._saveEditorBinding = async function (...args) {
    const root = this._selectedObject;
    const key = objectKey(root);
    const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
    const requestedEntity = String(body?.querySelector("#ha3dEntity")?.value || "").trim();

    const result = await oldSaveEditorBinding?.apply(this, args);
    if (!root || !key || !requestedEntity) return result;

    // Only force the marker when persistence actually succeeded. This avoids
    // showing a temporary icon for a binding rejected by the backend.
    if (this._config?.bindings?.[key] !== requestedEntity) return result;

    rebuildMarkersForManualBinding(this, root, requestedEntity);
    this._setStatus?.(`Binding salvo · ícone no centro visual de ${key}`);
    return result;
  };
}
