/*
 * Shared Xiaomi map alignment for HA3D.
 * Mirrors the browser overlay transform into HA3D's Home Assistant-backed
 * robot config so every device opens with the same alignment.
 */
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const STORAGE_KEY = "ha3d_lab_xiaomi_map_overlay_v1";
const MAP_ENTITY = "image.xiaomi_robot_vacuum_h50_live_map";
const INITIAL = Object.freeze({ visible: false, x: 0.27715605, z: -1.0158935, y: 0.24, scale: 0.05, rotation: -89, opacity: 0.8 });
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function sanitize(value = {}) {
  return {
    visible: typeof value.visible === "boolean" ? value.visible : INITIAL.visible,
    x: num(value.x, INITIAL.x),
    z: num(value.z, INITIAL.z),
    y: num(value.y, INITIAL.y),
    scale: clamp(num(value.scale, INITIAL.scale), 0.0001, 10),
    rotation: num(value.rotation, INITIAL.rotation),
    opacity: clamp(num(value.opacity, INITIAL.opacity), 0, 1),
  };
}

function readLocal(robotId) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return all && typeof all === "object" && all[robotId] && typeof all[robotId] === "object" ? sanitize(all[robotId]) : null;
  } catch (_error) {
    return null;
  }
}

function writeLocal(robotId, value) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const all = parsed && typeof parsed === "object" ? parsed : {};
    all[robotId] = sanitize(value);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (_error) {
    // The shared Home Assistant config remains authoritative.
  }
}

function robotFor(panel, robotId) {
  return (panel._config?.robots || []).find((robot) => robot.id === robotId);
}

function effective(panel, robotId) {
  const robot = robotFor(panel, robotId);
  if (robot?.map_overlay && typeof robot.map_overlay === "object") return sanitize(robot.map_overlay);
  return readLocal(robotId) || { ...INITIAL };
}

const persistTimers = new WeakMap();
async function persist(panel, robotId, settings) {
  if (!panel?._saveConfigPatch || !panel._config?.robots) return;
  const robots = panel._config.robots.map((robot) => robot.id === robotId
    ? { ...robot, map_entity: robot.map_entity || MAP_ENTITY, map_overlay: sanitize(settings) }
    : robot);
  try {
    await panel._saveConfigPatch({ robots });
  } catch (error) {
    console.error("HA3D: unable to persist shared Xiaomi map alignment", error);
  }
}

function queuePersist(panel, robotId, settings, delay = 180) {
  const previous = persistTimers.get(panel);
  if (previous) clearTimeout(previous);
  persistTimers.set(panel, setTimeout(() => {
    persistTimers.delete(panel);
    persist(panel, robotId, settings);
  }, delay));
}

function syncSharedToLocal(panel, persistMissing = true) {
  for (const robot of panel?._config?.robots || []) {
    if (!robot?.id) continue;
    const hadShared = Boolean(robot.map_overlay && typeof robot.map_overlay === "object");
    const settings = effective(panel, robot.id);
    writeLocal(robot.id, settings);
    if (!hadShared && persistMissing) queuePersist(panel, robot.id, settings, 80);
  }
}

function wire(panel) {
  if (!panel?.shadowRoot) return;
  for (const robot of panel._config?.robots || []) {
    if (!robot?.id) continue;
    const row = panel.shadowRoot.querySelector(`[data-robot-id="${CSS.escape(robot.id)}"]`);
    const box = row?.querySelector("[data-map-overlay-box]");
    if (!box || box.dataset.sharedConfigBound === "1") continue;
    box.dataset.sharedConfigBound = "1";

    const saveAfterOverlay = () => setTimeout(() => {
      queuePersist(panel, robot.id, readLocal(robot.id) || effective(panel, robot.id));
    }, 0);

    box.querySelector("[data-map-visible]")?.addEventListener("change", saveAfterOverlay);
    box.querySelectorAll("[data-map-range], [data-map-value]").forEach((input) => input.addEventListener("change", saveAfterOverlay));
    box.querySelector("[data-map-reset]")?.addEventListener("click", saveAfterOverlay);
  }
}

if (!proto.__ha3dRobotMapSharedConfigV1) {
  proto.__ha3dRobotMapSharedConfigV1 = true;

  const originalRender = proto._renderRobotsPanel;
  proto._renderRobotsPanel = function (...args) {
    syncSharedToLocal(this);
    const result = originalRender?.apply(this, args);
    queueMicrotask(() => wire(this));
    return result;
  };

  const originalRebuild = proto._rebuildRobots;
  proto._rebuildRobots = function (...args) {
    syncSharedToLocal(this);
    const result = originalRebuild?.apply(this, args);
    queueMicrotask(() => wire(this));
    return result;
  };

  queueMicrotask(() => {
    const walk = (root) => {
      for (const element of root?.querySelectorAll?.("*") || []) {
        if (element.localName === "ha3d-lab-panel") {
          syncSharedToLocal(element);
          wire(element);
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
  });
}
