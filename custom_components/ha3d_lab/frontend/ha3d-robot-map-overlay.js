/*
 * Xiaomi Map Extractor driven positioning for HA3D robot tracking.
 * The Xiaomi map is the calibration reference: align the map with the GLB and
 * the icon / selected GLB geometry immediately follows the vacuum position.
 */
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const THREE = Panel.HA3D_THREE;
if (!THREE) throw new Error("HA3D Three.js runtime was not registered");
const proto = Panel.prototype;

const MAP_ENTITY = "image.xiaomi_robot_vacuum_h50_live_map";
const STORAGE_KEY = "ha3d_lab_xiaomi_map_overlay_v1";
const DEFAULTS = Object.freeze({ visible: true, x: 0, z: 0, y: 0.02, scale: 0.025, scale_x: 0.025, scale_y: 0.025, rotation: 0, opacity: 0.55 });
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const offline = (state) => !state || ["unknown", "unavailable"].includes(state.state);

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}

function settingsFor(robotId) {
  const all = readAll();
  const stored = all[robotId] || {};
  const legacyScale = clamp(num(stored.scale, DEFAULTS.scale), 0.0001, 10);
  return {
    ...DEFAULTS,
    ...stored,
    scale_x: clamp(num(stored.scale_x, legacyScale), 0.0001, 10),
    scale_y: clamp(num(stored.scale_y, legacyScale), 0.0001, 10),
  };
}

function saveSettings(robotId, value) {
  const all = readAll();
  const legacyScale = clamp(num(value.scale, DEFAULTS.scale), 0.0001, 10);
  const scaleX = clamp(num(value.scale_x, legacyScale), 0.0001, 10);
  const scaleY = clamp(num(value.scale_y, legacyScale), 0.0001, 10);
  all[robotId] = {
    visible: Boolean(value.visible),
    x: num(value.x),
    z: num(value.z),
    y: num(value.y, DEFAULTS.y),
    scale: scaleX,
    scale_x: scaleX,
    scale_y: scaleY,
    rotation: num(value.rotation),
    opacity: clamp(num(value.opacity, DEFAULTS.opacity), 0, 1),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return all[robotId];
}

function positionFromValue(value, changed, sourceName) {
  if (value == null) return null;
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch (_error) { return null; }
  }
  if (Array.isArray(source)) {
    const x = Number(source[0]);
    const y = Number(source[1]);
    const heading = Number(source[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, heading: Number.isFinite(heading) ? heading : 0, changed, source: sourceName };
  }
  if (typeof source !== "object") return null;
  const embedded = source.vacuum_position ?? source.position;
  if (embedded && embedded !== source) return positionFromValue(embedded, changed, sourceName);
  const x = Number(source.x);
  const y = Number(source.y);
  const heading = Number(source.a ?? source.heading ?? source.angle);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, heading: Number.isFinite(heading) ? heading : 0, changed, source: sourceName };
}

function getPosition(hass, entityId) {
  // Primary source: the same vacuum_position attribute used by Xiaomi Cloud Map Extractor
  // to render the vacuum on its live map. This keeps HA3D synchronized with each map refresh.
  const mapState = hass?.states?.[MAP_ENTITY];
  const mapChanged = mapState?.last_updated || mapState?.last_changed;
  const mapPosition = positionFromValue(mapState?.attributes?.vacuum_position, mapChanged, "map_extractor");
  if (mapPosition) return mapPosition;

  // Fallback: keep the configured Xiaomi position sensor for maps that do not expose
  // vacuum_position or while the map entity is temporarily unavailable.
  const state = hass?.states?.[entityId];
  if (offline(state)) return null;
  const changed = state.last_updated || state.last_changed;
  const fromAttributes = positionFromValue(state.attributes || {}, changed, "sensor_fallback");
  if (fromAttributes) return fromAttributes;
  return positionFromValue(state.state, changed, "sensor_fallback");
}

