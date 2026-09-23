/*
 * HA3D robot trackers. Independent Three.js implementation.
 * UX ideas: Easy Floorplan (MIT) and Home Assistant 3D Floorplan Extended
 * (ISC). No source code or assets from either project are included.
 */
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
// Keep robot meshes in the same Three.js universe as the viewer. Importing a
// second ESM copy looks identical, but Three rejects its Object3D instances.
const THREE = Panel.HA3D_THREE;
if (!THREE) throw new Error("HA3D Three.js runtime was not registered");
const proto = Panel.prototype;

const esc = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
const id = () => `robot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const offline = (state) => !state || ["unknown", "unavailable"].includes(state.state);
const H50 = {
  name: "Xiaomi H50",
  vacuum: "vacuum.xiaomi_us_1213069013_ov43gb",
  position: "sensor.xiaomi_robot_vacuum_h50_vacuum_position",
  enterRemote: "button.xiaomi_us_1213069013_ov43gb_enter_remote_a_2_28",
  exitRemote: "button.xiaomi_us_1213069013_ov43gb_exit_remote_a_2_29",
  remoteControl: "notify.xiaomi_us_1213069013_ov43gb_remote_control_a_2_26",
};
const errorText = (error) => {
  if (typeof error === "string") return error;
  if (error?.body?.error) return error.body.error;
  if (error?.error) return error.error;
  if (error?.message) return error.message;
  try { return JSON.stringify(error); } catch (_ignored) { return String(error); }
};

function getPosition(hass, entityId) {
  const state = hass?.states?.[entityId];
  if (offline(state)) return null;
  let source = state.attributes || {};
  if (![source.x, source.y, source.a].some((value) => value !== undefined)) {
    try { source = { ...source, ...JSON.parse(state.state) }; } catch (_error) { /* attributes are the normal source */ }
  }
  const embedded = source.vacuum_position || source.position;
  if (embedded && typeof embedded === "object") source = { ...source, ...embedded };
  if ([source.x, source.y].some((value) => value == null || value === "" || typeof value === "boolean")) return null;
  const x = Number(source.x); const y = Number(source.y); const heading = Number(source.a ?? source.heading ?? source.angle);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y, heading: Number.isFinite(heading) ? heading : 0, changed: state.last_updated || state.last_changed } : null;
}

function preferredPositionEntity(hass, current = "") {
  // Autodetect only for a new robot. A temporarily unavailable sensor must
  // never silently change an existing robot's coordinate system.
  if (current) return current;
  const candidates = Object.keys(hass?.states || {}).filter((entity) => entity.startsWith("sensor.") && getPosition(hass, entity));
  return candidates.sort((a, b) => {
    const score = (entity) => (entity.endsWith("_vacuum_position") ? 3 : 0) + (/vacuum.*position/i.test(entity) ? 2 : 0) + (/xiaomi_robot_vacuum/i.test(entity) ? 1 : 0);
    return score(b) - score(a) || a.localeCompare(b);
  })[0] || current || "sensor.example_position";
}

function h50RobotConfig(robot = {}) {
  return {
    ...robot,
    name: robot.name || H50.name,
    vacuum_entity: H50.vacuum,
    position_entity: H50.position,
    visible_states: robot.visible_states || ["cleaning", "returning", "docked", "paused", "idle"],
  };
}

function normalized(point, calibration) {
  let x = point.x; let y = point.y;
  if (calibration.swap_xy) [x, y] = [y, x];
  if (calibration.invert_x) x = -x;
  if (calibration.invert_y) y = -y;
  return { x, y };
}

const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
function calibrationPoints(c = {}) {
  // Preserve old A/B calibrations while adopting the extensible point list.
  const points = Array.isArray(c.points) ? c.points : ["a", "b"].map((p) => ({ raw: c[`raw_${p}`], model: c[`model_${p}`] }));
  return points.filter((p) => isPair(p?.raw) && isPair(p?.model)).map((p) => ({ raw: [...p.raw], model: [...p.model] }));
}
const pointName = (index) => index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
const floorAxes = (plane = "xz") => ({ xz: ["x", "z", "y"], xy: ["x", "y", "z"], yz: ["y", "z", "x"] })[plane] || ["x", "z", "y"];
function floorVector(u, v, height, plane) {
  const [a, b, h] = floorAxes(plane); const result = new THREE.Vector3(); result[a] = u; result[b] = v; result[h] = height; return result;
}

function transformFor(calibration = {}, provisional = false) {
  const points = calibrationPoints(calibration);
  if (points.length < 2) return null;
  if (Array.isArray(calibration.points) && points.length < 3 && !provisional) return null;
  // Least-squares affine fit: handles rotation, unequal scales and reflection.
  // Two points can only supply a provisional similarity transform.
  const pairs = points.map((p) => ({ ...p, source: normalized({ x: p.raw[0], y: p.raw[1] }, calibration) }));
  const mean = pairs.reduce((m, p) => ({ x: m.x + p.source.x / pairs.length, y: m.y + p.source.y / pairs.length, mx: m.mx + p.model[0] / pairs.length, mz: m.mz + p.model[1] / pairs.length }), { x: 0, y: 0, mx: 0, mz: 0 });
  let denominator = 0; let dot = 0; let cross = 0;
  let sxx = 0; let sxy = 0; let syy = 0; let bx = 0; let by = 0; let cx = 0; let cy = 0;
  for (const p of pairs) {
    const x = p.source.x - mean.x; const y = p.source.y - mean.y;
    const mx = p.model[0] - mean.mx; const mz = p.model[1] - mean.mz;
    denominator += x * x + y * y; dot += x * mx + y * mz; cross += x * mz - y * mx;
    sxx += x * x; sxy += x * y; syy += y * y;
    bx += x * mx; by += y * mx; cx += x * mz; cy += y * mz;
  }
  if (denominator < 1e-10) return null;
  let xx = dot / denominator; let xy = -cross / denominator; let zx = -xy; let zy = xx;
  const det = sxx * syy - sxy * sxy;
  if (points.length >= 3 && det > 1e-8 * denominator * denominator) {
    xx = (bx * syy - by * sxy) / det; xy = (by * sxx - bx * sxy) / det;
    zx = (cx * syy - cy * sxy) / det; zy = (cy * sxx - cx * sxy) / det;
  } else if (Array.isArray(calibration.points) && !provisional) return null;
  const norm = xx * xx + xy * xy + zx * zx + zy * zy;
  if (![xx, xy, zx, zy].every(Number.isFinite) || norm === 0 || Math.abs(xx * zy - xy * zx) < 1e-8 * norm) return null;
  const tx = mean.mx - xx * mean.x - xy * mean.y; const tz = mean.mz - zx * mean.x - zy * mean.y;
  const error = Math.sqrt(pairs.reduce((sum, p) => sum + (xx * p.source.x + xy * p.source.y + tx - p.model[0]) ** 2 + (zx * p.source.x + zy * p.source.y + tz - p.model[1]) ** 2, 0) / pairs.length);
  return { xx, xy, zx, zy, tx, tz, error };
}

function calibrationProblem(c = {}) {
  const points = calibrationPoints(c);
  if (points.length < (Array.isArray(c.points) ? 3 : 2)) return `Calibração pendente: ${points.length} ponto(s). Adicione A, B e C em locais diferentes, formando um triângulo.`;
  if (!transformFor(c)) return "Pontos iguais ou alinhados: adicione um ponto fora da linha dos anteriores, tanto no sensor quanto no cenário.";
  return "";
}

function previewPosition(raw, calibration) {
  const mapped = mapPosition(raw, calibration, true);
  if (mapped) return mapped;
  // Before two correspondences, use an explicit provisional sensor scale.
  const p = normalized(raw, calibration); const anchor = calibrationPoints(calibration)[0];
  const a = anchor ? normalized({ x: anchor.raw[0], y: anchor.raw[1] }, calibration) : { x: 0, y: 0 };
  const scale = number(calibration.preview_scale, 0.001);
  return new THREE.Vector3((p.x - a.x) * scale + (anchor?.model[0] || 0), 0, (p.y - a.y) * scale + (anchor?.model[1] || 0));
}

function mapPosition(position, calibration, provisional = false) {
  const transform = transformFor(calibration, provisional);
  if (!transform) return null;
  const point = normalized(position, calibration);
  return new THREE.Vector3(transform.xx * point.x + transform.xy * point.y + transform.tx, 0, transform.zx * point.x + transform.zy * point.y + transform.tz);
}

function mapHeading(degrees, calibration) {
  let x = Math.cos(THREE.MathUtils.degToRad(degrees)); let y = Math.sin(THREE.MathUtils.degToRad(degrees));
  if (calibration.swap_xy) [x, y] = [y, x];
  if (calibration.invert_x) x = -x;
  if (calibration.invert_y) y = -y;
  const transform = transformFor(calibration);
  if (!transform) return 0;
  // The icon's arrow points along local -Z; convert the fitted direction to Y rotation.
  return Math.atan2(-(transform.xx * x + transform.xy * y), -(transform.zx * x + transform.zy * y)) + THREE.MathUtils.degToRad(number(calibration.heading_offset));
}

function makeIcon(name) {
  const root = new THREE.Group(); root.name = `HA3D_Robot_${name}`;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.10, 28), new THREE.MeshStandardMaterial({ color: 0x4fc3f7, metalness: 0.25, roughness: 0.32 }));
  body.castShadow = true; body.position.y = 0.06; root.add(body);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 4), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x174c62, emissiveIntensity: 0.35 }));
  arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 0.08, -0.16); root.add(arrow);
  root.userData.ha3dRobotIcon = true;
  return root;
}

function makeCalibrationArrow() {
  const root = new THREE.Group(); root.userData.ha3dRobotCalibration = true;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.07, 24), new THREE.MeshBasicMaterial({ color: 0xffa726, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
  body.position.y = 0.04; root.add(body);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 4), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
  arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 0.11, -0.24); root.add(arrow);
  root.traverse((node) => { node.renderOrder = 10000; node.userData.ha3dRobotCalibration = true; });
  return root;
}

function findObject(model, name) {
  let result;
  model?.traverse((item) => { if (!result && (item.name === name || item.userData?.ha3dOriginalNodeName === name)) result = item; });
  return result;
}

if (!proto.__ha3dRobotTrackersV1) {
  proto.__ha3dRobotTrackersV1 = true;

  const shell = proto._renderShell;
  proto._renderShell = function (...args) {
    shell.apply(this, args);
    const style = document.createElement("style");
    style.textContent = `#robotsButton.active{background:#176b44}#ha3dRobots{display:none;position:absolute;z-index:41;top:68px;right:12px;width:min(400px,calc(100vw - 24px));max-height:calc(100vh - 86px);overflow:auto;padding:14px;border-radius:16px}#ha3dRobots.open{display:block}.ha3dRobotRow{border-top:1px solid #ffffff1b;padding:11px 0}.ha3dRobotRow:first-child{border-top:0}.ha3dRobotRow strong{font-size:13px}.ha3dRobotMeta{font-size:11px;opacity:.68;margin:4px 0 8px}.ha3dRobotGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.ha3dRobotGrid label{font-size:11px;opacity:.8}.ha3dRobotGrid input,.ha3dRobotGrid select{box-sizing:border-box;width:100%;margin-top:4px;padding:7px;border-radius:8px;border:1px solid #ffffff2b;background:#111;color:inherit;font:inherit}.ha3dRobotActions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.ha3dRobotActions button{padding:7px 9px;font-size:11px}.ha3dRobotHint{font-size:11px;opacity:.68;line-height:1.35;margin:6px 0 10px}.ha3dRobotStatus{font-size:11px;color:#8bd7ff;margin-top:6px}.ha3dRobotCalibration{margin-top:10px;padding:10px;border:1px solid #3bb9e255;border-radius:10px;background:#0b2530}.ha3dRobotCalibration[hidden]{display:none}.ha3dRobotCalibration label{display:grid;grid-template-columns:18px 1fr 55px;align-items:center;gap:8px;margin:6px 0;font-size:12px}.ha3dRobotCalibration input[type=range]{margin:0;padding:0}.ha3dRobotCalibration output{text-align:right;font-variant-numeric:tabular-nums}`;
    style.textContent += `.ha3dRobotCalibration label{grid-template-columns:18px minmax(0,1fr) 85px}.ha3dRobotCalibration input[type=number]{width:100%;min-width:0;box-sizing:border-box;background:#111;color:inherit;border:1px solid #ffffff3b;border-radius:6px;padding:6px}.ha3dRobotGrid>*{min-width:0}.ha3dRobotMeta{overflow-wrap:anywhere}.ha3dRobotActions button{min-height:38px}#ha3dRobots{box-sizing:border-box}#ha3dRobots.calibrating>.ha3dRobotHint,#ha3dRobots.calibrating>.ha3dRobotActions,#ha3dRobots.calibrating [data-saved-points]{display:none}[data-robot-settings] summary{cursor:pointer;padding:8px 0}.ha3dRobotCalibration [hidden]{display:none}`;
    this.shadowRoot.append(style);
    const button = document.createElement("button"); button.id = "robotsButton"; button.className = "secondary"; button.type = "button"; button.textContent = "Robôs";
    button.addEventListener("click", () => { const panel = this.shadowRoot.querySelector("#ha3dRobots"); panel.classList.toggle("open"); button.classList.toggle("active", panel.classList.contains("open")); this._renderRobotsPanel(); });
    this.shadowRoot.querySelector("#actions").prepend(button);
    const panel = document.createElement("section"); panel.id = "ha3dRobots"; panel.className = "glass"; this.shadowRoot.querySelector("#root").append(panel);
  };

  const loadModel = proto._loadModel;
  proto._loadModel = async function (...args) { const result = await loadModel.apply(this, args); this._rebuildRobots(); return result; };
  const loadConfig = proto._loadConfig;
  proto._loadConfig = async function (...args) { const result = await loadConfig.apply(this, args); this._rebuildRobots(); return result; };
  const update = proto._updateLightMarkers;
  proto._updateLightMarkers = function (...args) { update.apply(this, args); this._updateRobots(); };

  const persistTransform = proto._persistSelectedTransform;
  proto._persistSelectedTransform = async function (...args) {
    // Calibration spheres belong to HA3D, never to the user's GLB layout.
    if (this._selectedObject === this._robotCalibrationMarker) return;
    return persistTransform.apply(this, args);
  };

  proto._robotObjects = function () { return this._robotEntries || new Map(); };
  proto._rebuildRobots = function () {
    if (!this._scene) return;
    for (const entry of this._robotObjects().values()) {
      if (entry.icon?.parent) { entry.icon.parent.remove(entry.icon); entry.icon.traverse((node) => { node.geometry?.dispose(); node.material?.dispose(); }); }
      if (entry.object && entry.base) { entry.object.position.copy(entry.base.position); entry.object.rotation.copy(entry.base.rotation); }
    }
    this._robotEntries = new Map();
    for (const original of this._config?.robots || []) {
      const config = h50RobotConfig(original);
      const entry = { config, target: new THREE.Vector3(), lastFrame: performance.now(), lastReceived: 0 };
      if (config.display === "object" && config.object_name) {
        entry.object = findObject(this._model, config.object_name);
        if (entry.object) entry.base = { position: entry.object.position.clone(), rotation: entry.object.rotation.clone() };
      }
      if (!entry.object) { entry.icon = makeIcon(config.name || config.id); this._scene.add(entry.icon); }
      this._robotEntries.set(config.id, entry);
    }
    this._updateRobots(true);
  };

  proto._updateRobots = function (snap = false) {
    const now = performance.now();
    for (const entry of this._robotObjects().values()) {
      const { config } = entry; const position = getPosition(this._hass, config.position_entity); const vacuum = this._hass?.states?.[config.vacuum_entity];
      const root = entry.object || entry.icon; if (!root) continue;
      const visibleStates = config.visible_states || ["cleaning", "returning", "docked", "paused"];
      const available = !offline(vacuum) && Boolean(position) && visibleStates.includes(vacuum.state);
      const mapped = position && mapPosition(position, config.calibration || {});
      if (mapped) {
        entry.target.copy(floorVector(mapped.x, mapped.z, number(config.floor_y), config.floor_plane));
        if (!entry.lastReceived || entry.lastStamp !== position.changed) { entry.lastStamp = position.changed; entry.lastReceived = now; }
        entry.heading = mapHeading(position.heading, config.calibration || {});
      }
      const timestamp = Date.parse(position?.changed);
      const stale = position && Number.isFinite(timestamp) && Date.now() - timestamp > number(config.stale_after_s, 45) * 1000;
      // A stationary vacuum may report unchanged coordinates for a long time.
      // Keep its last valid location visible, explicitly marked as old.
      root.visible = available && Boolean(mapped);
      if (entry.icon) entry.icon.traverse((node) => { if (node.material) { node.material.transparent = true; node.material.opacity = stale ? 0.45 : 1; } });
      const live = this.shadowRoot?.querySelector(`[data-robot-id="${CSS.escape(config.id)}"] [data-live]`);
      if (live) {
        const reason = !position ? "Sensor sem X/Y válido." : !mapped ? calibrationProblem(config.calibration) : offline(vacuum) ? "Entidade do robô indisponível." : !visibleStates.includes(vacuum.state) ? `Robô oculto no estado: ${vacuum.state}.` : stale ? "Última posição conhecida (leitura antiga)." : "Posição recebida.";
        live.textContent = `${reason}${position ? ` Sensor X ${position.x} · Y ${position.y} · direção ${Math.round(position.heading)}°` : ""}`;
      }
      if (!root.visible || !entry.lastReceived) continue;
      const dt = Math.min(0.1, Math.max(0.001, (now - entry.lastFrame) / 1000)); entry.lastFrame = now;
      const alpha = snap ? 1 : 1 - Math.exp(-dt / Math.max(0.08, number(config.smoothing_ms, 1600) / 1000));
      const front = floorVector(-Math.sin(entry.heading), -Math.cos(entry.heading), 0, config.floor_plane);
      const up = floorVector(0, 0, 1, config.floor_plane); const right = new THREE.Vector3().crossVectors(front, up);
      const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, front.negate()));
      if (entry.icon) { entry.icon.position.lerp(entry.target, alpha); entry.icon.quaternion.slerp(orientation, alpha); }
      else {
        // A GLB object is normally nested below the model root; positions from
        // calibration are world-space, so convert them back into its parent.
        const localTarget = root.parent ? root.parent.worldToLocal(entry.target.clone()) : entry.target;
        root.position.lerp(localTarget, alpha);
        if (root.parent) orientation.premultiply(root.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
        root.quaternion.slerp(orientation, alpha);
      }
    }
  };

  proto._robotChoices = function (selected = "") {
    const states = this._hass?.states || {};
    const missing = selected && !states[selected] ? `<option value="${esc(selected)}" selected>${esc(selected)} — indisponível</option>` : "";
    return missing + Object.entries(states).sort(([a], [b]) => a.localeCompare(b)).map(([entity, state]) => `<option value="${esc(entity)}" ${entity === selected ? "selected" : ""}>${esc(state.attributes?.friendly_name || entity)} — ${esc(entity)}</option>`).join("");
  };
  proto._renderRobotsPanel = function () {
    const panel = this.shadowRoot.querySelector("#ha3dRobots"); if (!panel) return;
    // Closing/reopening the menu must not discard an unsaved calibration.
    if (this._robotCalibration || this._robotSaving) return;
    const robots = (this._config?.robots || []).map(h50RobotConfig);
    panel.innerHTML = `<div class="ha3dEditorHead"><h3>Robôs</h3></div><p class="ha3dRobotHint">Suporte experimental fechado para Xiaomi H50. A esfera parte da posição real do H50; confirme A, use o pulso assistido para mover um passo curto e confirme B/C. O pulso sempre solta o movimento e sai do modo remoto.</p><div class="ha3dRobotActions"><button id="ha3dAddRobot" type="button">Adicionar Xiaomi H50</button></div><div class="ha3dRobotStatus" id="ha3dRobotAddStatus"></div>${robots.map((robot) => this._robotRow(robot)).join("") || '<p class="ha3dRobotHint">Nenhum Xiaomi H50 configurado.</p>'}`;
    panel.querySelector("#ha3dAddRobot").addEventListener("click", () => this._addRobot());
    robots.forEach((robot) => this._wireRobotRow(robot));
  };
  proto._robotRow = function (robot) {
    robot = h50RobotConfig(robot);
    const c = robot.calibration || {}; const problem = calibrationProblem(c); const fit = transformFor(c);
    const points = calibrationPoints(c);
    return `<div class="ha3dRobotRow" data-robot-id="${esc(robot.id)}">
      <strong>${esc(robot.name || "Robô")}</strong>
      <div class="ha3dRobotMeta">${problem ? esc(problem) : `Calibrado · ${points.length} pontos salvos · erro médio ${fit.error.toFixed(3)} unidades 3D`} · ${esc(H50.position)}</div>
      <details data-robot-settings open><summary>Xiaomi H50, plano e altura do piso</summary><div class="ha3dRobotGrid">
        <label>Nome<input data-field="name" value="${esc(robot.name || "")}"></label>
        <label>Representação<select data-field="display"><option value="icon" ${robot.display !== "object" ? "selected" : ""}>Ícone 3D</option><option value="object" ${robot.display === "object" ? "selected" : ""}>Objeto do GLB</option></select></label>
        <label>Objeto GLB<input data-field="object_name" value="${esc(robot.object_name || "")}" placeholder="Nome do objeto"></label>
        <label>Plano do piso<select data-field="floor_plane">${["xz", "xy", "yz"].map((plane) => `<option value="${plane}" ${(robot.floor_plane || "xz") === plane ? "selected" : ""}>${plane.toUpperCase()} · altura ${floorAxes(plane)[2].toUpperCase()}${plane === "xz" ? " (padrão)" : ""}</option>`).join("")}</select></label>
        <label>Altura fixa do piso<input data-field="floor_y" type="number" step="any" value="${number(robot.floor_y)}"></label>
        <label>Suavização (ms)<input data-field="smoothing_ms" type="number" min="0" value="${number(robot.smoothing_ms, 1600)}"></label>
        <label>Posição antiga (s)<input data-field="stale_after_s" type="number" min="5" value="${number(robot.stale_after_s, 45)}"></label>
        <label>Pulso remoto (ms)<input data-field="remote_pulse_ms" type="number" min="500" max="4000" step="100" value="${number(robot.remote_pulse_ms, 1600)}"></label>
        <label>Espera do sensor (ms)<input data-field="remote_settle_ms" type="number" min="1000" max="20000" step="500" value="${number(robot.remote_settle_ms, 6000)}"></label>
        <label>Correção de direção °<input data-field="heading_offset" type="number" value="${number(c.heading_offset)}"></label>
      </div></details>
      <div class="ha3dRobotStatus" data-live></div>
      <div class="ha3dRobotActions"><button data-action="position">${points.length ? "Editar calibração / posição" : "Calibrar posição"}</button><button data-action="selected">Usar objeto selecionado</button></div>
      <div class="ha3dRobotMeta" data-saved-points>${points.map((p, i) => `${pointName(i)} salvo — sensor ${esc(p.raw.join(" / "))}; cenário ${p.model.map((n) => n.toFixed(2)).join(" / ")}`).join("<br>")}</div>
      <div class="ha3dRobotCalibration" data-calibration hidden>
        <strong data-cal-title>Ajuste manual</strong><p class="ha3dRobotHint" data-cal-hint></p>
        <label style="display:flex"><input type="checkbox" data-show-grid checked> Mostrar grade no piso</label>
        ${["x", "y", "z"].map((axis) => `<label>${axis.toUpperCase()}<input type="range" data-cal-axis="${axis}" aria-label="Ajustar ${axis.toUpperCase()}"><input type="number" step="any" data-cal-number="${axis}" aria-label="Valor ${axis.toUpperCase()}"></label>`).join("")}
        <div class="ha3dRobotActions"><button data-action="confirm">Confirmar ponto A</button><button data-action="auto-step" class="secondary">Pulso e capturar próximo ponto</button><button data-action="next" hidden>Capturar posição atual</button></div>
        <div class="ha3dRobotActions" data-remote-controls><button data-remote-pulse="forward" type="button">Frente</button><button data-remote-pulse="left" type="button" class="secondary">Girar esquerda</button><button data-remote-pulse="right" type="button" class="secondary">Girar direita</button><button data-action="remote-stop" type="button" class="secondary">Parar / sair remoto</button></div>
        <div data-cal-points class="ha3dRobotActions"></div><p class="ha3dRobotHint" data-cal-fit></p>
        <div class="ha3dRobotActions"><button data-action="apply">Salvar calibração</button><button data-action="cancel" class="secondary">Cancelar ajuste</button></div>
      </div>
      <div class="ha3dRobotActions"><button data-action="save">Salvar robô</button><button data-action="delete" class="secondary">Excluir</button></div>
      <div class="ha3dRobotStatus" data-status role="status"></div>
    </div>`;
  };
  proto._addRobot = async function () {
    const status = this.shadowRoot?.querySelector("#ha3dRobotAddStatus");
    if (this._robotSaving || this._robotCalibration) { if (status) status.textContent = "Salve ou cancele o ajuste aberto primeiro."; return; }
    this._setRobotBusy(true);
    if (status) status.textContent = "Criando robô…";
    const existing = this._config?.robots || [];
    if (existing.some((robot) => h50RobotConfig(robot).vacuum_entity === H50.vacuum)) {
      if (status) status.textContent = "O Xiaomi H50 já está configurado.";
      this._setRobotBusy(false);
      return;
    }
    const robots = [...existing, h50RobotConfig({ id: id(), name: H50.name, display: "icon", floor_y: 0, smoothing_ms: 1600, stale_after_s: 45, calibration: { points: [], heading_offset: 0 } })];
    try {
      await this._saveConfigPatch({ robots });
      if (!this._config?.robots?.some((robot) => robot.id === robots.at(-1).id)) {
        throw new Error("O Home Assistant ainda não carregou o suporte a robôs. Reinicie o Home Assistant após atualizar o HA3D.");
      }
      this._rebuildRobots();
    } catch (error) {
      if (status) status.textContent = `Não foi possível criar: ${errorText(error)}`;
      console.error("HA3D: unable to add robot", error);
      return;
    } finally {
      this._setRobotBusy(false);
    }
    this._renderRobotsPanel();
  };
  proto._robotFromRow = function (robot, row) {
    robot = h50RobotConfig(this._config?.robots?.find((item) => item.id === robot.id) || robot);
    const get = (name) => row.querySelector(`[data-field="${name}"]`); const c = { ...(robot.calibration || {}) };
    c.heading_offset = number(get("heading_offset").value);
    if (get("floor_plane").value !== (robot.floor_plane || "xz")) {
      c.points = []; for (const key of ["raw_a", "model_a", "raw_b", "model_b"]) delete c[key];
    }
    return h50RobotConfig({ ...robot, name: get("name").value.trim() || H50.name, display: get("display").value, object_name: get("object_name").value.trim(), floor_plane: get("floor_plane").value, floor_y: number(get("floor_y").value), smoothing_ms: clamp(number(get("smoothing_ms").value, 1600), 0, 60000), stale_after_s: clamp(number(get("stale_after_s").value, 45), 5, 3600), remote_pulse_ms: clamp(number(get("remote_pulse_ms").value, 1600), 500, 4000), remote_settle_ms: clamp(number(get("remote_settle_ms").value, 6000), 1000, 20000), calibration: c });
  };
  proto._wireRobotRow = function (robot) {
    const row = this.shadowRoot.querySelector(`[data-robot-id="${CSS.escape(robot.id)}"]`); if (!row) return; const status = row.querySelector("[data-status]");
    const updateStatus = (text) => { status.textContent = text; };
    row.querySelector('[data-action="selected"]').addEventListener("click", () => { const selected = this._selectedObject; if (!selected || selected.userData?.ha3dRobotCalibration) return updateStatus("Selecione um objeto do GLB no Editor primeiro."); row.querySelector('[data-field="object_name"]').value = selected.userData?.ha3dOriginalNodeName || selected.name; row.querySelector('[data-field="display"]').value = "object"; updateStatus("Objeto selecionado aplicado."); });
    row.querySelector('[data-action="position"]').addEventListener("click", () => this._startRobotCalibration(this._robotFromRow(robot, row), updateStatus));
    row.querySelector("[data-show-grid]").addEventListener("change", (event) => { if (this._robotCalibration?.id === robot.id && this._robotCalibrationGrid) this._robotCalibrationGrid.visible = event.target.checked; });
    row.querySelector('[data-field="floor_y"]').addEventListener("input", (event) => {
      const active = this._robotCalibration; const value = event.target.value;
      if (active?.id !== robot.id || value === "" || !Number.isFinite(Number(value)) || this._robotSaving) return;
      active.draft.floor_y = Number(value);
      const h = floorAxes(active.draft.floor_plane)[2];
      if (this._robotCalibrationMarker) { this._robotCalibrationMarker.position[h] = Number(value); this._showRobotCalibrationControls(robot.id, this._robotCalibrationMarker); }
      if (this._robotCalibrationGrid) this._robotCalibrationGrid.position[h] = Number(value);
      this._renderCalibrationPoints();
    });
    row.querySelectorAll("[data-cal-axis]").forEach((input) => input.addEventListener("input", () => this._moveRobotCalibration(robot.id, input.dataset.calAxis, input.value)));
    row.querySelectorAll("[data-cal-number]").forEach((input) => input.addEventListener("input", () => this._moveRobotCalibration(robot.id, input.dataset.calNumber, input.value)));
    row.querySelector('[data-action="confirm"]').addEventListener("click", () => this._confirmRobotPoint(robot.id, updateStatus));
    row.querySelector('[data-action="auto-step"]').addEventListener("click", () => this._robotAutoStep(robot.id, updateStatus));
    row.querySelectorAll("[data-remote-pulse]").forEach((button) => button.addEventListener("click", () => this._robotRemotePulse(robot.id, button.dataset.remotePulse, updateStatus)));
    row.querySelector('[data-action="remote-stop"]').addEventListener("click", () => this._robotRemoteStop(updateStatus));
    row.querySelector('[data-action="next"]').addEventListener("click", () => this._captureNextRobotPoint(robot.id, updateStatus));
    row.querySelector('[data-action="cancel"]').addEventListener("click", () => { if (!this._robotSaving && this._robotCalibration?.id === robot.id) { this._endRobotCalibration(); updateStatus("Ajuste cancelado. A calibração salva foi mantida."); } });
    for (const action of ["apply", "save"]) row.querySelector(`[data-action="${action}"]`).addEventListener("click", () => this._saveRobotRow(robot.id, updateStatus));
    row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (this._robotSaving || this._robotCalibration) return updateStatus("Salve ou cancele a calibração primeiro.");
      this._setRobotBusy(true);
      try { await this._saveConfigPatch({ robots: (this._config.robots || []).filter((item) => item.id !== robot.id) }); this._rebuildRobots(); }
      catch (error) { updateStatus(`Erro: ${errorText(error)}`); return; }
      finally { this._setRobotBusy(false); }
      this._renderRobotsPanel();
    });
  };

  proto._calibrationRow = function () { return this.shadowRoot?.querySelector(`[data-robot-id="${CSS.escape(this._robotCalibration?.id || "")}"]`); };
  proto._setRobotBusy = function (busy) {
    this._robotSaving = busy;
    this.shadowRoot?.querySelectorAll("#ha3dRobots button, #ha3dRobots input, #ha3dRobots select").forEach((el) => {
      if (busy) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; }
      else { el.disabled = el.dataset.wasDisabled === "true"; delete el.dataset.wasDisabled; }
    });
  };
  proto._startRobotCalibration = function (draft, status) {
    if (this._robotSaving) return;
    if (this._robotCalibration) return status("Termine ou cancele o ajuste aberto primeiro.");
    const points = calibrationPoints(draft.calibration);
    this._robotCalibration = { id: draft.id, draft, points, current: null, index: points.length, confirmed: false, dirty: false };
    this._calibrationRow().querySelector("[data-calibration]").hidden = false;
    this._calibrationRow().querySelector("[data-robot-settings]").open = false;
    const panel = this.shadowRoot.querySelector("#ha3dRobots"); panel.classList.add("calibrating"); panel.scrollTop = 0;
    this._showRobotCalibrationGrid();
    this._renderCalibrationPoints();
    // Editing old points remains available even while the sensor is offline.
    this._captureNextRobotPoint(draft.id, status);
  };
  proto._showRobotCalibrationGrid = function () {
    const active = this._robotCalibration; if (!active || !this._scene) return;
    const bounds = this._model ? new THREE.Box3().setFromObject(this._model) : null;
    const size = bounds && !bounds.isEmpty() ? bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(10, 10, 10);
    const center = bounds && !bounds.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const [a, b, h] = floorAxes(active.draft.floor_plane);
    const grid = new THREE.GridHelper(Math.max(size[a], size[b], 2) * 1.1, 24, 0xffa726, 0x70c9e8);
    if (active.draft.floor_plane === "xy") grid.rotation.x = Math.PI / 2;
    if (active.draft.floor_plane === "yz") grid.rotation.z = Math.PI / 2;
    grid.position.copy(center); grid.position[h] = number(active.draft.floor_y); grid.renderOrder = 9999;
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) { material.depthTest = false; material.depthWrite = false; material.transparent = true; material.opacity = 0.35; }
    grid.visible = this._calibrationRow().querySelector("[data-show-grid]").checked;
    this._scene.add(grid); this._robotCalibrationGrid = grid;
  };
  proto._captureNextRobotPoint = function (robotId, status) {
    const active = this._robotCalibration;
    if (!active || active.id !== robotId || this._robotSaving || this._robotRemoteBusy) return;
    if (active.current && !active.confirmed) return status("Confirme o ponto atual antes de adicionar outro.");
    if (active.points.length >= 50) return status("Limite de 50 pontos. Edite ou remova uma referência existente.");
    const row = this._calibrationRow();
    if (row.querySelector('[data-field="floor_plane"]').value !== active.draft.floor_plane) return status("O plano do piso mudou. Cancele o ajuste e abra a calibração novamente.");
    const raw = getPosition(this._hass, active.draft.position_entity);
    if (!raw) return status("O sensor não fornece X/Y agora. Os pontos anteriores continuam disponíveis para edição.");
    if (active.points.some((p) => Math.hypot(p.raw[0] - raw.x, p.raw[1] - raw.y) < 0.00001)) return status("O sensor ainda mostra a mesma posição de um ponto existente. Mova o robô físico e espere X/Y mudar antes de adicionar outro ponto.");
    const position = previewPosition(raw, { ...active.draft.calibration, points: active.points });
    active.index = active.points.length; active.current = { raw: [raw.x, raw.y], model: [position.x, position.z], heading: raw.heading }; active.confirmed = false; active.dirty = false;
    this._showRobotPoint();
    status(`Ponto ${pointName(active.index)}: leitura capturada. Corrija a esfera e confirme. O robô deve estar parado nesse local.`);
  };
  proto._callRobotService = function (domain, service, entity_id, data = {}) {
    if (!this._hass?.callService) throw new Error("Controle de serviço indisponível no Home Assistant.");
    return this._hass.callService(domain, service, data, { entity_id });
  };
  proto._setRemoteButtons = function (disabled) {
    this.shadowRoot?.querySelectorAll("[data-remote-pulse], [data-action='remote-stop'], [data-action='auto-step']").forEach((button) => { button.disabled = disabled; });
  };
  proto._robotRemoteStop = async function (status = () => {}) {
    status("Parando controle remoto…");
    for (const code of ["2", "4", "6"]) {
      try { await this._callRobotService("notify", "send_message", H50.remoteControl, { message: code }); } catch (error) { console.warn("HA3D: unable to release H50 remote code", code, error); }
    }
    try { await this._callRobotService("button", "press", H50.exitRemote); } catch (error) { console.warn("HA3D: unable to exit H50 remote mode", error); }
    status("Controle remoto parado.");
  };
  proto._robotRemotePulse = async function (robotId, direction, status = () => {}) {
    if (this._robotSaving || this._robotRemoteBusy) return;
    const active = this._robotCalibration;
    if (active && active.id !== robotId) return status("Finalize a calibração aberta antes de controlar outro robô.");
    const codes = { forward: ["1", "2", "frente"], left: ["3", "4", "esquerda"], right: ["5", "6", "direita"] }[direction];
    if (!codes) return;
    const duration = clamp(number(active?.draft?.remote_pulse_ms, 1600), 500, 4000);
    this._robotRemoteBusy = true; this._setRemoteButtons(true);
    try {
      await this._callRobotService("button", "press", H50.enterRemote);
      status(`Controle remoto: ${codes[2]} por ${(duration / 1000).toFixed(1)}s…`);
      await this._callRobotService("notify", "send_message", H50.remoteControl, { message: codes[0] });
      await new Promise((resolve) => setTimeout(resolve, duration));
    } catch (error) {
      status(`Controle remoto falhou: ${errorText(error)}`);
      return;
    } finally {
      try { await this._callRobotService("notify", "send_message", H50.remoteControl, { message: codes?.[1] || "2" }); } catch (error) { console.warn("HA3D: unable to release H50 remote pulse", error); }
      try { await this._callRobotService("button", "press", H50.exitRemote); } catch (error) { console.warn("HA3D: unable to exit H50 remote mode", error); }
      this._robotRemoteBusy = false; this._setRemoteButtons(false);
    }
    const settle = clamp(number(active?.draft?.remote_settle_ms, 6000), 1000, 20000);
    status(`Movimento concluído. Aguarde ${(settle / 1000).toFixed(1)}s e use "Capturar posição atual" quando o X/Y atualizar.`);
  };
  proto._waitForRobotPositionChange = async function (before, timeoutMs = 12000) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const current = getPosition(this._hass, H50.position);
      if (current && (!before || Math.hypot(current.x - before.x, current.y - before.y) > 20 || current.changed !== before.changed)) return current;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return getPosition(this._hass, H50.position);
  };
  proto._robotAutoStep = async function (robotId, status) {
    const active = this._robotCalibration;
    if (!active || active.id !== robotId || this._robotSaving || this._robotRemoteBusy) return;
    if (!active.points.length || (active.current && !active.confirmed)) return status("Confirme o ponto atual antes de usar o pulso seguro.");
    const before = getPosition(this._hass, H50.position);
    if (!before) return status("O sensor do H50 não está trazendo X/Y agora.");
    const row = this._calibrationRow(); const button = row?.querySelector('[data-action="auto-step"]');
    this._robotRemoteBusy = true; if (button) button.disabled = true;
    status("Pulso seguro: entrando no remoto…");
    try {
      await this._callRobotService("button", "press", H50.enterRemote);
      const duration = clamp(number(active.draft.remote_pulse_ms, 1600), 500, 4000);
      status(`Pulso seguro: andando por ${(duration / 1000).toFixed(1)}s…`);
      await this._callRobotService("notify", "send_message", H50.remoteControl, { message: "1" });
      await new Promise((resolve) => setTimeout(resolve, duration));
    } catch (error) {
      status(`Não consegui iniciar o pulso: ${errorText(error)}`);
      return;
    } finally {
      try { await this._callRobotService("notify", "send_message", H50.remoteControl, { message: "2" }); } catch (error) { console.warn("HA3D: unable to release H50 remote forward", error); }
      try { await this._callRobotService("button", "press", H50.exitRemote); } catch (error) { console.warn("HA3D: unable to exit H50 remote mode", error); }
    }
    const settle = clamp(number(active.draft.remote_settle_ms, 6000), 1000, 20000);
    status(`Pulso concluído. Aguardando ${(settle / 1000).toFixed(1)}s para o sensor publicar a posição real…`);
    try {
      await new Promise((resolve) => setTimeout(resolve, settle));
      const after = await this._waitForRobotPositionChange(before);
      if (!after || Math.hypot(after.x - before.x, after.y - before.y) <= 20) return status("O robô parou, mas o sensor ainda não mudou o suficiente. Espere atualizar ou use Adicionar ponto manual.");
      this._robotRemoteBusy = false; if (button) button.disabled = false;
      this._captureNextRobotPoint(robotId, status);
      status(`Novo X/Y detectado: ${Math.round(after.x)} / ${Math.round(after.y)}. Corrija a esfera e confirme o ponto ${pointName(active.index)}.`);
    } finally {
      this._robotRemoteBusy = false; if (button) button.disabled = false;
    }
  };
  proto._showRobotPoint = function () {
    const active = this._robotCalibration; if (!active?.current) return;
    if (!this._robotCalibrationMarker) { this._robotCalibrationMarker = makeCalibrationArrow(); this._scene.add(this._robotCalibrationMarker); }
    const marker = this._robotCalibrationMarker;
    marker.name = `HA3D calibration ${pointName(active.index)}`;
    marker.position.copy(floorVector(active.current.model[0], active.current.model[1], number(active.draft.floor_y), active.draft.floor_plane));
    const heading = Number.isFinite(active.current.heading) ? active.current.heading : 0;
    marker.rotation.y = mapHeading(heading, { ...active.draft.calibration, points: active.points }) || THREE.MathUtils.degToRad(heading);
    this._selectedObject = marker;
    if (this._transformControls) { this._transformControls.detach(); this._transformControls.enabled = false; this._transformControls.visible = false; }
    this._showRobotCalibrationControls(active.id, marker); this._renderCalibrationPoints();
  };
  proto._showRobotCalibrationControls = function (robotId, marker) {
    const row = this.shadowRoot?.querySelector(`[data-robot-id="${CSS.escape(robotId)}"]`); const panel = row?.querySelector("[data-calibration]"); if (!row || !panel) return;
    const bounds = this._model ? new THREE.Box3().setFromObject(this._model) : null;
    for (const axis of ["x", "y", "z"]) {
      const range = panel.querySelector(`[data-cal-axis="${axis}"]`); const output = panel.querySelector(`[data-cal-number="${axis}"]`);
      const span = bounds && !bounds.isEmpty() ? Math.max(1, bounds.max[axis] - bounds.min[axis]) : 20;
      range.min = String(Math.min(marker.position[axis], bounds && !bounds.isEmpty() ? bounds.min[axis] - span * 0.08 : -10)); range.max = String(Math.max(marker.position[axis], bounds && !bounds.isEmpty() ? bounds.max[axis] + span * 0.08 : 10)); range.step = "any"; range.value = String(marker.position[axis]); output.value = String(marker.position[axis]);
    }
    panel.hidden = false;
  };
  proto._moveRobotCalibration = function (robotId, axis, value) {
    const active = this._robotCalibration;
    if (active?.id !== robotId || !this._robotCalibrationMarker || this._robotSaving || !["x", "y", "z"].includes(axis)) return;
    if (axis === floorAxes(active.draft.floor_plane)[2]) return;
    if (value === "" || !Number.isFinite(Number(value))) return;
    this._robotCalibrationMarker.position[axis] = Number(value);
    const [a, b, h] = floorAxes(active.draft.floor_plane);
    active.current.model = [this._robotCalibrationMarker.position[a], this._robotCalibrationMarker.position[b]];
    active.draft.floor_y = this._robotCalibrationMarker.position[h]; active.confirmed = false; active.dirty = true;
    const row = this._calibrationRow(); const range = row.querySelector(`[data-cal-axis="${axis}"]`);
    range.min = String(Math.min(Number(range.min), Number(value))); range.max = String(Math.max(Number(range.max), Number(value))); range.value = value;
    const numeric = row.querySelector(`[data-cal-number="${axis}"]`); if (numeric.value !== value) numeric.value = value;
    row.querySelector('[data-field="floor_y"]').value = String(active.draft.floor_y);
    this._renderCalibrationPoints();
  };
  proto._confirmRobotPoint = function (robotId, status) {
    const active = this._robotCalibration;
    if (!active?.current || active.id !== robotId || this._robotSaving) return false;
    const row = this._calibrationRow();
    for (const input of row.querySelectorAll("[data-cal-number]")) {
      if (input.value === "" || !Number.isFinite(Number(input.value))) { status("Preencha X, Y e Z com números válidos."); return false; }
    }
    active.points[active.index] = { raw: [...active.current.raw], model: [...active.current.model] }; active.confirmed = true;
    this._renderCalibrationPoints(); status(`Ponto ${pointName(active.index)} confirmado no ajuste. Salve a calibração ao terminar.`); return true;
  };
  proto._renderCalibrationPoints = function () {
    const active = this._robotCalibration; const row = this._calibrationRow(); if (!active || !row) return;
    row.querySelector("[data-cal-title]").textContent = active.current ? `Ponto ${pointName(active.index)}${active.confirmed ? " · confirmado" : " · em edição"}` : "Referências da calibração";
    const [a, b, h] = floorAxes(active.draft.floor_plane);
    row.querySelector("[data-cal-hint]").textContent = active.current ? `Sensor capturado: X ${active.current.raw[0]}, Y ${active.current.raw[1]}. ${a.toUpperCase()}/${b.toUpperCase()} movem no piso; ${h.toUpperCase()} define a altura fixa. ${active.points.length < 3 ? "Posição inicial estimada; o encaixe automático precisa de A, B e C." : "Ajuste calculado com as referências confirmadas."}` : "Edite um ponto salvo ou adicione uma nova leitura do sensor.";
    const confirm = row.querySelector('[data-action="confirm"]'); confirm.textContent = `Confirmar ponto ${pointName(active.index)}`; confirm.disabled = !active.current;
    const next = row.querySelector('[data-action="next"]'); next.hidden = Boolean(active.current && !active.confirmed); next.textContent = `Adicionar ponto ${pointName(active.points.length)}`;
    const fit = transformFor({ ...active.draft.calibration, points: active.points });
    row.querySelector("[data-cal-fit]").textContent = fit ? `${active.points.length} referências · erro médio: ${fit.error.toFixed(3)} unidades 3D. Pontos mal posicionados podem piorar o ajuste; edite ou remova se necessário.` : calibrationProblem({ ...active.draft.calibration, points: active.points });
    const list = row.querySelector("[data-cal-points]");
    list.innerHTML = active.points.map((p, i) => `<span><button data-edit-point="${i}" type="button">Editar ${pointName(i)}</button><button data-remove-point="${i}" type="button" class="secondary" aria-label="Remover ponto ${pointName(i)}">×</button></span>`).join("");
    const status = (text) => { row.querySelector("[data-status]").textContent = text; };
    const canSwitch = () => { if (this._robotSaving) return false; if (active.current && !active.confirmed && active.dirty) { status("Confirme o ponto em edição antes de trocar de referência."); return false; } return true; };
    list.querySelectorAll("[data-edit-point]").forEach((button) => button.addEventListener("click", () => {
      if (!canSwitch()) return; active.index = Number(button.dataset.editPoint); const point = active.points[active.index];
      active.current = { raw: [...point.raw], model: [...point.model] }; active.confirmed = true; active.dirty = false; this._showRobotPoint(); status("Editando a referência salva. A leitura original do sensor foi mantida.");
    }));
    list.querySelectorAll("[data-remove-point]").forEach((button) => button.addEventListener("click", () => {
      if (!canSwitch()) return; active.points.splice(Number(button.dataset.removePoint), 1); active.current = null; active.confirmed = false; active.index = active.points.length;
      this._removeCalibrationMarker(); this._renderCalibrationPoints(); status("Ponto removido do ajuste. A alteração só será gravada ao salvar.");
    }));
    row.querySelectorAll("[data-cal-axis], [data-cal-number]").forEach((input) => { input.disabled = !active.current || (input.dataset.calAxis || input.dataset.calNumber) === h; });
  };
  proto._removeCalibrationMarker = function () {
    const marker = this._robotCalibrationMarker;
    if (this._selectedObject === marker) this._selectedObject = null;
    if (this._transformControls?.object === marker) this._transformControls.detach();
    if (marker?.parent) marker.parent.remove(marker);
    marker?.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
    this._robotCalibrationMarker = null;
  };
  proto._endRobotCalibration = function () {
    const row = this._calibrationRow(); this._removeCalibrationMarker(); this._robotCalibration = null;
    this.shadowRoot.querySelector("#ha3dRobots")?.classList.remove("calibrating");
    const grid = this._robotCalibrationGrid; grid?.parent?.remove(grid); grid?.geometry?.dispose();
    if (grid) for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
    this._robotCalibrationGrid = null;
    if (row) row.querySelector("[data-calibration]").hidden = true;
  };
  proto._saveRobotRow = async function (robotId, status) {
    if (this._robotSaving) return;
    const robot = this._config?.robots?.find((item) => item.id === robotId); if (!robot) return;
    const row = this.shadowRoot.querySelector(`[data-robot-id="${CSS.escape(robotId)}"]`);
    const height = row.querySelector('[data-field="floor_y"]');
    if (height.value === "" || !Number.isFinite(Number(height.value))) return status("Informe uma altura fixa válida para o piso.");
    const changed = this._robotFromRow(robot, row); const active = this._robotCalibration;
    if (active && active.id !== robotId) return status("Finalize a calibração do outro robô primeiro.");
    if (active) {
      if (changed.position_entity !== active.draft.position_entity || changed.floor_plane !== active.draft.floor_plane) return status("O sensor ou plano do piso mudou. Cancele o ajuste e abra a calibração novamente.");
      // An untouched prediction for a new point is not a user's confirmed reference.
      if (active.current && (active.dirty || active.confirmed) && !this._confirmRobotPoint(robotId, status)) return;
      changed.calibration.points = active.points.map((p) => ({ raw: [...p.raw], model: [...p.model] }));
      for (const key of ["raw_a", "model_a", "raw_b", "model_b"]) delete changed.calibration[key];
      const problem = calibrationProblem(changed.calibration); if (problem) return status(problem);
    }
    this._setRobotBusy(true); status("Salvando…");
    try {
      await this._saveConfigPatch({ robots: this._config.robots.map((item) => item.id === robotId ? changed : item) });
      const saved = this._config?.robots?.find((item) => item.id === robotId);
      if (!saved || saved.floor_y !== changed.floor_y || saved.floor_plane !== changed.floor_plane || saved.position_entity !== changed.position_entity || JSON.stringify(calibrationPoints(saved.calibration)) !== JSON.stringify(calibrationPoints(changed.calibration))) throw new Error("O servidor não confirmou os pontos. Atualize e reinicie o HA antes de tentar novamente.");
      this._endRobotCalibration(); this._rebuildRobots();
    } catch (error) { status(`Não foi possível salvar: ${errorText(error)}. Seu ajuste foi mantido para tentar novamente.`); return; }
    finally { this._setRobotBusy(false); }
    this._renderRobotsPanel(); this._setStatus("Robô e calibração salvos");
  };
}
