import * as THREE from "https://esm.sh/three@0.180.0";

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const CYAN = 0x54e8ff;
const PASSIVE_INTERVAL_MS = 6800;
const CALLOUT_LIFETIME_MS = 5200;
const MAX_SAMPLES = 28;

function isXrayActive(panel) {
  const controllerActive = panel?._ha3dIdleActive === true;
  const visualActive = panel?.shadowRoot?.querySelector("#root")?.classList.contains("ha3d-idle-xray") === true;
  return Boolean(controllerActive || visualActive);
}

function telemetryState(panel) {
  if (!panel._ha3dLiveTelemetry) {
    panel._ha3dLiveTelemetry = {
      snapshot: new Map(), samples: new Map(), sampleStamp: new Map(), lastAnnounce: new Map(),
      calloutEntity: null, targetObject: null, typingToken: 0, cursor: 0,
      hideTimer: 0, passiveTimer: 0, raf: 0, lastFrame: performance.now(), lastStatusAt: 0,
      started: false, indicator: null,
    };
  }
  return panel._ha3dLiveTelemetry;
}

function stateAge(state) {
  const raw = state?.last_updated || state?.last_changed;
  const ms = raw ? Date.now() - Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return "LIVE";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function scalar(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function formatScalar(value) {
  if (!Number.isFinite(value)) return String(value ?? "—");
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function valueWithUnit(value, unit) {
  const n = scalar(value);
  const text = n == null ? String(value ?? "—") : formatScalar(n);
  return unit ? `${text} ${unit}` : text;
}

function deviceClass(state) {
  return String(state?.attributes?.device_class || "").toLowerCase();
}

function reasonFor(entity, state) {
  const s = String(state?.state || "").toLowerCase();
  if (s === "unavailable" || s === "unknown") return "TELEMETRY LOSS";
  if (String(entity).startsWith("vacuum.") && s === "error") return "VACUUM FAULT";
  const attrs = state?.attributes || {};
  const battery = scalar(attrs.battery_level ?? attrs.battery);
  if (battery != null && battery <= 20) return "ENERGY LOW";
  if (String(entity).startsWith("sensor.") && /battery|bateria/.test(String(entity).toLowerCase())) {
    const value = scalar(state?.state);
    if (value != null && value <= 20) return "ENERGY LOW";
  }
  if (String(entity).startsWith("binary_sensor.") && ["door", "window", "opening"].includes(deviceClass(state)) && s === "on") {
    return "CONTACT OPEN";
  }
  return "LIVE NODE";
}

function displayState(entity, state) {
  const attrs = state?.attributes || {};
  const unit = attrs.unit_of_measurement;
  if (String(entity).startsWith("sensor.") && unit) return valueWithUnit(state?.state, unit);
  if (String(entity).startsWith("light.") && state?.state === "on" && Number.isFinite(Number(attrs.brightness))) {
    return `ON · ${Math.round((Number(attrs.brightness) / 255) * 100)}%`;
  }
  return String(state?.state ?? "—").toUpperCase();
}

function trackedRobotEntry(panel, entity) {
  if (!String(entity || "").startsWith("vacuum.")) return null;
  const entries = panel?._robotEntries;
  if (!(entries instanceof Map)) return null;
  for (const entry of entries.values()) {
    if (entry?.config?.vacuum_entity === entity) return entry;
  }
  return null;
}

function trackedTargetObject(panel, entity) {
  const entry = trackedRobotEntry(panel, entity);
  const tracked = entry?.object || entry?.icon;
  if (tracked?.isObject3D && tracked.visible !== false) return tracked;
  const raw = panel._objectsByEntity?.get?.(entity);
  const objects = Array.isArray(raw) ? raw : (raw instanceof Set ? [...raw] : [raw]);
  return objects.find((item) => item?.isObject3D && item.visible !== false) || null;
}

function firstUseful(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function robotPositionSource(panel, entry) {
  const state = panel?._hass?.states?.[entry?.config?.position_entity];
  if (!state) return {};
  let source = { ...(state.attributes || {}) };
  if (![source.x, source.y, source.a].some((value) => value !== undefined)) {
    try { source = { ...source, ...JSON.parse(state.state) }; } catch (_error) {}
  }
  const embedded = source.vacuum_position || source.position;
  if (embedded && typeof embedded === "object") source = { ...source, ...embedded };
  return source;
}

function robotDetailRows(panel, entity, state) {
  const entry = trackedRobotEntry(panel, entity);
  if (!entry) return null;
  const attrs = state?.attributes || {};
  const pos = robotPositionSource(panel, entry);
  const rows = [["STATE", displayState(entity, state)]];
  const battery = firstUseful(attrs.battery_level, attrs.battery);
  if (battery != null) rows.push(["BATTERY", valueWithUnit(battery, "%")]);
  const room = firstUseful(attrs.current_room, attrs.room_name, attrs.room, attrs.segment_name, attrs.segment, pos.current_room, pos.room_name, pos.room, pos.segment_name, pos.segment);
  if (room != null) rows.push(["ROOM", String(room)]);
  const speed = firstUseful(attrs.current_speed, attrs.movement_speed, attrs.speed, pos.current_speed, pos.movement_speed, pos.speed);
  if (speed != null) rows.push(["SPEED", String(speed)]);
  const heading = firstUseful(pos.a, pos.heading, pos.angle);
  if (heading != null) rows.push(["HEADING", `${formatScalar(scalar(heading) ?? heading)}°`]);
  const x = scalar(pos.x), y = scalar(pos.y);
  if (x != null && y != null) rows.push(["MAP POS", `${formatScalar(x)}, ${formatScalar(y)}`]);
  rows.push(["UPDATED", stateAge(state)]);
  return rows.slice(0, 7);
}

function detailRows(entity, state, panel = null) {
  const robotRows = panel ? robotDetailRows(panel, entity, state) : null;
  if (robotRows) return robotRows;
  const attrs = state?.attributes || {};
  const rows = [["STATE", displayState(entity, state)], ["UPDATED", stateAge(state)]];
  const candidates = [
    ["battery_level", "BATTERY", "%"], ["battery", "BATTERY", "%"],
    ["current_temperature", "TEMP", "°C"], ["temperature", "TARGET", "°C"],
    ["humidity", "HUMIDITY", "%"], ["power", "POWER", "W"],
    ["current", "CURRENT", "A"], ["voltage", "VOLTAGE", "V"],
    ["hvac_action", "HVAC", ""], ["fan_mode", "FAN", ""],
    ["source", "SOURCE", ""], ["media_title", "MEDIA", ""],
  ];
  const used = new Set();
  for (const [key, label, unit] of candidates) {
    if (rows.length >= 5 || attrs[key] == null || used.has(label)) continue;
    used.add(label);
    rows.push([label, valueWithUnit(attrs[key], unit)]);
  }
  const mapPos = attrs.vacuum_position;
  if (rows.length < 5 && mapPos && typeof mapPos === "object") {
    const x = scalar(mapPos.x), y = scalar(mapPos.y);
    if (x != null && y != null) rows.push(["MAP POS", `${formatScalar(x)}, ${formatScalar(y)}`]);
  }
  return rows;
}

function collectSamples(panel) {
  const st = telemetryState(panel);
  const states = panel._hass?.states || {};
  for (const entity of panel._objectsByEntity?.keys?.() || []) {
    const state = states[entity];
    if (!state) continue;
    const value = scalar(state.state);
    if (value == null) continue;
    const stamp = state.last_updated || state.last_changed || "";
    if (st.sampleStamp.get(entity) === stamp) continue;
    st.sampleStamp.set(entity, stamp);
    const list = st.samples.get(entity) || [];
    list.push([Date.now(), value]);
    while (list.length > MAX_SAMPLES) list.shift();
    st.samples.set(entity, list);
  }
}

function sparklineSvg(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const values = samples.map((item) => item[1]).filter(Number.isFinite);
  if (values.length < 2) return null;
  let min = Math.min(...values), max = Math.max(...values);
  if (max === min) { max += 0.5; min -= 0.5; }
  const width = 220, height = 38;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / (max - min)) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.classList.add("ha3dTelemetrySpark");
  const base = document.createElementNS("http://www.w3.org/2000/svg", "line");
  base.setAttribute("x1", "0"); base.setAttribute("x2", String(width));
  base.setAttribute("y1", String(height - 1)); base.setAttribute("y2", String(height - 1));
  base.setAttribute("class", "grid");
  const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyline.setAttribute("points", points); polyline.setAttribute("class", "trace");
  svg.append(base, polyline);
  return svg;
}

function ensureHud(panel) {
  const root = panel?.shadowRoot?.querySelector("#root");
  if (!root) return null;
  let hud = panel.shadowRoot.querySelector("#ha3dLiveTelemetry");
  if (hud) return hud;
  const style = document.createElement("style");
  style.id = "ha3dLiveTelemetryStyle";
  style.textContent = `
    #ha3dLiveTelemetry{position:absolute;inset:0;z-index:18;pointer-events:none;opacity:0;transition:opacity .38s ease;color:#72efff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;text-shadow:0 0 9px rgba(73,225,255,.28);overflow:hidden}
    #ha3dLiveTelemetry.active{opacity:1}
    #ha3dLiveTelemetry .scan{position:absolute;inset:-20% 0;opacity:.24;background:linear-gradient(to bottom,transparent 0%,transparent 48.8%,rgba(84,232,255,.12) 49.8%,rgba(205,251,255,.24) 50%,rgba(84,232,255,.07) 50.2%,transparent 51.1%,transparent 100%);background-size:100% 180px;animation:ha3dTelemetryScan 7.5s linear infinite;mix-blend-mode:screen}
    @keyframes ha3dTelemetryScan{from{transform:translateY(-90px)}to{transform:translateY(90px)}}
    #ha3dTelemetryCorner{position:absolute;left:max(18px,3vw);top:max(22px,4vh);min-width:225px;padding:10px 12px 9px 14px;border-left:2px solid rgba(93,234,255,.76);background:linear-gradient(90deg,rgba(2,18,27,.62),rgba(2,18,27,.16),transparent);letter-spacing:.08em;text-transform:uppercase}
    #ha3dTelemetryCorner .title{font-size:10px;font-weight:800;color:#d9fbff}
    #ha3dTelemetryCorner .status{font-size:9px;margin-top:5px;opacity:.78;white-space:pre}
    #ha3dTelemetryCorner .pulseDot{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:7px;background:#83f4ff;box-shadow:0 0 10px #64eaff;animation:ha3dTelemetryPulse 1.7s ease-in-out infinite}
    @keyframes ha3dTelemetryPulse{50%{opacity:.28;box-shadow:0 0 3px #64eaff}}
    #ha3dTelemetryEvents{position:absolute;left:max(18px,3vw);bottom:max(24px,5vh);width:min(430px,62vw);font-size:9px;line-height:1.55;letter-spacing:.045em;text-transform:uppercase}
    #ha3dTelemetryEvents .event{opacity:.74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #ha3dTelemetryEvents .event::before{content:"> ";opacity:.6}
    #ha3dTelemetryCard{position:absolute;width:250px;min-height:104px;padding:10px 12px 11px 14px;border-left:2px solid rgba(112,240,255,.9);border-top:1px solid rgba(112,240,255,.28);border-bottom:1px solid rgba(112,240,255,.12);background:linear-gradient(100deg,rgba(1,18,28,.86),rgba(1,13,22,.58) 74%,rgba(1,13,22,.12));box-shadow:0 0 25px rgba(40,214,255,.07);opacity:0;transform:translateY(4px);transition:opacity .22s ease,transform .22s ease}
    #ha3dTelemetryCard.visible{opacity:1;transform:translateY(0)}
    #ha3dTelemetryCard.attention{box-shadow:0 0 28px rgba(92,235,255,.18)}
    #ha3dTelemetryCard .kicker{font-size:8px;letter-spacing:.15em;opacity:.65;text-transform:uppercase}
    #ha3dTelemetryCard .name{font-size:12px;font-weight:800;letter-spacing:.06em;color:#e3fcff;margin-top:4px;text-transform:uppercase}
    #ha3dTelemetryCard .entity{font-size:8px;opacity:.52;margin:2px 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #ha3dTelemetryCard .row{display:grid;grid-template-columns:72px 1fr;gap:8px;font-size:9px;line-height:1.52}
    #ha3dTelemetryCard .row span:first-child{opacity:.5}#ha3dTelemetryCard .row span:last-child{color:#c8f9ff}
    #ha3dTelemetryLeader{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    #ha3dTelemetryLeader polyline{fill:none;stroke:rgba(103,237,255,.58);stroke-width:1;vector-effect:non-scaling-stroke}
    #ha3dTelemetryLeader circle{fill:#bcf9ff;filter:drop-shadow(0 0 4px #68eaff)}
    .ha3dTelemetrySpark{display:block;width:100%;height:38px;margin-top:7px;overflow:visible}.ha3dTelemetrySpark .grid{stroke:rgba(102,234,255,.12);stroke-width:1}.ha3dTelemetrySpark .trace{fill:none;stroke:#70efff;stroke-width:1.2;vector-effect:non-scaling-stroke}
    #ha3dTelemetryTicks{position:absolute;right:max(16px,2.4vw);top:26%;height:48%;width:18px;opacity:.26;background:repeating-linear-gradient(to bottom,rgba(120,240,255,.8) 0 1px,transparent 1px 11px)}
    @media(max-width:620px){#ha3dTelemetryCorner{min-width:180px}#ha3dTelemetryCard{width:215px}#ha3dTelemetryEvents{width:72vw}}
  `;
  panel.shadowRoot.appendChild(style);
  hud = document.createElement("div");
  hud.id = "ha3dLiveTelemetry";
  hud.innerHTML = `<div class="scan"></div><svg id="ha3dTelemetryLeader" aria-hidden="true"><polyline points=""></polyline><circle r="2.3" cx="-20" cy="-20"></circle></svg><div id="ha3dTelemetryCorner"><div class="title"><span class="pulseDot"></span>HA3D // SPATIAL TELEMETRY</div><div class="status">LINK INDEX ...\nSTREAM ........</div></div><div id="ha3dTelemetryEvents"></div><div id="ha3dTelemetryCard"></div><div id="ha3dTelemetryTicks"></div>`;
  root.appendChild(hud);
  return hud;
}

function ensureWorldIndicator(panel) {
  const st = telemetryState(panel);
  if (st.indicator || !panel._scene) return st.indicator;
  const group = new THREE.Group();
  group.name = "__HA3D_LIVE_TELEMETRY_INDICATOR__";
  group.visible = false;
  const ringMaterial = new THREE.MeshBasicMaterial({color:CYAN,transparent:true,opacity:.28,depthTest:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
  const ringMaterial2 = ringMaterial.clone(); ringMaterial2.opacity = .11;
  const ring = new THREE.Mesh(new THREE.RingGeometry(.48,.515,64),ringMaterial); ring.rotation.x=-Math.PI/2; ring.renderOrder=1; group.add(ring);
  const outer = new THREE.Mesh(new THREE.RingGeometry(.69,.70,64),ringMaterial2); outer.rotation.x=-Math.PI/2; outer.renderOrder=1; group.add(outer);
  const crossMaterial = new THREE.LineBasicMaterial({color:CYAN,transparent:true,opacity:.34,depthTest:true,depthWrite:false,toneMapped:false});
  const crossGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-.82,0,0),new THREE.Vector3(-.58,0,0),new THREE.Vector3(.58,0,0),new THREE.Vector3(.82,0,0),
    new THREE.Vector3(0,0,-.82),new THREE.Vector3(0,0,-.58),new THREE.Vector3(0,0,.58),new THREE.Vector3(0,0,.82),
  ]);
  const cross = new THREE.LineSegments(crossGeometry,crossMaterial); cross.renderOrder=1; group.add(cross);
  const stemMaterial = new THREE.LineBasicMaterial({color:CYAN,transparent:true,opacity:.22,depthTest:true,depthWrite:false,toneMapped:false});
  const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,.5,0)]),stemMaterial); stem.renderOrder=1; group.add(stem);
  group.userData.ring=ring; group.userData.outer=outer; group.userData.stem=stem; group.userData.baseScale=1;
  panel._scene.add(group); st.indicator=group; return group;
}