function mapCalibration(hass) {
  const state = hass?.states?.[MAP_ENTITY];
  const points = state?.attributes?.calibration_points;
  if (!Array.isArray(points) || points.length < 3) return null;
  const p = points.slice(0, 3).map((point) => ({
    x: Number(point?.vacuum?.x),
    y: Number(point?.vacuum?.y),
    u: Number(point?.map?.x),
    v: Number(point?.map?.y),
  }));
  if (p.some((item) => ![item.x, item.y, item.u, item.v].every(Number.isFinite))) return null;

  const [a, b, c] = p;
  const det = a.x * (b.y - c.y) - a.y * (b.x - c.x) + (b.x * c.y - b.y * c.x);
  if (Math.abs(det) < 1e-9) return null;
  const solve = (qa, qb, qc) => {
    const A = (qa * (b.y - c.y) - a.y * (qb - qc) + (qb * c.y - b.y * qc)) / det;
    const B = (a.x * (qb - qc) - qa * (b.x - c.x) + (b.x * qc - qb * c.x)) / det;
    const C = (a.x * (b.y * qc - qb * c.y) - a.y * (b.x * qc - qb * c.x) + qa * (b.x * c.y - b.y * c.x)) / det;
    return [A, B, C];
  };
  const [ux, uy, ut] = solve(a.u, b.u, c.u);
  const [vx, vy, vt] = solve(a.v, b.v, c.v);
  return { ux, uy, ut, vx, vy, vt };
}

function floorVector(u, v, height, plane = "xz") {
  if (plane === "xy") return new THREE.Vector3(u, v, height);
  if (plane === "yz") return new THREE.Vector3(height, u, v);
  return new THREE.Vector3(u, height, v);
}

function pixelToFloor(position, calibration, settings, imageSize) {
  if (!position || !calibration || !imageSize?.width || !imageSize?.height) return null;
  const px = calibration.ux * position.x + calibration.uy * position.y + calibration.ut;
  const py = calibration.vx * position.x + calibration.vy * position.y + calibration.vt;
  const legacyScale = num(settings.scale, DEFAULTS.scale);
  const scaleX = num(settings.scale_x, legacyScale);
  const scaleY = num(settings.scale_y, legacyScale);
  const u = (px - imageSize.width / 2) * scaleX;
  const v = (py - imageSize.height / 2) * scaleY;
  // PlaneGeometry is flipped onto XZ, so map-pixel rotation uses the opposite sign.
  const r = THREE.MathUtils.degToRad(-num(settings.rotation));
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    x: num(settings.x) + u * cos - v * sin,
    z: num(settings.z) + u * sin + v * cos,
  };
}

function disposeMap(entry) {
  const mesh = entry?.ha3dMapOverlay;
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  mesh.geometry?.dispose?.();
  mesh.material?.map?.dispose?.();
  mesh.material?.dispose?.();
  entry.ha3dMapOverlay = null;
  entry.ha3dMapUrl = null;
  entry.ha3dMapSize = null;
  entry.ha3dMapLoading = false;
}

function applyPlane(mesh, settings, size, plane = "xz") {
  const legacyScale = num(settings.scale, DEFAULTS.scale);
  const scaleX = num(settings.scale_x, legacyScale);
  const scaleY = num(settings.scale_y, legacyScale);
  mesh.scale.set(size.width * scaleX, size.height * scaleY, 1);
  mesh.position.copy(floorVector(num(settings.x), num(settings.z), num(settings.y, DEFAULTS.y), plane));
  mesh.rotation.set(0, 0, 0);
  const angle = THREE.MathUtils.degToRad(num(settings.rotation));
  if (plane === "xz") {
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = angle;
  } else if (plane === "xy") {
    mesh.rotation.z = angle;
  } else {
    mesh.rotation.y = Math.PI / 2;
    mesh.rotation.z = angle;
  }
  mesh.material.opacity = clamp(num(settings.opacity, DEFAULTS.opacity), 0, 1);
  mesh.visible = Boolean(settings.visible);
}

