const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function isXrayActive(panel) {
  return Boolean(panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray"));
}

function statusState(panel) {
  if (!panel._ha3dAmbientStatusState) {
    panel._ha3dAmbientStatusState = { timer: 0, weatherEntity: null };
  }
  return panel._ha3dAmbientStatusState;
}

function findWeather(panel) {
  const st = statusState(panel);
  const states = panel._hass?.states || {};
  if (st.weatherEntity && states[st.weatherEntity]) return states[st.weatherEntity];
  const entity = Object.keys(states).find((id) => id.startsWith("weather."));
  st.weatherEntity = entity || null;
  return entity ? states[entity] : null;
}

function ensureStatus(panel) {
  const root = panel?.shadowRoot?.querySelector("#root");
  if (!root) return null;

  let el = panel.shadowRoot.querySelector("#ha3dAmbientStatus");
  if (el) return el;

  const style = document.createElement("style");
  style.id = "ha3dAmbientStatusStyle";
  style.textContent = `
    #ha3dAmbientStatus{position:absolute;right:max(22px,3.1vw);bottom:max(22px,4.2vh);z-index:17;min-width:225px;padding:10px 14px 11px 18px;pointer-events:none;opacity:0;transform:translateY(5px);transition:opacity .45s ease,transform .55s cubic-bezier(.16,1,.3,1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;text-align:right;text-transform:uppercase;color:#dffcff;text-shadow:0 0 11px rgba(74,226,255,.26);background:linear-gradient(270deg,rgba(1,18,28,.66),rgba(1,14,22,.25) 72%,transparent);border-right:2px solid rgba(113,239,255,.72)}
    #root.ha3d-idle-xray #ha3dAmbientStatus{opacity:.96;transform:translateY(0)}
    #ha3dAmbientStatus .time{font-size:31px;line-height:.95;font-weight:760;letter-spacing:.06em;color:#f1feff}
    #ha3dAmbientStatus .date{margin-top:7px;font-size:10px;font-weight:700;letter-spacing:.14em;color:#87f1ff}
    #ha3dAmbientStatus .weather{margin-top:7px;font-size:9px;letter-spacing:.08em;opacity:.72;white-space:nowrap}
    #ha3dAmbientStatus .weather:empty{display:none}
    @media(max-width:620px){#ha3dAmbientStatus{right:14px;bottom:16px;min-width:178px;padding-right:10px}#ha3dAmbientStatus .time{font-size:25px}}
  `;
  panel.shadowRoot.appendChild(style);

  el = document.createElement("div");
  el.id = "ha3dAmbientStatus";
  el.innerHTML = `<div class="time">--:--</div><div class="date">--</div><div class="weather"></div>`;
  root.appendChild(el);
  return el;
}

function formatCondition(value) {
  return String(value || "").replaceAll("_", " ").replaceAll("-", " ").toUpperCase();
}

function updateStatus(panel) {
  const el = ensureStatus(panel);
  if (!el) return;

  const now = new Date();
  el.querySelector(".time").textContent = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  el.querySelector(".date").textContent = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long", day: "2-digit", month: "long",
  }).format(now).toUpperCase();

  const weather = findWeather(panel);
  const weatherEl = el.querySelector(".weather");
  if (!weather) {
    weatherEl.textContent = "";
    return;
  }

  const attrs = weather.attributes || {};
  const parts = [];
  const condition = formatCondition(weather.state);
  if (condition) parts.push(condition);
  if (attrs.temperature != null) {
    const unit = attrs.temperature_unit || panel._hass?.config?.unit_system?.temperature || "°C";
    parts.push(`${attrs.temperature}${unit}`);
  }
  if (attrs.humidity != null) parts.push(`UMID ${attrs.humidity}%`);
  weatherEl.textContent = parts.join("  ·  ");
}

function install(panel) {
  if (!panel?.shadowRoot) return;
  ensureStatus(panel);
  const st = statusState(panel);
  updateStatus(panel);
  if (!st.timer) st.timer = setInterval(() => updateStatus(panel), 1000);
}

function cleanup(panel) {
  const st = statusState(panel);
  if (st.timer) clearInterval(st.timer);
  st.timer = 0;
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

if (!proto.__ha3dAmbientStatusV1) {
  proto.__ha3dAmbientStatusV1 = true;

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

  const hassDescriptor = Object.getOwnPropertyDescriptor(proto, "hass");
  if (hassDescriptor?.set) {
    Object.defineProperty(proto, "hass", {
      configurable: hassDescriptor.configurable ?? true,
      enumerable: hassDescriptor.enumerable ?? false,
      get: hassDescriptor.get,
      set(value) {
        hassDescriptor.set.call(this, value);
        if (this.isConnected) queueMicrotask(() => updateStatus(this));
      },
    });
  }

  queueMicrotask(installOnExistingPanels);
  requestAnimationFrame(installOnExistingPanels);
  setTimeout(installOnExistingPanels, 300);
}
