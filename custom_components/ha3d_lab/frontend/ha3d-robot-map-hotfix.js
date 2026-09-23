/*
 * HA3D 0.2.12 robot/map hotfix.
 * Keeps the 0.2.11 map-driven flow intact while:
 *  - starting the Xiaomi map overlay hidden after upgrade;
 *  - removing orphan/ghost map planes;
 *  - keeping icon or selected GLB geometry on the same height as the map plane.
 */
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const THREE = Panel.HA3D_THREE;
if (!THREE) throw new Error("HA3D Three.js runtime was not registered");
const proto = Panel.prototype;

const STORAGE_KEY = "ha3d_lab_xiaomi_map_overlay_v1";
const MIGRATION_KEY = "ha3d_lab_xiaomi_map_overlay_0_2_12_initialized";
const DEFAULT_MAP_Y = 0.02;

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}

function writeAll(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (_error) {
    // localStorage may be unavailable in hardened browser contexts.
  }
}

function migrateVisibilityOnce(panel) {
  const entries = [...(panel._robotEntries?.values?.() || [])];
  if (!entries.length) return;
  try {
    if (localStorage.getItem(MIGRATION_KEY) === "1") return;
    const all = readAll();
    for (const entry of entries) {
      const robotId = entry?.config?.id;
      if (!robotId) continue;
      all[robotId] = { ...(all[robotId] || {}), visible: false };
      if (entry.ha3dMapOverlay) entry.ha3dMapOverlay.visible = false;
    }
    writeAll(all);
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch (_error) {
    // The overlay module will continue with its normal defaults if storage fails.
  }
}

function removeGhostMaps(panel) {
  if (!panel._scene) return;
  const owned = new Set();
  for (const entry of panel._robotEntries?.values?.() || []) {
    if (entry?.ha3dMapOverlay) owned.add(entry.ha3dMapOverlay);
  }
  const ghosts = [];
  panel._scene.traverse((node) => {
    if (node?.userData?.ha3dRobotMapOverlay && !owned.has(node)) ghosts.push(node);
  });
  for (const node of ghosts) {
    node.parent?.remove(node);
    node.geometry?.dispose?.();
    node.material?.map?.dispose?.();
    node.material?.dispose?.();
  }
}

function mapHeightFor(robotId) {
  const settings = readAll()[robotId] || {};
  const value = Number(settings.y);
  return Number.isFinite(value) ? value : DEFAULT_MAP_Y;
}

function syncRobotHeight(panel) {
  for (const entry of panel._robotEntries?.values?.() || []) {
    const root = entry?.object || entry?.icon;
    if (!root || !entry?.config?.id) continue;

    const plane = entry.config.floor_plane || "xz";
    const heightAxis = plane === "xy" ? "z" : plane === "yz" ? "x" : "y";
    const height = mapHeightFor(entry.config.id);

    root.updateWorldMatrix?.(true, false);
    const world = root.getWorldPosition(new THREE.Vector3());
    world[heightAxis] = height;
    const local = root.parent ? root.parent.worldToLocal(world.clone()) : world;
    root.position.copy(local);
    root.updateMatrixWorld?.(true);
  }
}

if (!proto.__ha3dRobotMapHotfixV0212) {
  proto.__ha3dRobotMapHotfixV0212 = true;

  const originalRebuild = proto._rebuildRobots;
  proto._rebuildRobots = function (...args) {
    const result = originalRebuild?.apply(this, args);
    migrateVisibilityOnce(this);
    removeGhostMaps(this);
    queueMicrotask(() => {
      removeGhostMaps(this);
      syncRobotHeight(this);
    });
    return result;
  };

  const originalUpdate = proto._updateRobots;
  proto._updateRobots = function (...args) {
    migrateVisibilityOnce(this);
    removeGhostMaps(this);
    const result = originalUpdate?.apply(this, args);
    syncRobotHeight(this);
    return result;
  };

  queueMicrotask(() => {
    const walk = (root) => {
      for (const element of root?.querySelectorAll?.("*") || []) {
        if (element.localName === "ha3d-lab-panel") {
          migrateVisibilityOnce(element);
          removeGhostMaps(element);
          syncRobotHeight(element);
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
  });
}
