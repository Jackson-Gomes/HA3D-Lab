import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const RED = 0xff4d68;
const CYAN = "#71efff";
const MAX_LOG_LINES = 7;

function isXrayActive(panel) {
  const controllerActive = panel?._ha3dIdleActive === true;
  const visualActive = panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray") === true;
  return Boolean(controllerActive || visualActive);
}

function scalar(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function deviceClass(state) {
  return String(state?.attributes?.device_class || "").toLowerCase();
}

function anomalyReason(entity, state) {
  const current = String(state?.state || "").toLowerCase();
  if (current === "unavailable" || current === "unknown") return "TELEMETRY LOSS";
  if (String(entity).startsWith("vacuum.") && current === "error") return "VACUUM FAULT";

  const attrs = state?.attributes || {};
  const battery = scalar(attrs.battery_level ?? attrs.battery);
  if (battery != null && battery <= 20) return "ENERGY LOW";

  if (String(entity).startsWith("sensor.") && /battery|bateria/.test(String(entity).toLowerCase())) {
    const value = scalar(state?.state);
    if (value != null && value <= 20) return "ENERGY LOW";
  }

  if (
    String(entity).startsWith("binary_sensor.") &&
    ["door", "window", "opening"].includes(deviceClass(state)) &&
    current === "on"
  ) {
    return "CONTACT OPEN";
  }

  return null;
}

function formatAge(state) {
  const raw = state?.last_updated || state?.last_changed;
  const ms = raw ? Date.now() - Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return "LIVE";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function stateForDisplay(state) {
  const attrs = state?.attributes || {};
  const unit = attrs.unit_of_measurement;
  const raw = state?.state ?? "—";
  return unit ? `${raw} ${unit}` : String(raw).toUpperCase();
}

function organicState(panel) {
  if (!panel._ha3dOrganicTelemetry) {
    panel._ha3dOrganicTelemetry = {
      snapshot: new Map(),
      anomalies: new Map(),
      dueAt: new Map(),
      logs: [],
      currentEntity: null,
      alertVisibleUntil: 0,
      alertToken: 0,
      placement: { x: 0, y: 0, vertical: 0 },
      raf: 0,
      logCanvas: null,
      logTexture: null,
      logSprite: null,
      logDirty: true,
      lastBoardLayout: 0,
      bootLogged: false,
    };
  }
  return panel._ha3dOrganicTelemetry;
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortEntity(entity) {
  const parts = String(entity || "").split(".");
  return (parts[1] || parts[0] || "node").replaceAll("_", " ").toUpperCase();
}

function appendLog(panel, text, entity = "") {
  const st = organicState(panel);
  st.logs.push({ time: timestamp(), text: String(text), entity: String(entity || "") });
  while (st.logs.length > MAX_LOG_LINES) st.logs.shift();
  st.logDirty = true;
}

function ensureOverlay(panel) {
  const root = panel?.shadowRoot?.querySelector("#root");
  if (!root) return null;

  let layer = panel.shadowRoot.querySelector("#ha3dOrganicTelemetry");
  if (layer) return layer;

  const style = document.createElement("style");
  style.id = "ha3dOrganicTelemetryStyle";
  style.textContent = `
    #ha3dOrganicTelemetry{position:absolute;inset:0;z-index:19;pointer-events:none;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
    #ha3dOrganicAlertLeader{position:absolute;inset:0;width:100%;height:100%;overflow:visible;opacity:0;transition:opacity .36s ease}
    #ha3dOrganicAlertLeader.visible{opacity:1}
    #ha3dOrganicAlertLeader polyline{fill:none;stroke:rgba(255,91,118,.78);stroke-width:1.15;vector-effect:non-scaling-stroke;filter:drop-shadow(0 0 4px rgba(255,65,95,.35))}
    #ha3dOrganicAlertLeader circle{fill:#ffd3dc;filter:drop-shadow(0 0 6px #ff4564)}
    #ha3dOrganicAlertCard{position:absolute;width:min(270px,46vw);padding:11px 14px 12px 15px;opacity:0;border-left:2px solid rgba(255,92,118,.95);border-top:1px solid rgba(255,92,118,.34);border-bottom:1px solid rgba(255,92,118,.17);background:linear-gradient(102deg,rgba(34,5,12,.90),rgba(24,3,9,.65) 72%,rgba(18,2,7,.10));box-shadow:0 0 0 rgba(255,61,91,0);color:#ffd9e0;text-shadow:0 0 10px rgba(255,81,109,.28);letter-spacing:.055em;text-transform:uppercase;transform:translate(var(--organic-x,0px),calc(var(--organic-y,0px) + 5px)) scale(.985);transition:opacity .52s cubic-bezier(.2,.8,.2,1),transform .68s cubic-bezier(.16,1,.3,1);will-change:transform,opacity}
    #ha3dOrganicAlertCard.visible{opacity:.96;transform:translate(var(--organic-x,0px),var(--organic-y,0px)) scale(1);animation:ha3dOrganicAlertBreath var(--organic-breath,4.9s) ease-in-out infinite}
    #ha3dOrganicAlertCard .kicker{font-size:8px;letter-spacing:.18em;color:#ff8095;opacity:.82}
    #ha3dOrganicAlertCard .title{font-size:13px;font-weight:800;color:#fff0f3;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #ha3dOrganicAlertCard .entity{font-size:8px;opacity:.48;margin:2px 0 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #ha3dOrganicAlertCard .row{display:grid;grid-template-columns:72px 1fr;gap:8px;font-size:9px;line-height:1.6}.row .label{opacity:.46}.row .value{color:#ffd7df}
    #ha3dOrganicAlertCard .scanline{position:absolute;left:0;right:0;height:1px;top:18%;background:linear-gradient(90deg,transparent,rgba(255,125,147,.55),transparent);opacity:0;animation:ha3dOrganicAlertScan 3.7s ease-in-out infinite}
    @keyframes ha3dOrganicAlertBreath{0%{filter:brightness(.94);box-shadow:0 0 8px rgba(255,61,91,.06)}9%{filter:brightness(1.09);box-shadow:0 0 28px rgba(255,61,91,.22)}17%{filter:brightness(.98)}38%{filter:brightness(1.02);box-shadow:0 0 14px rgba(255,61,91,.10)}43%{filter:brightness(.88)}47%{filter:brightness(1.12);box-shadow:0 0 32px rgba(255,61,91,.25)}71%{filter:brightness(.96)}88%{filter:brightness(1.06)}100%{filter:brightness(.94);box-shadow:0 0 8px rgba(255,61,91,.06)}}
    @keyframes ha3dOrganicAlertScan{0%,23%{opacity:0;transform:translateY(-10px)}28%{opacity:.5}43%{opacity:0;transform:translateY(80px)}100%{opacity:0;transform:translateY(80px)}}
    @media(max-width:620px){#ha3dOrganicAlertCard{width:min(225px,58vw)}}
  `;
  panel.shadowRoot.appendChild(style);

  layer = document.createElement("div");
  layer.id = "ha3dOrganicTelemetry";
  layer.innerHTML = `
    <svg id="ha3dOrganicAlertLeader" aria-hidden="true"><polyline points=""></polyline><circle r="2.5" cx="-20" cy="-20"></circle></svg>
    <div id="ha3dOrganicAlertCard"><div class="scanline"></div><div class="kicker"></div><div class="title"></div><div class="entity"></div><div class="row"><span class="label">STATE</span><span class="value state"></span></div><div class="row"><span class="label">UPDATED</span><span class="value updated"></span></div></div>
  `;
  root.appendChild(layer);
  return layer;
}

function objectBounds(object) {
  try {
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) return box;
  } catch (_error) {}
  const point = new THREE.Vector3();
  object?.getWorldPosition?.(point);
  return new THREE.Box3(point.clone(), point.clone());
}

function choosePlacement(panel) {
  const height = panel?._renderer?.domElement?.clientHeight || 700;
  const spread = Math.max(38, Math.min(110, height * 0.12));
  const verticalOptions = [-1, -0.62, -0.28, 0.22, 0.58, 1];
  const vertical = verticalOptions[Math.floor(Math.random() * verticalOptions.length)] * spread;
  return {
    x: Math.round((Math.random() - 0.5) * 42),
    y: Math.round((Math.random() - 0.5) * 20),
    vertical,
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function typeOrganic(element, text, token, panel) {
  element.textContent = "";
  let index = 0;
  const st = organicState(panel);
  const step = () => {
    if (st.alertToken !== token || !element.isConnected) return;
    element.textContent = text.slice(0, index);
    index += 1;
    if (index <= text.length) {
      const punctuation = /[.:/\-]/.test(text[index - 1] || "");
      setTimeout(step, punctuation ? randomBetween(34, 82) : randomBetween(10, 27));
    }
  };
  step();
}

function hideAlert(panel, resolved = false) {
  const st = organicState(panel);
  const layer = ensureOverlay(panel);
  const card = layer?.querySelector("#ha3dOrganicAlertCard");
  const leader = layer?.querySelector("#ha3dOrganicAlertLeader");
  card?.classList.remove("visible");
  leader?.classList.remove("visible");
  if (resolved && st.currentEntity) st.dueAt.delete(st.currentEntity);
  st.currentEntity = null;
  st.alertVisibleUntil = 0;
  st.alertToken += 1;
}

function showAlert(panel, entity, reason) {
  if (!isXrayActive(panel)) return false;
  const state = panel._hass?.states?.[entity];
  const object = panel._objectsByEntity?.get?.(entity)?.[0];
  if (!state || !object || !reason) return false;

  const st = organicState(panel);
  const layer = ensureOverlay(panel);
  const card = layer?.querySelector("#ha3dOrganicAlertCard");
  const leader = layer?.querySelector("#ha3dOrganicAlertLeader");
  if (!card || !leader) return false;

  st.currentEntity = entity;
  st.alertVisibleUntil = performance.now() + randomBetween(7600, 11200);
  st.placement = choosePlacement(panel);
  st.alertToken += 1;
  const token = st.alertToken;

  card.style.setProperty("--organic-x", `${st.placement.x}px`);
  card.style.setProperty("--organic-y", `${st.placement.y}px`);
  card.style.setProperty("--organic-breath", `${randomBetween(4.1, 6.4).toFixed(2)}s`);
  card.querySelector(".kicker").textContent = "";
  card.querySelector(".title").textContent = "";
  card.querySelector(".entity").textContent = "";
  card.querySelector(".value.state").textContent = stateForDisplay(state);
  card.querySelector(".value.updated").textContent = formatAge(state);

  card.classList.add("visible");
  leader.classList.add("visible");

  typeOrganic(card.querySelector(".kicker"), `ALERT // ${reason}`, token, panel);
  setTimeout(() => typeOrganic(card.querySelector(".title"), String(state.attributes?.friendly_name || shortEntity(entity)), token, panel), randomBetween(90, 220));
  setTimeout(() => typeOrganic(card.querySelector(".entity"), entity, token, panel), randomBetween(260, 520));

  appendLog(panel, `${reason} · ${shortEntity(entity)}`, entity);
  return true;
}

function refreshAnomalies(panel) {
  const st = organicState(panel);
  const states = panel._hass?.states || {};
  const bound = Array.from(panel._objectsByEntity?.keys?.() || []);
  const now = Date.now();
  const seen = new Set();

  for (const entity of bound) {
    const state = states[entity];
    if (!state) continue;
    seen.add(entity);

    const signature = `${state.state}|${state.last_changed || ""}`;
    const previousSignature = st.snapshot.get(entity);
    st.snapshot.set(entity, signature);

    const reason = anomalyReason(entity, state);
    const previousReason = st.anomalies.get(entity) || null;

    if (reason) {
      st.anomalies.set(entity, reason);
      if (!previousReason) {
        st.dueAt.set(entity, now + randomBetween(150, 650));
        appendLog(panel, `ALERT OPEN · ${reason} · ${shortEntity(entity)}`, entity);
      } else if (previousReason !== reason) {
        st.dueAt.set(entity, now + randomBetween(100, 500));
        appendLog(panel, `ALERT UPDATE · ${reason} · ${shortEntity(entity)}`, entity);
      }
    } else if (previousReason) {
      st.anomalies.delete(entity);
      st.dueAt.delete(entity);
      appendLog(panel, `ALERT CLEAR · ${shortEntity(entity)}`, entity);
      if (st.currentEntity === entity) hideAlert(panel, true);
    } else if (previousSignature && previousSignature !== signature) {
      appendLog(panel, `STATE · ${shortEntity(entity)} · ${String(state.state).toUpperCase()}`, entity);
    }
  }

  for (const entity of Array.from(st.anomalies.keys())) {
    if (!seen.has(entity)) {
      st.anomalies.delete(entity);
      st.dueAt.delete(entity);
      if (st.currentEntity === entity) hideAlert(panel, true);
    }
  }
}

function scheduleAnomaly(panel, nowMs) {
  const st = organicState(panel);
  if (!isXrayActive(panel)) {
    hideAlert(panel);
    return;
  }

  if (st.currentEntity) {
    const currentReason = st.anomalies.get(st.currentEntity);
    if (!currentReason) {
      hideAlert(panel, true);
      return;
    }
    if (nowMs >= st.alertVisibleUntil) {
      const entity = st.currentEntity;
      hideAlert(panel);
      st.dueAt.set(entity, Date.now() + randomBetween(4800, 10500));
    }
    return;
  }

  const now = Date.now();
  const due = Array.from(st.anomalies.entries())
    .filter(([entity]) => (st.dueAt.get(entity) ?? 0) <= now)
    .sort((a, b) => (st.dueAt.get(a[0]) ?? 0) - (st.dueAt.get(b[0]) ?? 0));

  if (!due.length) return;
  const [entity, reason] = due[0];
  if (showAlert(panel, entity, reason)) {
    st.dueAt.set(entity, now + randomBetween(12000, 22000));
  }
}

function projectAlert(panel) {
  const st = organicState(panel);
  if (!st.currentEntity) return;

  const object = panel._objectsByEntity?.get?.(st.currentEntity)?.[0];
  const layer = ensureOverlay(panel);
  const card = layer?.querySelector("#ha3dOrganicAlertCard");
  const svg = layer?.querySelector("#ha3dOrganicAlertLeader");
  const poly = svg?.querySelector("polyline");
  const dot = svg?.querySelector("circle");
  if (!object || !card || !poly || !dot || !panel._camera || !panel._renderer) return;

  const box = objectBounds(object);
  const point = box.getCenter(new THREE.Vector3());
  point.y = Math.max(point.y, box.max.y);
  point.project(panel._camera);

  if (point.z < -1 || point.z > 1) {
    card.style.opacity = "0";
    poly.setAttribute("points", "");
    return;
  }

  card.style.opacity = "";
  const canvasRect = panel._renderer.domElement.getBoundingClientRect();
  const rootRect = layer.getBoundingClientRect();
  const width = rootRect.width || canvasRect.width;
  const height = rootRect.height || canvasRect.height;
  const x = (point.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left - rootRect.left;
  const y = (-point.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top - rootRect.top;
  const cardWidth = Math.min(card.offsetWidth || 270, width * 0.52);
  const cardHeight = Math.max(card.offsetHeight || 118, 118);
  const goRight = x < width * 0.56;

  let cardX = goRight ? x + 72 : x - cardWidth - 72;
  let cardY = y - cardHeight * 0.36 + st.placement.vertical;
  cardX = Math.max(14, Math.min(width - cardWidth - 14, cardX));
  cardY = Math.max(26, Math.min(height - cardHeight - 22, cardY));

  card.style.left = `${cardX}px`;
  card.style.top = `${cardY}px`;

  const edgeX = goRight ? cardX : cardX + cardWidth;
  const edgeY = Math.max(cardY + 22, Math.min(cardY + cardHeight - 22, y + st.placement.vertical * 0.18));
  const bendX = goRight ? Math.min(edgeX - 18, x + 36) : Math.max(edgeX + 18, x - 36);
  const middleY = y + st.placement.vertical * 0.08;

  poly.setAttribute("points", `${x.toFixed(1)},${y.toFixed(1)} ${bendX.toFixed(1)},${middleY.toFixed(1)} ${edgeX.toFixed(1)},${edgeY.toFixed(1)}`);
  dot.setAttribute("cx", x.toFixed(1));
  dot.setAttribute("cy", y.toFixed(1));
}

function ensureLogBoard(panel) {
  const st = organicState(panel);
  if (st.logSprite || !panel._scene) return st.logSprite;

  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 360;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = "__HA3D_ORGANIC_LIVE_LOG_BOARD__";
  sprite.visible = false;
  sprite.renderOrder = 0;
  panel._scene.add(sprite);

  st.logCanvas = canvas;
  st.logTexture = texture;
  st.logSprite = sprite;
  st.logDirty = true;
  return sprite;
}

function drawLogBoard(panel) {
  const st = organicState(panel);
  const sprite = ensureLogBoard(panel);
  const canvas = st.logCanvas;
  if (!sprite || !canvas || !st.logTexture) return;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0, "rgba(0,16,25,.68)");
  grad.addColorStop(.72, "rgba(0,12,20,.26)");
  grad.addColorStop(1, "rgba(0,8,14,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(113,239,255,.72)";
  ctx.fillRect(20, 24, 3, 302);
  ctx.font = "700 20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillStyle = "rgba(205,250,255,.78)";
  ctx.fillText("HA3D // LIVE EVENT LOG", 42, 52);

  ctx.font = "15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const lines = st.logs.slice(-MAX_LOG_LINES);
  lines.forEach((line, index) => {
    const y = 92 + index * 34;
    const ageAlpha = 0.34 + (index / Math.max(1, lines.length - 1)) * 0.42;
    ctx.fillStyle = `rgba(113,239,255,${ageAlpha.toFixed(2)})`;
    ctx.fillText(`${line.time}  ${line.text}`.slice(0, 74), 42, y);
  });

  if (!lines.length) {
    ctx.fillStyle = "rgba(113,239,255,.34)";
    ctx.fillText("WAITING FOR BOUND-ENTITY EVENTS...", 42, 98);
  }

  st.logTexture.needsUpdate = true;
  st.logDirty = false;
}

function layoutLogBoard(panel) {
  const st = organicState(panel);
  const sprite = ensureLogBoard(panel);
  if (!sprite || !panel._model || !panel._camera) return;

  const box = objectBounds(panel._model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1);

  const cameraToCenter = center.clone().sub(panel._camera.position);
  cameraToCenter.y = 0;
  if (cameraToCenter.lengthSq() < 0.0001) cameraToCenter.set(0, 0, -1);
  cameraToCenter.normalize();
  const side = new THREE.Vector3(-cameraToCenter.z, 0, cameraToCenter.x);

  const position = center.clone()
    .add(cameraToCenter.multiplyScalar(extent * 0.78))
    .add(side.multiplyScalar(extent * 0.48));
  position.y = center.y + extent * 0.26;
  sprite.position.copy(position);
  sprite.scale.set(extent * 0.74, extent * 0.30, 1);
  sprite.visible = isXrayActive(panel);
}

function bootLogs(panel) {
  const st = organicState(panel);
  if (st.bootLogged) return;
  const bound = Array.from(panel._objectsByEntity?.keys?.() || []);
  if (!bound.length) return;
  st.bootLogged = true;
  const states = panel._hass?.states || {};
  const online = bound.filter((entity) => !["unknown", "unavailable"].includes(String(states[entity]?.state || ""))).length;
  appendLog(panel, `LINK INDEX · ${bound.length} BOUND NODES`);
  appendLog(panel, `HA STREAM · ${online}/${bound.length} ONLINE`);
}

function frame(panel, now) {
  const st = organicState(panel);
  if (!panel.isConnected) {
    st.raf = 0;
    return;
  }

  bootLogs(panel);
  scheduleAnomaly(panel, now);
  projectAlert(panel);

  const sprite = ensureLogBoard(panel);
  if (sprite) {
    sprite.visible = isXrayActive(panel);
    if (sprite.visible) {
      if (st.logDirty) drawLogBoard(panel);
      if (now - st.lastBoardLayout > 80) {
        layoutLogBoard(panel);
        st.lastBoardLayout = now;
      }
    }
  }

  st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function install(panel) {
  if (!panel?.shadowRoot) return;
  ensureOverlay(panel);
  ensureLogBoard(panel);
  refreshAnomalies(panel);
  const st = organicState(panel);
  if (!st.raf) st.raf = requestAnimationFrame((time) => frame(panel, time));
}

function cleanup(panel) {
  const st = organicState(panel);
  if (st.raf) cancelAnimationFrame(st.raf);
  st.raf = 0;
  st.alertToken += 1;
  st.logSprite?.parent?.remove(st.logSprite);
  st.logSprite?.material?.map?.dispose?.();
  st.logSprite?.material?.dispose?.();
  st.logSprite = null;
  st.logTexture = null;
  st.logCanvas = null;
}

function collectPanels(root, found = new Set()) {
  if (!root?.querySelectorAll) return found;
  for (const element of root.querySelectorAll("*")) {
    if (element.localName === "ha3d-lab-panel") found.add(element);
    if (element.shadowRoot) collectPanels(element.shadowRoot, found);
  }
  return found;
}

function installOnExistingPanels() {
  for (const panel of collectPanels(document)) install(panel);
}

if (!proto.__ha3dOrganicTelemetryV1) {
  proto.__ha3dOrganicTelemetryV1 = true;

  const originalConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = originalConnected?.apply(this, args);
    queueMicrotask(() => install(this));
    return result;
  };

  const originalDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    cleanup(this);
    return originalDisconnected?.apply(this, args);
  };

  const originalLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await originalLoadModel?.apply(this, args);
    queueMicrotask(() => install(this));
    return result;
  };

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: hassDescriptor.configurable ?? true,
      enumerable: hassDescriptor.enumerable ?? false,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        refreshAnomalies(this);
        if (this.isConnected) queueMicrotask(() => install(this));
      },
    });
  }

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 250);
  setTimeout(installOnExistingPanels, 1000);
}