function objectBounds(object) {
  try { const box = new THREE.Box3().setFromObject(object); if (!box.isEmpty()) return box; } catch (_error) {}
  const p = new THREE.Vector3(); object?.getWorldPosition?.(p); return new THREE.Box3(p.clone(),p.clone());
}

function targetWorldIndicator(panel, object) {
  const group = ensureWorldIndicator(panel); if (!group || !object) return;
  const box=objectBounds(object), center=box.getCenter(new THREE.Vector3()), size=box.getSize(new THREE.Vector3());
  const floorY=Number.isFinite(box.min.y)?box.min.y:center.y, height=Math.max(.08,center.y-floorY), footprint=Math.max(size.x,size.z,.18);
  const baseScale=Math.max(.22,Math.min(2.2,footprint*.82));
  group.position.set(center.x,floorY+.012,center.z); group.scale.setScalar(baseScale); group.userData.baseScale=baseScale;
  const stem=group.userData.stem; stem.geometry?.dispose?.(); stem.geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,height/baseScale,0)]);
  group.visible=isXrayActive(panel);
}

function typeText(element,text,token,state,speed=15){return new Promise((resolve)=>{element.textContent="";let index=0;const step=()=>{if(state.typingToken!==token||!element.isConnected){resolve();return;}element.textContent=text.slice(0,index);index+=1;if(index<=text.length)setTimeout(step,speed);else resolve();};step();});}