function statusText(panel, entry) {
  const mapState = panel._hass?.states?.[MAP_ENTITY];
  if (!mapState) return "Mapa Xiaomi não encontrado no Home Assistant.";
  if (!mapState.attributes?.entity_picture) return "Mapa encontrado, mas sem entity_picture.";
  if (!mapCalibration(panel._hass)) return "Mapa encontrado, mas calibration_points não estão disponíveis.";
  if (!entry?.ha3dMapSize) return "Carregando imagem do mapa…";
  return `Mapa pronto · ${entry.ha3dMapSize.width}×${entry.ha3dMapSize.height}px · alinhe o mapa com o GLB; o robô segue automaticamente.`;
}

function ensureMap(panel, entry) {
  if (!entry || !panel._scene) return;
  const state = panel._hass?.states?.[MAP_ENTITY];
  const picture = state?.attributes?.entity_picture;
  if (!picture) {
    if (entry.ha3dMapOverlay) entry.ha3dMapOverlay.visible = false;
    return;
  }

  const settings = settingsFor(entry.config.id);
  if (entry.ha3dMapOverlay && entry.ha3dMapUrl === picture) {
    applyPlane(entry.ha3dMapOverlay, settings, entry.ha3dMapSize || { width: 1, height: 1 }, entry.config.floor_plane || "xz");
    return;
  }
  if (entry.ha3dMapLoading && entry.ha3dMapUrl === picture) return;

  disposeMap(entry);
  entry.ha3dMapUrl = picture;
  entry.ha3dMapLoading = true;
  const loader = new THREE.TextureLoader();
  loader.load(picture, (texture) => {
    entry.ha3dMapLoading = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    const image = texture.image || {};
    entry.ha3dMapSize = {
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
    };
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: settings.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.name = "HA3D_Xiaomi_H50_Map_Overlay";
    mesh.renderOrder = 8000;
    mesh.userData.ha3dRobotMapOverlay = true;
    mesh.raycast = () => {};
    entry.ha3dMapOverlay = mesh;
    panel._scene.add(mesh);
    applyPlane(mesh, settingsFor(entry.config.id), entry.ha3dMapSize, entry.config.floor_plane || "xz");
    updateRobotFromMap(panel, entry, true);
    refreshStatus(panel, entry.config.id);
  }, undefined, (error) => {
    entry.ha3dMapLoading = false;
    console.warn("HA3D: unable to load Xiaomi map overlay", error);
    refreshStatus(panel, entry.config.id, "Falha ao carregar a imagem do mapa.");
  });
}

