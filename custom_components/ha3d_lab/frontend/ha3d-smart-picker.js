const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const THREE = Panel.HA3D_THREE;
if (!THREE) throw new Error("HA3D Three.js runtime was not registered");
const proto = Panel.prototype;

const ARCH_RE = /(^|[\s_.-])(wall|parede|walls|paredes|floor|piso|ceiling|teto|roof|telhado|glass|vidro|window|janela)([\s_.-]|$)/i;

function labelFor(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.userData?.ha3dSceneAssetName || object?.name || "").trim();
}

function isSpecialHelper(object) {
  return Boolean(
    object?.userData?.ha3dEditorHelper
    || object?.userData?.ha3dVirtualLightId
    || object?.userData?.ha3dFloatingWidgetId
    || object?.userData?.ha3dRobotCalibration
  );
}

function logicalRoot(panel, object) {
  if (!object) return null;
  if (object.userData?.ha3dLogicalRootObject) return object.userData.ha3dLogicalRootObject;
  if (object.userData?.ha3dSceneAssetRoot) return object.userData.ha3dSceneAssetRoot;
  let node = object;
  while (node && node !== panel?._model) {
    if (node.userData?.ha3dLogicalRoot) return node;
    if (node.parent === panel?._model) return node;
    node = node.parent;
  }
  return object;
}

function visibleHit(hit) {
  const object = hit?.object;
  if (!object || object.visible === false || object.userData?.ha3dEditorHelper) return false;
  let node = object.parent;
  while (node) {
    if (node.visible === false) return false;
    node = node.parent;
  }
  return true;
}

function materialsOf(object) {
  return Array.isArray(object?.material) ? object.material : object?.material ? [object.material] : [];
}

function transparentHit(hit) {
  const materials = materialsOf(hit?.object);
  return materials.some((material) => material?.transparent && Number(material.opacity ?? 1) < 0.72);
}

function diagonalOf(object) {
  if (!object) return 0;
  try {
    object.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return 0;
    return box.getSize(new THREE.Vector3()).length();
  } catch (_error) {
    return 0;
  }
}

function modelDiagonal(panel) {
  const cached = Number(panel?._ha3dSmartPickerModelDiagonal);
  if (Number.isFinite(cached) && cached > 0) return cached;
  const diagonal = diagonalOf(panel?._model) || Math.max(1, Number(panel?._modelScale) || 10);
  panel._ha3dSmartPickerModelDiagonal = diagonal;
  return diagonal;
}

function isArchitectureCandidate(candidate, sceneDiagonal) {
  if (!candidate?.root) return false;
  if (ARCH_RE.test(labelFor(candidate.root)) || ARCH_RE.test(labelFor(candidate.hit?.object))) return true;
  const diagonal = candidate.diagonal || diagonalOf(candidate.root);
  return diagonal > sceneDiagonal * 0.42;
}

function candidateScore(candidate, firstDistance, depthWindow, sceneDiagonal) {
  const depth = Math.max(0, candidate.hit.distance - firstDistance) / Math.max(depthWindow, 1e-6);
  const size = Math.min(2, (candidate.diagonal || 0) / Math.max(sceneDiagonal, 1e-6));
  const architecture = isArchitectureCandidate(candidate, sceneDiagonal) ? 1.15 : 0;
  const transparent = candidate.transparent ? 0.9 : 0;
  const label = labelFor(candidate.root);
  const entityPriority = candidate.root?.userData?.ha3dEntityId || /^(light|switch|media_player|vacuum|climate|binary_sensor|sensor)\./.test(label) ? -0.18 : 0;
  return depth * 0.8 + size * 0.55 + architecture + transparent + entityPriority;
}

function smartPick(panel, event) {
  if (!panel?._model || !panel?._renderer || !panel?._camera || !panel?._raycaster || !panel?._pointer) return null;
  const rect = panel._renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  panel._pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  panel._raycaster.setFromCamera(panel._pointer, panel._camera);

  const hits = panel._raycaster.intersectObject(panel._model, true).filter(visibleHit);
  if (!hits.length) return null;

  const candidates = [];
  const seen = new Set();
  for (const hit of hits) {
    const root = logicalRoot(panel, hit.object);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    candidates.push({ root, hit, diagonal: diagonalOf(root), transparent: transparentHit(hit) });
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].root;

  const first = candidates[0];
  const sceneDiagonal = modelDiagonal(panel);
  const firstNeedsHelp = first.transparent || isArchitectureCandidate(first, sceneDiagonal);
  if (!firstNeedsHelp) return first.root;

  const depthWindow = Math.max(sceneDiagonal * 0.032, Math.max(0.08, first.hit.distance * 0.018));
  const nearby = candidates.filter((candidate) => candidate.hit.distance <= first.hit.distance + depthWindow);
  if (nearby.length < 2) return first.root;

  let best = first;
  let bestScore = candidateScore(first, first.hit.distance, depthWindow, sceneDiagonal);
  for (const candidate of nearby.slice(1)) {
    const score = candidateScore(candidate, first.hit.distance, depthWindow, sceneDiagonal);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.root;
}

if (!proto.__ha3dSmartPickerV1) {
  proto.__ha3dSmartPickerV1 = true;
  const oldPickObject = proto._pickObject;
  proto._pickObject = function (event) {
    if (this._editorMode) {
      const special = oldPickObject?.call(this, event);
      if (isSpecialHelper(special)) return special;
    }
    return smartPick(this, event);
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    this._ha3dSmartPickerModelDiagonal = 0;
    const result = await oldLoadModel?.apply(this, args);
    this._ha3dSmartPickerModelDiagonal = 0;
    return result;
  };
}