function addEventLine(panel,text){const hud=ensureHud(panel),box=hud?.querySelector("#ha3dTelemetryEvents");if(!box)return;const st=telemetryState(panel),line=document.createElement("div");line.className="event";box.appendChild(line);while(box.children.length>5)box.firstElementChild?.remove();typeText(line,text,st.typingToken,st,11);}

function clearCallout(panel){const st=telemetryState(panel);if(st.hideTimer)clearTimeout(st.hideTimer);st.hideTimer=0;st.calloutEntity=null;st.targetObject=null;st.typingToken+=1;const hud=ensureHud(panel);hud?.querySelector("#ha3dTelemetryCard")?.classList.remove("visible");const poly=hud?.querySelector("#ha3dTelemetryLeader polyline"),dot=hud?.querySelector("#ha3dTelemetryLeader circle");if(poly)poly.setAttribute("points","");if(dot){dot.setAttribute("cx","-20");dot.setAttribute("cy","-20");}if(st.indicator)st.indicator.visible=false;}

async function showCallout(panel,entity,reason=null){if(!isXrayActive(panel))return;const state=panel._hass?.states?.[entity],object=trackedTargetObject(panel,entity);if(!state||!object)return;const st=telemetryState(panel);if(st.hideTimer)clearTimeout(st.hideTimer);st.typingToken+=1;const token=st.typingToken;st.calloutEntity=entity;st.targetObject=object;targetWorldIndicator(panel,object);const hud=ensureHud(panel),card=hud?.querySelector("#ha3dTelemetryCard");if(!card)return;card.innerHTML="";const computedReason=reason||reasonFor(entity,state);card.classList.toggle("attention",computedReason!=="LIVE NODE"&&computedReason!=="STATE CHANGE");const kicker=document.createElement("div"),name=document.createElement("div"),entityLine=document.createElement("div");kicker.className="kicker";name.className="name";entityLine.className="entity";card.append(kicker,name,entityLine);const rows=[];for(const [label,value] of detailRows(entity,state,panel)){const row=document.createElement("div"),a=document.createElement("span"),b=document.createElement("span");row.className="row";row.append(a,b);card.appendChild(row);rows.push([a,b,label,String(value)]);}const spark=sparklineSvg(st.samples.get(entity));if(spark)card.appendChild(spark);card.classList.add("visible");const domain=String(entity).split(".")[0].toUpperCase(),friendly=String(state.attributes?.friendly_name||entity).toUpperCase();await typeText(kicker,`${computedReason} // ${domain}`,token,st,12);await typeText(name,friendly,token,st,14);await typeText(entityLine,entity,token,st,8);for(const [a,b,label,value] of rows){if(st.typingToken!==token)return;a.textContent=label;await typeText(b,value,token,st,9);}st.hideTimer=setTimeout(()=>{if(st.calloutEntity===entity)clearCallout(panel);},CALLOUT_LIFETIME_MS);}