function updateRobotFromMap(panel, entry, snap = false) {
  if (!entry) return;
  const settings = settingsFor(entry.config.id);
  const calibration = mapCalibration(panel._hass);
  const position = getPosition(panel._hass, entry.config.position_entity);
  const mapped = pixelToFloor(position, calibration, settings, entry.ha3dMapSize);
  const root = entry.object || entry.icon;
  if (!root) return;

  const vacuum = panel._hass?.states?.[entry.config.vacuum_entity];
  const visibleStates = entry.config.visible_states || ["cleaning", "returning", "docked", "paused", "idle"];
  const available = !offline(vacuum) && Boolean(position) && visibleStates.includes(vacuum.state);
  root.visible = Boolean(available && mapped);

  const live = panel.shadowRoot?.querySelector(`[data-robot-id="${CSS.escape(entry.config.id)}"] [data-live]`);
  if (!mapped) {
    if (live) {
      const reason = !position
        ? "Aguardando posição X/Y do Xiaomi."
        : !calibration
          ? "Aguardando calibration_points do Map Extractor."
          : !entry.ha3dMapSize
            ? "Carregando o mapa Xiaomi."
            : "Não foi possível converter a posição do robô.";
      live.textContent = reason;
    }
    return;
  }

  if (!available) {
    if (live) live.textContent = offline(vacuum) ? "Robô indisponível no Home Assistant." : `Robô oculto no estado: ${vacuum?.state || "desconhecido"}.`;
    return;
  }

  const target = floorVector(mapped.x, mapped.z, num(entry.config.floor_y), entry.config.floor_plane || "xz");
  entry.target?.copy?.(target);
  if (entry.icon) {
    if (snap || !entry.ha3dMapPlaced) entry.icon.position.copy(target);
    else entry.icon.position.lerp(target, 0.22);
  } else if (entry.object) {
    const local = entry.object.parent ? entry.object.parent.worldToLocal(target.clone()) : target;
    if (snap || !entry.ha3dMapPlaced) entry.object.position.copy(local);
    else entry.object.position.lerp(local, 0.22);
  }
  entry.ha3dMapPlaced = true;

  const timestamp = Date.parse(position.changed);
  const stale = Number.isFinite(timestamp) && Date.now() - timestamp > num(entry.config.stale_after_s, 45) * 1000;
  if (entry.icon) {
    entry.icon.traverse((node) => {
      if (node.material) {
        node.material.transparent = true;
        node.material.opacity = stale ? 0.45 : 1;
      }
    });
  }
  if (live) {
    const sourceLabel = position.source === "map_extractor" ? "Map Extractor" : "sensor (fallback)";
    live.textContent = `${stale ? "Última posição conhecida" : `Posição ${sourceLabel}`} · X ${position.x} · Y ${position.y}`;
  }
}

function refreshStatus(panel, robotId, forced = "") {
  const row = panel.shadowRoot?.querySelector(`[data-robot-id="${CSS.escape(robotId)}"]`);
  const output = row?.querySelector("[data-map-status]");
  const entry = panel._robotEntries?.get(robotId);
  if (output) output.textContent = forced || statusText(panel, entry);
}

function modelRange(panel, axis) {
  if (!panel._model) return [-25, 25];
  const box = new THREE.Box3().setFromObject(panel._model);
  if (box.isEmpty()) return [-25, 25];
  const min = axis === "x" ? box.min.x : box.min.z;
  const max = axis === "x" ? box.max.x : box.max.z;
  const span = Math.max(2, max - min);
  return [min - span * 0.6, max + span * 0.6];
}

