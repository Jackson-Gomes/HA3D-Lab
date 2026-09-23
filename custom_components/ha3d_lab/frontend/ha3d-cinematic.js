import * as THREE from "https://esm.sh/three@0.180.0";
import "./ha3d-lab-panel.js";

const CINEMATIC_KEY = "ha3d_lab_cinematic_enabled_v1";
const Panel = customElements.get("ha3d-lab-panel");

if (!Panel) throw new Error("HA3D panel base module was not registered");

const proto = Panel.prototype;

function cinematicEase(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function ensureCinematicState(panel) {
  if (panel._ha3dCinematicReady) return;
  panel._ha3dCinematicReady = true;
  panel._cinematicEnabled = localStorage.getItem(CINEMATIC_KEY) !== "0";
  panel._cinematicPending = new Set();
  panel._cinematicQueue = [];
  panel._cinematicBatchTimer = 0;
  panel._cinematicDrainTimer = 0;
  panel._cinematicActive = false;
}

if (!proto.__ha3dCinematicPatched) {
  proto.__ha3dCinematicPatched = true;

  const originalConnectedCallback = proto.connectedCallback;
  proto.connectedCallback = function () {
    ensureCinematicState(this);
    originalConnectedCallback.call(this);
    this._installCinematicControls();
  };

  const originalDisconnectedCallback = proto.disconnectedCallback;
  proto.disconnectedCallback = function () {
    clearTimeout(this._cinematicBatchTimer);
    clearTimeout(this._cinematicDrainTimer);
    originalDisconnectedCallback.call(this);
  };

  const originalSyncLightStates = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    ensureCinematicState(this);
    const changed = [];

    if (this._hass && this._lightBindings?.size) {
      for (const binding of this._lightBindings.values()) {
        const next = this._hass.states?.[binding.entity]?.state;
        const previous = binding._ha3dCinematicState;
        const previousIsBinary = previous === "on" || previous === "off";
        const nextIsBinary = next === "on" || next === "off";

        if (
          this._cinematicEnabled &&
          previousIsBinary &&
          nextIsBinary &&
          previous !== next
        ) {
          changed.push(binding.entity);
        }
        binding._ha3dCinematicState = next;
      }
    }

    const result = originalSyncLightStates.apply(this, args);
    for (const entity of changed) this._queueCinematicFocus(entity);
    return result;
  };

  proto._installCinematicControls = function () {
    if (!this.shadowRoot || this.shadowRoot.querySelector("#cinematicSection")) return;

    const style = document.createElement("style");
    style.textContent = `
      #cinematicSection{margin:-1px 0 11px;padding:0 1px 11px;border-bottom:1px solid rgba(255,255,255,.11)}
      .cinematicRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .cinematicLabel{font-size:13px;font-weight:650}.cinematicHint{font-size:11px;opacity:.65;line-height:1.35;margin-top:5px}
      .cinematicSwitch{position:relative;width:46px;height:27px;flex:0 0 auto}.cinematicSwitch input{opacity:0;width:0;height:0}
      .cinematicSlider{position:absolute;inset:0;border-radius:99px;background:#45484f;cursor:pointer;transition:.18s}
      .cinematicSlider:before{content:"";position:absolute;width:21px;height:21px;left:3px;top:3px;border-radius:50%;background:#ddd;transition:.18s}
      .cinematicSwitch input:checked+.cinematicSlider{background:var(--primary-color,#03a9f4)}
      .cinematicSwitch input:checked+.cinematicSlider:before{transform:translateX(19px);background:#fff}
      .cinematicTest{width:100%;margin-top:9px;background:#24262c;font-size:12px;min-height:36px;padding:7px 8px}
      #topbar,#viewsPanel,#meta{transition:opacity .22s ease}
      #root.ha3d-cinematic-active #topbar,#root.ha3d-cinematic-active #viewsPanel,#root.ha3d-cinematic-active #meta{opacity:0!important;pointer-events:none!important}
    `;
    this.shadowRoot.appendChild(style);

    const section = document.createElement("div");
    section.id = "cinematicSection";
    section.innerHTML = `
      <div class="cinematicRow">
        <span class="cinematicLabel">Modo cinematográfico</span>
        <label class="cinematicSwitch">
          <input id="cinematicToggle" type="checkbox">
          <span class="cinematicSlider"></span>
        </label>
      </div>
      <div class="cinematicHint">Foca automaticamente a câmera quando uma luz muda de estado.</div>
      <button id="cinematicTest" class="cinematicTest" type="button">Testar animação</button>
    `;

    const panel = this.shadowRoot.querySelector("#viewsPanel");
    const title = panel?.querySelector(".viewsTitle");
    if (!panel) return;
    if (title?.nextSibling) panel.insertBefore(section, title.nextSibling);
    else panel.prepend(section);

    const toggle = section.querySelector("#cinematicToggle");
    toggle.checked = this._cinematicEnabled;
    toggle.addEventListener("change", () => {
      this._cinematicEnabled = toggle.checked;
      localStorage.setItem(CINEMATIC_KEY, this._cinematicEnabled ? "1" : "0");
      if (!this._cinematicEnabled) {
        this._cinematicPending.clear();
        this._cinematicQueue.length = 0;
      }
    });

    section.querySelector("#cinematicTest").addEventListener("click", () => {
      const first = this._lightBindings?.keys?.().next?.().value;
      if (first) this._enqueueCinematicBatch([first]);
    });
  };

  proto._queueCinematicFocus = function (entity) {
    ensureCinematicState(this);
    if (!this._cinematicEnabled || !entity) return;

    this._cinematicPending.add(entity);
    clearTimeout(this._cinematicBatchTimer);
    this._cinematicBatchTimer = setTimeout(() => {
      const batch = [...this._cinematicPending];
      this._cinematicPending.clear();
      if (!batch.length) return;
      this._enqueueCinematicBatch(batch);
    }, 240);
  };

  proto._enqueueCinematicBatch = function (entities) {
    if (!entities?.length) return;
    if (this._cinematicActive || this._cameraAnimating) {
      this._cinematicQueue.push(entities);
      this._scheduleCinematicDrain();
      return;
    }
    this._runCinematicFocus(entities);
  };

  proto._scheduleCinematicDrain = function () {
    clearTimeout(this._cinematicDrainTimer);
    if (!this._cinematicQueue.length) {
      this._restoreCinematicUi();
      return;
    }

    this._cinematicDrainTimer = setTimeout(() => {
      if (this._cinematicActive || this._cameraAnimating) {
        this._scheduleCinematicDrain();
        return;
      }
      const next = this._cinematicQueue.shift();
      if (next?.length) this._runCinematicFocus(next);
      else this._scheduleCinematicDrain();
    }, 180);
  };

  proto._setCinematicMarkerFocus = function (entities) {
    const keep = new Set(entities);
    for (const binding of this._lightBindings?.values?.() || []) {
      binding.marker.style.display = keep.has(binding.entity) ? "" : "none";
    }
    this.shadowRoot?.querySelector("#root")?.classList.add("ha3d-cinematic-active");
    this.shadowRoot?.querySelector("#viewsPanel")?.classList.remove("open");
  };

  proto._restoreCinematicUi = function () {
    for (const binding of this._lightBindings?.values?.() || []) {
      binding.marker.style.display = "";
    }
    this.shadowRoot?.querySelector("#root")?.classList.remove("ha3d-cinematic-active");
  };

  proto._runCinematicFocus = function (entities) {
    if (!this._model || !this._camera || !this._controls) {
      this._scheduleCinematicDrain();
      return;
    }

    const bindings = entities
      .map((entity) => this._lightBindings?.get(entity))
      .filter(Boolean);

    if (!bindings.length) {
      this._scheduleCinematicDrain();
      return;
    }

    const points = bindings.map((binding) => {
      const point = new THREE.Vector3();
      binding.anchor.getWorldPosition(point);
      return point;
    });

    const focus = new THREE.Vector3();
    for (const point of points) focus.add(point);
    focus.multiplyScalar(1 / points.length);

    const box = new THREE.Box3().setFromObject(this._model);
    const size = box.getSize(new THREE.Vector3());
    const sceneScale = Math.max(size.x, size.y, size.z, 1);
    const spread = Math.max(0, ...points.map((point) => point.distanceTo(focus)));

    const startPos = this._camera.position.clone();
    const startTarget = this._controls.target.clone();
    const startUp = this._camera.up.clone();

    let dir = startPos.clone().sub(focus);
    const startDist = Math.max(dir.length(), sceneScale * 0.2);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.45, 1);
    dir.normalize();

    const worldUp = new THREE.Vector3(0, 1, 0);
    const nearDist = Math.min(
      startDist * 0.36,
      Math.max(startDist * 0.20, sceneScale * 0.075 + spread * 2.3),
    );
    const orbitAngle = THREE.MathUtils.degToRad(-22);
    const orbitDir = dir.clone().applyAxisAngle(worldUp, orbitAngle);
    const nearB = focus
      .clone()
      .add(orbitDir.multiplyScalar(nearDist))
      .add(worldUp.clone().multiplyScalar(sceneScale * 0.018));

    const oldDamping = this._controls.enableDamping;
    const oldEnabled = this._controls.enabled;
    this._cinematicActive = true;
    this._cameraAnimating = true;
    this._controls.enabled = false;
    this._controls.enableDamping = false;
    this._setCinematicMarkerFocus(entities);

    const begun = performance.now();
    const approachMs = 3200;
    const orbitStartMs = 2900;
    const orbitEndMs = 5400;
    const holdMs = 450;
    const returnMs = 2800;
    const total = orbitEndMs + holdMs + returnMs;

    const finish = () => {
      this._camera.position.copy(startPos);
      this._controls.target.copy(startTarget);
      this._camera.up.copy(startUp);
      this._camera.lookAt(this._controls.target);
      this._controls.enabled = oldEnabled;
      this._controls.enableDamping = oldDamping;
      this._cinematicActive = false;
      this._cameraAnimating = false;
      this._controls.update();

      if (this._cinematicQueue.length) this._scheduleCinematicDrain();
      else this._restoreCinematicUi();
    };

    const frame = (now) => {
      if (!this._cinematicActive) return;
      const elapsed = now - begun;

      if (elapsed < orbitEndMs) {
        const approachT = Math.min(1, elapsed / approachMs);
        const approachEased = cinematicEase(approachT);
        const orbitT = Math.max(
          0,
          Math.min(1, (elapsed - orbitStartMs) / (orbitEndMs - orbitStartMs)),
        );
        const angle = orbitAngle * cinematicEase(orbitT);
        const currentDir = dir.clone().applyAxisAngle(worldUp, angle);
        const distance = THREE.MathUtils.lerp(startDist, nearDist, approachEased);

        this._camera.position
          .copy(focus)
          .add(currentDir.multiplyScalar(distance))
          .add(worldUp.clone().multiplyScalar(sceneScale * 0.018 * approachEased));
        this._controls.target.lerpVectors(startTarget, focus, approachEased);
      } else if (elapsed < orbitEndMs + holdMs) {
        this._camera.position.copy(nearB);
        this._controls.target.copy(focus);
      } else if (elapsed < total) {
        const returnT = cinematicEase((elapsed - orbitEndMs - holdMs) / returnMs);
        this._camera.position.lerpVectors(nearB, startPos, returnT);
        this._controls.target.lerpVectors(focus, startTarget, returnT);
      } else {
        finish();
        return;
      }

      this._camera.up.copy(startUp);
      this._camera.lookAt(this._controls.target);
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  };
}
