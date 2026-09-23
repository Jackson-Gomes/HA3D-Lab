const LIGHT_STATE_DELAY_MS = 3000;
const START_POLL_MS = 40;
const START_TIMEOUT_MS = 6000;

const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function ensureDelayState(panel) {
  if (!panel._ha3dCinematicLightDelayPending) panel._ha3dCinematicLightDelayPending = new Set();
  if (!panel._ha3dCinematicLightDelayHold) panel._ha3dCinematicLightDelayHold = new Set();
  if (!panel._ha3dCinematicLightDelayTimers) panel._ha3dCinematicLightDelayTimers = new Map();
  if (!panel._ha3dCinematicLightDelayTarget) panel._ha3dCinematicLightDelayTarget = new Map();
  if (!panel._ha3dCinematicLightDelayOffSnapshot) panel._ha3dCinematicLightDelayOffSnapshot = new Map();
}

function isLightEntity(entity) {
  return String(entity || "").startsWith("light.");
}

function currentState(panel, entity) {
  return panel._hass?.states?.[entity]?.state;
}

function bindingLights(binding) {
  if (Array.isArray(binding?.lights) && binding.lights.length) return binding.lights;
  return binding?.light ? [binding.light] : [];
}

function captureBindingVisual(binding) {
  return bindingLights(binding).map((light) => ({
    light,
    intensity: light.intensity,
    castShadow: light.castShadow,
    color: light.color?.clone?.() ?? null,
  }));
}

function suppressVisualLight(panel, entity) {
  const binding = panel._lightBindings?.get?.(entity);
  if (!binding) return;
  for (const light of bindingLights(binding)) {
    light.intensity = 0;
    light.castShadow = false;
  }
}

function restoreDelayedOffVisual(panel, entity) {
  const snapshot = panel._ha3dCinematicLightDelayOffSnapshot?.get?.(entity);
  if (!snapshot?.length) return;

  for (const state of snapshot) {
    if (!state?.light) continue;
    state.light.intensity = state.intensity;
    state.light.castShadow = state.castShadow;
    if (state.color && state.light.color?.copy) state.light.color.copy(state.color);
  }
}

function clearEntityTimer(panel, entity) {
  const timer = panel._ha3dCinematicLightDelayTimers?.get?.(entity);
  if (timer) clearTimeout(timer);
  panel._ha3dCinematicLightDelayTimers?.delete?.(entity);
}

function clearEntityDelay(panel, entity) {
  ensureDelayState(panel);
  clearEntityTimer(panel, entity);
  panel._ha3dCinematicLightDelayPending.delete(entity);
  panel._ha3dCinematicLightDelayHold.delete(entity);
  panel._ha3dCinematicLightDelayTarget.delete(entity);
  panel._ha3dCinematicLightDelayOffSnapshot.delete(entity);
}

function releaseVisualLight(panel, entity) {
  clearEntityDelay(panel, entity);
  panel._syncLightStates?.();
}

function applyDelayedVisual(panel, entity) {
  const target = panel._ha3dCinematicLightDelayTarget?.get?.(entity);
  if (target === "on" && currentState(panel, entity) === "on") {
    suppressVisualLight(panel, entity);
  } else if (target === "off" && currentState(panel, entity) === "off") {
    restoreDelayedOffVisual(panel, entity);
  }
}

function waitForCinematicStart(panel, entity, targetState) {
  ensureDelayState(panel);
  clearEntityTimer(panel, entity);
  const started = Date.now();

  const poll = () => {
    if (
      !panel.isConnected ||
      !panel._cinematicEnabled ||
      currentState(panel, entity) !== targetState
    ) {
      releaseVisualLight(panel, entity);
      return;
    }

    if (panel._cinematicActive && !panel._ha3dCinematicPrepActive) {
      const timer = setTimeout(() => releaseVisualLight(panel, entity), LIGHT_STATE_DELAY_MS);
      panel._ha3dCinematicLightDelayTimers.set(entity, timer);
      return;
    }

    if (Date.now() - started >= START_TIMEOUT_MS) {
      releaseVisualLight(panel, entity);
      return;
    }

    const timer = setTimeout(poll, START_POLL_MS);
    panel._ha3dCinematicLightDelayTimers.set(entity, timer);
  };

  poll();
}

if (!proto.__ha3dCinematicLightDelayV2) {
  proto.__ha3dCinematicLightDelayV2 = true;

  const originalQueue = proto._queueCinematicFocus;
  proto._queueCinematicFocus = function (entity, ...args) {
    ensureDelayState(this);

    if (isLightEntity(entity)) {
      const targetState = currentState(this, entity);
      if (this._cinematicEnabled && (targetState === "on" || targetState === "off")) {
        clearEntityTimer(this, entity);
        this._ha3dCinematicLightDelayPending.add(entity);
        this._ha3dCinematicLightDelayHold.delete(entity);
        this._ha3dCinematicLightDelayTarget.set(entity, targetState);
        if (targetState === "on") this._ha3dCinematicLightDelayOffSnapshot.delete(entity);
      } else {
        clearEntityDelay(this, entity);
      }
    }

    return originalQueue?.call(this, entity, ...args);
  };

  const originalSync = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    ensureDelayState(this);

    const turningOffSnapshots = new Map();
    if (this._cinematicEnabled && this._hass && this._lightBindings?.size) {
      for (const binding of this._lightBindings.values()) {
        if (!isLightEntity(binding.entity)) continue;
        const previous = binding._ha3dCinematicState;
        const next = currentState(this, binding.entity);
        if (previous === "on" && next === "off") {
          turningOffSnapshots.set(binding.entity, captureBindingVisual(binding));
        }
      }
    }

    const result = originalSync?.apply(this, args);

    for (const [entity, snapshot] of turningOffSnapshots) {
      if (
        this._ha3dCinematicLightDelayTarget.get(entity) === "off" &&
        (this._ha3dCinematicLightDelayPending.has(entity) || this._ha3dCinematicLightDelayHold.has(entity))
      ) {
        this._ha3dCinematicLightDelayOffSnapshot.set(entity, snapshot);
      }
    }

    for (const entity of this._ha3dCinematicLightDelayPending) applyDelayedVisual(this, entity);
    for (const entity of this._ha3dCinematicLightDelayHold) applyDelayedVisual(this, entity);

    return result;
  };

  const originalRun = proto._runCinematicFocus;
  proto._runCinematicFocus = function (entities, ...args) {
    ensureDelayState(this);
    const list = Array.isArray(entities) ? entities : [];

    for (const entity of list) {
      const targetState = this._ha3dCinematicLightDelayTarget.get(entity);
      if (
        isLightEntity(entity) &&
        this._ha3dCinematicLightDelayPending.has(entity) &&
        (targetState === "on" || targetState === "off") &&
        currentState(this, entity) === targetState
      ) {
        this._ha3dCinematicLightDelayPending.delete(entity);
        this._ha3dCinematicLightDelayHold.add(entity);
        applyDelayedVisual(this, entity);
        waitForCinematicStart(this, entity, targetState);
      }
    }

    return originalRun?.call(this, entities, ...args);
  };

  const originalDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    ensureDelayState(this);
    for (const timer of this._ha3dCinematicLightDelayTimers.values()) clearTimeout(timer);
    this._ha3dCinematicLightDelayTimers.clear();
    this._ha3dCinematicLightDelayPending.clear();
    this._ha3dCinematicLightDelayHold.clear();
    this._ha3dCinematicLightDelayTarget.clear();
    this._ha3dCinematicLightDelayOffSnapshot.clear();
    return originalDisconnected?.apply(this, args);
  };
}