function eligibleEntities(panel){const states=panel._hass?.states||{};return Array.from(panel._objectsByEntity?.keys?.()||[]).filter((entity)=>states[entity]);}
function passiveInspect(panel){if(!isXrayActive(panel)||panel._ha3dAiExplorationActive)return;const st=telemetryState(panel),entities=eligibleEntities(panel);if(!entities.length)return;const entity=entities[st.cursor%entities.length];st.cursor+=1;showCallout(panel,entity,reasonFor(entity,panel._hass.states[entity]));}

function handleHass(panel){const st=telemetryState(panel),states=panel._hass?.states||{};collectSamples(panel);const entities=eligibleEntities(panel),firstPass=st.snapshot.size===0;for(const entity of entities){const state=states[entity],signature=`${state?.state??""}|${state?.last_changed??""}`,previous=st.snapshot.get(entity);st.snapshot.set(entity,signature);if(firstPass||previous==null||previous===signature)continue;const now=Date.now();if(now-(st.lastAnnounce.get(entity)||0)<2500)continue;st.lastAnnounce.set(entity,now);if(isXrayActive(panel)){const reason=reasonFor(entity,state);addEventLine(panel,`${new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}  ${entity}  ${String(state.state).toUpperCase()}`);showCallout(panel,entity,reason==="LIVE NODE"?"STATE CHANGE":reason);}}}