function control(label, key, value, min, max, step) {
  return `<label class="ha3dMapControl"><span>${label}</span><input type="range" data-map-range="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><input type="number" data-map-value="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}

function hideLegacyCalibration(row) {
  row.querySelector('[data-action="position"]')?.remove();
  row.querySelector('[data-saved-points]')?.remove();
  row.querySelector('[data-calibration]')?.remove();
  for (const field of ["remote_pulse_ms", "remote_settle_ms", "heading_offset"]) {
    const input = row.querySelector(`[data-field="${field}"]`);
    if (input?.closest("label")) input.closest("label").style.display = "none";
  }
}

async function useSelectedGeometry(panel, robotId, row, status) {
  const selected = panel._selectedObject;
  if (!selected || selected.userData?.ha3dRobotMapOverlay || selected.userData?.ha3dRobotIcon || selected.userData?.ha3dRobotCalibration) {
    status("Selecione a geometria do robô no GLB primeiro.");
    return;
  }
  const objectName = selected.userData?.ha3dOriginalNodeName || selected.name;
  if (!objectName) {
    status("A geometria selecionada não possui nome utilizável.");
    return;
  }
  row.querySelector('[data-field="object_name"]').value = objectName;
  row.querySelector('[data-field="display"]').value = "object";
  status("Vinculando geometria ao robô…");
  await panel._saveRobotRow?.(robotId, status);
  panel._updateRobots?.(true);
}

async function useDefaultIcon(panel, robotId, row, status) {
  row.querySelector('[data-field="display"]').value = "icon";
  status("Ativando ícone 3D…");
  await panel._saveRobotRow?.(robotId, status);
  panel._updateRobots?.(true);
}

function installUi(panel) {
  if (!panel.shadowRoot) return;
  if (!panel.shadowRoot.querySelector("#ha3dMapOverlayStyle")) {
    const style = document.createElement("style");
    style.id = "ha3dMapOverlayStyle";
    style.textContent = `
      .ha3dMapOverlayBox{margin-top:10px;padding:10px;border:1px solid #58b9e055;border-radius:10px;background:#0a222c}
      .ha3dMapOverlayBox summary{cursor:pointer;font-size:12px;font-weight:700}
      .ha3dMapToggle{display:flex;align-items:center;gap:7px;margin:9px 0;font-size:12px}
      .ha3dMapControl{display:grid;grid-template-columns:64px 1fr 76px;gap:7px;align-items:center;margin:6px 0;font-size:11px}
      .ha3dMapControl input[type=range]{width:100%;margin:0;padding:0}
      .ha3dMapControl input[type=number]{width:76px!important;margin:0!important;padding:5px!important}
      .ha3dMapStatus{font-size:10px;opacity:.72;line-height:1.3;margin-top:7px}
      .ha3dMapActions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.ha3dMapActions button{padding:6px 8px;font-size:11px}
    `;
    panel.shadowRoot.appendChild(style);
  }

  const robotsPanel = panel.shadowRoot.querySelector("#ha3dRobots");
  const intro = robotsPanel?.querySelector(".ha3dRobotHint");
  if (intro) intro.textContent = "O mapa Xiaomi é a referência. Alinhe o mapa com a planta 3D e escolha entre o ícone padrão ou uma geometria do GLB; o robô vai imediatamente para a posição mostrada no mapa.";

  for (const [robotId, entry] of panel._robotEntries?.entries?.() || []) {
    const row = panel.shadowRoot.querySelector(`[data-robot-id="${CSS.escape(robotId)}"]`);
    if (!row) continue;
    hideLegacyCalibration(row);

    const meta = row.querySelector(".ha3dRobotMeta");
    if (meta) meta.textContent = `Posicionamento pelo Map Extractor · ${entry.config.position_entity}`;

    const oldSelected = row.querySelector('[data-action="selected"]');
    if (oldSelected && !oldSelected.dataset.mapModeBound) {
      const selectedButton = oldSelected.cloneNode(true);
      selectedButton.dataset.mapModeBound = "1";
      selectedButton.textContent = "Usar geometria selecionada";
      oldSelected.replaceWith(selectedButton);
      const iconButton = document.createElement("button");
      iconButton.type = "button";
      iconButton.className = "secondary";
      iconButton.textContent = "Usar ícone 3D";
      selectedButton.parentElement?.insertBefore(iconButton, selectedButton);
      const status = (text) => {
        const output = row.querySelector("[data-status]");
        if (output) output.textContent = text;
      };
      selectedButton.addEventListener("click", () => useSelectedGeometry(panel, robotId, row, status));
      iconButton.addEventListener("click", () => useDefaultIcon(panel, robotId, row, status));
    }

    if (!row.querySelector("[data-map-overlay-box]")) {
      const settings = settingsFor(robotId);
      const [minX, maxX] = modelRange(panel, "x");
      const [minZ, maxZ] = modelRange(panel, "z");
      const box = document.createElement("details");
      box.className = "ha3dMapOverlayBox";
      box.dataset.mapOverlayBox = "";
      box.open = true;
      box.innerHTML = `
        <summary>Mapa Xiaomi / Map Extractor</summary>
        <label class="ha3dMapToggle"><input type="checkbox" data-map-visible ${settings.visible ? "checked" : ""}> Mostrar mapa no piso</label>
        ${control("X", "x", settings.x, minX, maxX, 0.02)}
        ${control("Z", "z", settings.z, minZ, maxZ, 0.02)}
        ${control("Altura", "y", settings.y, -2, 5, 0.01)}
        ${control("Escala X", "scale_x", settings.scale_x, 0.001, 0.12, 0.001)}
        ${control("Escala Y", "scale_y", settings.scale_y, 0.001, 0.12, 0.001)}
        ${control("Rotação", "rotation", settings.rotation, -180, 180, 1)}
        ${control("Opacidade", "opacity", settings.opacity, 0, 1, 0.05)}
        <div class="ha3dMapActions"><button type="button" data-map-reset class="secondary">Resetar ajuste</button></div>
        <div class="ha3dMapStatus" data-map-status></div>`;

      const live = row.querySelector("[data-live]");
      if (live) row.insertBefore(box, live);
      else row.appendChild(box);

      const commit = (key, raw) => {
        const current = settingsFor(robotId);
        current[key] = key === "visible" ? Boolean(raw) : num(raw, current[key]);
        const saved = saveSettings(robotId, current);
        const range = box.querySelector(`[data-map-range="${key}"]`);
        const value = box.querySelector(`[data-map-value="${key}"]`);
        if (range && range.value !== String(saved[key])) range.value = String(saved[key]);
        if (value && value.value !== String(saved[key])) value.value = String(saved[key]);
        ensureMap(panel, entry);
        if (entry.ha3dMapOverlay && entry.ha3dMapSize) {
          applyPlane(entry.ha3dMapOverlay, saved, entry.ha3dMapSize, entry.config.floor_plane || "xz");
        }
        updateRobotFromMap(panel, entry, true);
        refreshStatus(panel, robotId);
      };

      box.querySelector("[data-map-visible]").addEventListener("change", (event) => commit("visible", event.target.checked));
      for (const key of ["x", "z", "y", "scale_x", "scale_y", "rotation", "opacity"]) {
        box.querySelector(`[data-map-range="${key}"]`).addEventListener("input", (event) => commit(key, event.target.value));
        box.querySelector(`[data-map-value="${key}"]`).addEventListener("input", (event) => commit(key, event.target.value));
      }
      box.querySelector("[data-map-reset]").addEventListener("click", () => {
        saveSettings(robotId, DEFAULTS);
        box.remove();
        installUi(panel);
        ensureMap(panel, entry);
        updateRobotFromMap(panel, entry, true);
        refreshStatus(panel, robotId);
      });
    }

    ensureMap(panel, entry);
    updateRobotFromMap(panel, entry, true);
    refreshStatus(panel, robotId);
  }
}

if (!proto.__ha3dRobotMapOverlayV2) {
  proto.__ha3dRobotMapOverlayV2 = true;

  const originalRender = proto._renderRobotsPanel;
  proto._renderRobotsPanel = function (...args) {
    const result = originalRender?.apply(this, args);
    queueMicrotask(() => installUi(this));
    return result;
  };

  const originalRebuild = proto._rebuildRobots;
  proto._rebuildRobots = function (...args) {
    for (const entry of this._robotEntries?.values?.() || []) disposeMap(entry);
    const result = originalRebuild?.apply(this, args);
    queueMicrotask(() => {
      for (const entry of this._robotEntries?.values?.() || []) ensureMap(this, entry);
      installUi(this);
      this._updateRobots?.(true);
    });
    return result;
  };

  const originalUpdate = proto._updateRobots;
  proto._updateRobots = function (...args) {
    const result = originalUpdate?.apply(this, args);
    const snap = Boolean(args[0]);
    for (const entry of this._robotEntries?.values?.() || []) {
      ensureMap(this, entry);
      updateRobotFromMap(this, entry, snap);
    }
    return result;
  };

  queueMicrotask(() => {
    const walk = (root) => {
      for (const element of root?.querySelectorAll?.("*") || []) {
        if (element.localName === "ha3d-lab-panel") {
          installUi(element);
          element._rebuildRobots?.();
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
  });
}
