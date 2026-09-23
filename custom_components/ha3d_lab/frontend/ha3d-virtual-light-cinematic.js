const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

const TOKEN_PREFIX = "__ha3d_virtual_light__:";

function tokenFor(id) {
  return `${TOKEN_PREFIX}${id}`;
}

function idFromToken(value) {
  const text = String(value || "");
  return text.startsWith(TOKEN_PREFIX) ? text.slice(TOKEN_PREFIX.length) : null;
}

function virtualConfigs(panel) {
  return Array.isArray(panel?._config?.virtual_lights) ? panel._config.virtual_lights : [];
}

function visibleVirtualIdsForEntity(panel, entity) {
  return virtualConfigs(panel)
    .filter((item) => item?.entity_id === entity && item?.id && item.show_marker !== false)
    .map((item) => item.id);
}

function binaryStateFor(panel, config) {
  if (config?.entity_id) {
    const state = panel?._hass?.states?.[config.entity_id]?.state;
    return state === "on" || state === "off" ? state : null;
  }
  return config?.enabled === false ? "off" : "on";
}

function ensureStateCache(panel) {
  panel._ha3dVirtualCinematicState ||= new Map();
  return panel._ha3dVirtualCinematicState;
}

function installSyntheticBindings(panel, entities) {
  const installed = [];
  const bindings = panel?._lightBindings;
  if (!bindings?.set) return installed;

  for (const entity of entities || []) {
    const id = idFromToken(entity);
    if (!id) continue;
    const runtime = panel._ha3dVirtualLights?.get?.(id);
    if (!runtime?.handle) continue;

    const had = bindings.has(entity);
    const previous = bindings.get(entity);
    const marker = panel._ha3dVirtualLightMarkers?.get?.(id) || document.createElement("span");
    bindings.set(entity, {
      entity,
      name: runtime.config?.name || id,
      anchor: runtime.handle,
      light: runtime.light || null,
      lights: runtime.light ? [runtime.light] : [],
      marker,
      ha3dVirtualCinematic: true,
    });
    installed.push({ entity, had, previous });
  }

  return installed;
}

function restoreSyntheticBindings(panel, installed) {
  const bindings = panel?._lightBindings;
  if (!bindings) return;
  for (const item of installed) {
    if (item.had) bindings.set(item.entity, item.previous);
    else bindings.delete(item.entity);
  }
}

function updateVirtualMarkerFocus(panel, entities) {
  const focusedIds = new Set((entities || []).map(idFromToken).filter(Boolean));
  for (const [id, marker] of panel?._ha3dVirtualLightMarkers?.entries?.() || []) {
    marker.style.display = focusedIds.has(id) ? "" : "none";
  }
}

function restoreVirtualMarkers(panel) {
  const configById = new Map(virtualConfigs(panel).map((item) => [item.id, item]));
  for (const [id, marker] of panel?._ha3dVirtualLightMarkers?.entries?.() || []) {
    marker.style.display = configById.get(id)?.show_marker === false ? "none" : "";
  }
}

if (!proto.__ha3dVirtualLightCinematicV2) {
  proto.__ha3dVirtualLightCinematicV2 = true;

  // A normal HA entity can own several virtual lights. Cinematic focus uses
  // only the virtual lights whose marker is enabled; one marker means one exact
  // focus point, several markers are framed together, no markers means no
  // virtual-light cinematic focus for that entity.
  const oldQueue = proto._queueCinematicFocus;
  proto._queueCinematicFocus = function (entity, ...args) {
    if (!idFromToken(entity)) {
      const virtualIds = visibleVirtualIdsForEntity(this, entity);
      if (virtualIds.length) {
        let result;
        for (const id of virtualIds) result = oldQueue?.call(this, tokenFor(id), ...args);
        return result;
      }

      const ownsVirtualLights = virtualConfigs(this).some((item) => item?.entity_id === entity);
      if (ownsVirtualLights) return;
    }
    return oldQueue?.call(this, entity, ...args);
  };

  // The original cinematic detector only watches _lightBindings. Virtual lights
  // are intentionally outside that map, so detect their binary state changes
  // here. If a classic binding also exists for the same entity, the original
  // detector already queues it and our queue wrapper redirects it to the chosen
  // virtual marker(s), avoiding a duplicate event.
  const oldSync = proto._syncLightStates;
  proto._syncLightStates = function (...args) {
    const cache = ensureStateCache(this);
    const changedEntities = new Set();
    const changedLocalTokens = [];
    const activeIds = new Set();

    for (const config of virtualConfigs(this)) {
      if (!config?.id) continue;
      activeIds.add(config.id);
      const next = binaryStateFor(this, config);
      const previous = cache.get(config.id);
      if (
        this._cinematicEnabled &&
        config.show_marker !== false &&
        (previous === "on" || previous === "off") &&
        (next === "on" || next === "off") &&
        previous !== next
      ) {
        if (config.entity_id) changedEntities.add(config.entity_id);
        else changedLocalTokens.push(tokenFor(config.id));
      }
      cache.set(config.id, next);
    }

    for (const id of [...cache.keys()]) {
      if (!activeIds.has(id)) cache.delete(id);
    }

    const result = oldSync?.apply(this, args);

    for (const entity of changedEntities) {
      if (!this._lightBindings?.has?.(entity)) this._queueCinematicFocus?.(entity);
    }
    for (const token of changedLocalTokens) this._queueCinematicFocus?.(token);
    return result;
  };

  // Reuse the proven camera animation without altering its implementation:
  // expose virtual-light handles as temporary bindings only during focus setup.
  const oldRun = proto._runCinematicFocus;
  proto._runCinematicFocus = function (entities, ...args) {
    const list = Array.isArray(entities) ? entities : [];
    const installed = installSyntheticBindings(this, list);
    try {
      return oldRun?.call(this, entities, ...args);
    } finally {
      restoreSyntheticBindings(this, installed);
    }
  };

  const oldMarkerFocus = proto._setCinematicMarkerFocus;
  proto._setCinematicMarkerFocus = function (entities, ...args) {
    const result = oldMarkerFocus?.call(this, entities, ...args);
    updateVirtualMarkerFocus(this, entities);
    return result;
  };

  const oldRestoreUi = proto._restoreCinematicUi;
  proto._restoreCinematicUi = function (...args) {
    const result = oldRestoreUi?.apply(this, args);
    restoreVirtualMarkers(this);
    return result;
  };
}