function updateStatus(panel,now){const st=telemetryState(panel);if(now-st.lastStatusAt<900)return;st.lastStatusAt=now;const hud=ensureHud(panel),el=hud?.querySelector("#ha3dTelemetryCorner .status");if(!el)return;const states=panel._hass?.states||{},entities=eligibleEntities(panel),online=entities.filter((entity)=>!["unavailable","unknown"].includes(String(states[entity]?.state))).length;el.textContent=`LINKS ....... ${entities.length}\nONLINE ...... ${online}\nHA STREAM ... ${panel._hass?"CONNECTED":"WAITING"}`;}

function projectTarget(panel){const st=telemetryState(panel),object=st.targetObject,hud=ensureHud(panel),card=hud?.querySelector("#ha3dTelemetryCard"),svg=hud?.querySelector("#ha3dTelemetryLeader"),poly=svg?.querySelector("polyline"),dot=svg?.querySelector("circle");if(!object||!card||!poly||!dot||!panel._camera||!panel._renderer)return;const box=objectBounds(object),point=box.getCenter(new THREE.Vector3());point.y=Math.max(point.y,box.max.y);point.project(panel._camera);if(point.z<-1||point.z>1){card.classList.remove("visible");poly.setAttribute("points","");return;}const canvasRect=panel._renderer.domElement.getBoundingClientRect(),rootRect=hud.getBoundingClientRect(),x=(point.x*.5+.5)*canvasRect.width+canvasRect.left-rootRect.left,y=(-point.y*.5+.5)*canvasRect.height+canvasRect.top-rootRect.top,width=rootRect.width||canvasRect.width,height=rootRect.height||canvasRect.height,cardWidth=Math.min(250,width*.55),cardHeight=Math.max(118,card.offsetHeight||118),goRight=x<width*.56;let cardX=goRight?x+64:x-cardWidth-64,cardY=y-Math.min(70,cardHeight*.42);cardX=Math.max(14,Math.min(width-cardWidth-14,cardX));cardY=Math.max(70,Math.min(height-cardHeight-18,cardY));card.style.left=`${cardX}px`;card.style.top=`${cardY}px`;if(st.calloutEntity)card.classList.add("visible");const edgeX=goRight?cardX:cardX+cardWidth,edgeY=cardY+27,bendX=goRight?Math.min(edgeX-18,x+32):Math.max(edgeX+18,x-32);poly.setAttribute("points",`${x.toFixed(1)},${y.toFixed(1)} ${bendX.toFixed(1)},${y.toFixed(1)} ${edgeX.toFixed(1)},${edgeY.toFixed(1)}`);dot.setAttribute("cx",x.toFixed(1));dot.setAttribute("cy",y.toFixed(1));}

function frame(panel,now){const st=telemetryState(panel);if(!panel.isConnected){st.raf=0;return;}const active=isXrayActive(panel),hud=ensureHud(panel);hud?.classList.toggle("active",active);if(active){updateStatus(panel,now);projectTarget(panel);if(st.indicator?.visible){const dt=Math.min(70,now-st.lastFrame);st.indicator.rotation.y+=dt*.00022;const pulse=1+Math.sin(now*.0032)*.045,s=st.indicator.userData.baseScale*pulse;st.indicator.scale.setScalar(s);}}else if(st.indicator){st.indicator.visible=false;}st.lastFrame=now;st.raf=requestAnimationFrame((time)=>frame(panel,time));}

function start(panel){const st=telemetryState(panel),hud=ensureHud(panel);hud?.classList.add("active");if(st.started)return;st.started=true;const count=eligibleEntities(panel).length;st.typingToken+=1;addEventLine(panel,`SPATIAL LINK INDEX // ${count} BOUND NODES`);setTimeout(()=>isXrayActive(panel)&&addEventLine(panel,`HOME ASSISTANT STREAM // ${panel._hass?"CONNECTED":"WAITING"}`),520);setTimeout(()=>isXrayActive(panel)&&addEventLine(panel,"XRAY TELEMETRY // ACTIVE"),1040);setTimeout(()=>isXrayActive(panel)&&passiveInspect(panel),1750);if(!st.passiveTimer)st.passiveTimer=setInterval(()=>passiveInspect(panel),PASSIVE_INTERVAL_MS);}
function stop(panel){const st=telemetryState(panel);st.started=false;clearCallout(panel);ensureHud(panel)?.classList.remove("active");}
function syncMode(panel){if(isXrayActive(panel))start(panel);else stop(panel);}

function install(panel){if(!panel?.shadowRoot)return;panel._ha3dScannerSync=()=>syncMode(panel);panel._ha3dScannerInspect=(entity,reason="ACTIVE SCAN")=>showCallout(panel,entity,reason);ensureHud(panel);ensureWorldIndicator(panel);const root=panel.shadowRoot.querySelector("#root");if(!root)return;if(!root.__ha3dLiveTelemetryObserver){const observer=new MutationObserver(()=>syncMode(panel));observer.observe(root,{attributes:true,attributeFilter:["class"]});root.__ha3dLiveTelemetryObserver=observer;}const st=telemetryState(panel);if(!st.raf)st.raf=requestAnimationFrame((time)=>frame(panel,time));collectSamples(panel);syncMode(panel);}
function cleanup(panel){const st=telemetryState(panel);if(st.raf)cancelAnimationFrame(st.raf);if(st.passiveTimer)clearInterval(st.passiveTimer);if(st.hideTimer)clearTimeout(st.hideTimer);st.raf=0;st.passiveTimer=0;st.hideTimer=0;st.indicator?.parent?.remove(st.indicator);st.indicator=null;}
function collectPanels(root,found=new Set()){if(!root?.querySelectorAll)return found;for(const element of root.querySelectorAll("*")){if(element.localName==="ha3d-lab-panel")found.add(element);if(element.shadowRoot)collectPanels(element.shadowRoot,found);}return found;}
function installOnExistingPanels(){for(const panel of collectPanels(document))install(panel);}

if(!proto.__ha3dLiveTelemetryV1){
  proto.__ha3dLiveTelemetryV1=true;
  const originalConnected=proto.connectedCallback;
  proto.connectedCallback=function(...args){const result=originalConnected?.apply(this,args);queueMicrotask(()=>install(this));return result;};
  const originalDisconnected=proto.disconnectedCallback;
  proto.disconnectedCallback=function(...args){cleanup(this);return originalDisconnected?.apply(this,args);};
  const originalLoadModel=proto._loadModel;
  proto._loadModel=async function(...args){const result=await originalLoadModel?.apply(this,args);queueMicrotask(()=>install(this));return result;};
  const hassDescriptor=Object.getOwnPropertyDescriptor(proto,"hass");
  if(hassDescriptor?.set){Object.defineProperty(proto,"hass",{configurable:hassDescriptor.configurable??true,enumerable:hassDescriptor.enumerable??false,get:hassDescriptor.get,set(value){hassDescriptor.set.call(this,value);handleHass(this);if(this.isConnected)queueMicrotask(()=>install(this));}});}
  queueMicrotask(installOnExistingPanels);requestAnimationFrame(installOnExistingPanels);setTimeout(installOnExistingPanels,250);setTimeout(installOnExistingPanels,1000);
}
