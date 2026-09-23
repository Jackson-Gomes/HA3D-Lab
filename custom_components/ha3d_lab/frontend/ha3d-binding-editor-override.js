const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const UNBOUND = "ha3d.__unbound__";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function objectKey(object) {
  return String(object?.userData?.ha3dOriginalNodeName || object?.name || "").trim();
}

function namesForObject(object) {
  const names = [];
  const original = String(object?.userData?.ha3dOriginalNodeName || "").trim();
  const current = String(object?.name || "").trim();
  if (original) names.push(original);
  if (current && current !== original) names.push(current);
  return names;
}

function subtreeNames(root) {
  const names = new Set();
  root?.traverse?.((node) => {
    for (const name of namesForObject(node)) names.add(name);
  });
  return names;
}

function sourceRank(source) {
  return source === "advanced" ? 0 : source === "explicit" ? 1 : 2;
}

function bindingCandidates(panel, root) {
  const config = panel?._config || {};
  const advanced = config.advanced_bindings || {};
  const explicit = config.bindings || {};
  const states = panel?._hass?.states || {};
  const autoBind = config.auto_bind !== false;
  const rootKey = objectKey(root);
  const names = subtreeNames(root);
  const byKey = new Map();

  for (const name of names) {
    const advancedConfig = advanced[name];
    if (advancedConfig?.entity_id && states[advancedConfig.entity_id]) {
      byKey.set(name, { key: name, entity: advancedConfig.entity_id, source: "advanced", config: advancedConfig });
      continue;
    }

    if (hasOwn(explicit, name)) {
      const entity = explicit[name];
      if (entity !== UNBOUND && states[entity]) {
        byKey.set(name, { key: name, entity, source: "explicit", config: advancedConfig || null });
      }
      continue;
    }

    if (autoBind && states[name]) {
      byKey.set(name, { key: name, entity: name, source: "auto", config: advancedConfig || null });
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const leftExact = left.key === rootKey ? 0 : 1;
    const rightExact = right.key === rootKey ? 0 : 1;
    return leftExact - rightExact || sourceRank(left.source) - sourceRank(right.source) || left.key.localeCompare(right.key);
  });
}

function applyCandidateToForm(panel, candidate) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!body) return;
  const config = candidate?.config || {};
  const entityInput = body.querySelector("#ha3dEntity");
  const readings = body.querySelector("#ha3dReadings");
  const rules = body.querySelector("#ha3dRules");
  const zoomOnly = body.querySelector("#ha3dZoomOnly");
  const area = body.querySelector("#ha3dArea");

  if (entityInput) entityInput.value = candidate?.entity || "";
  if (readings) readings.value = (config.readings || []).map((item) => typeof item === "string" ? item : `${item.entity_id || ""}${item.attribute ? `:${item.attribute}` : ""}`).join("\n");
  if (rules) rules.value = JSON.stringify(config.state_rules || []);
  if (zoomOnly) zoomOnly.checked = Boolean(config.show_only_when_zoomed);
  if (area) area.value = panel?._config?.area_bindings?.[candidate?.key] || "";
}

function installBindingSourceUi(panel) {
  const root = panel?._selectedObject;
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!root || !body) return;

  const rootKey = objectKey(root);
  const candidates = bindingCandidates(panel, root);
  const active = candidates[0] || null;
  panel._ha3dEditorBindingContext = { rootKey, candidates, active };

  body.querySelector("#ha3dBindingSourceInfo")?.remove();

  const box = document.createElement("div");
  box.id = "ha3dBindingSourceInfo";
  box.className = "ha3dRow";

  if (!candidates.length) {
    box.innerHTML = `<label>Binding deste objeto</label><span class="ha3dHint">Nenhum binding existente. Ao salvar, o vínculo será criado no objeto inteiro.</span>`;
  } else if (candidates.length === 1) {
    const candidate = candidates[0];
    const moved = candidate.key !== rootKey;
    box.innerHTML = `<label>Binding deste objeto</label><span class="ha3dHint">${moved ? `Encontrado em uma subpeça: <b>${candidate.key}</b>. Ao salvar, será migrado para <b>${rootKey}</b>.` : `Origem: <b>${candidate.source === "auto" ? "automático pelo nome do GLB" : candidate.source}</b>.`}</span>`;
    applyCandidateToForm(panel, candidate);
  } else {
    const select = document.createElement("select");
    select.id = "ha3dBindingSourceSelect";
    for (const candidate of candidates) {
      const option = document.createElement("option");
      option.value = candidate.key;
      option.textContent = `${candidate.entity} — ${candidate.key}${candidate.key === rootKey ? " (objeto inteiro)" : " (subpeça)"}`;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      const candidate = candidates.find((item) => item.key === select.value) || candidates[0];
      panel._ha3dEditorBindingContext.active = candidate;
      applyCandidateToForm(panel, candidate);
    });
    const label = document.createElement("label");
    label.textContent = "Bindings encontrados neste objeto";
    const hint = document.createElement("span");
    hint.className = "ha3dHint";
    hint.textContent = "Escolha qual vínculo editar. Salvar migra o vínculo escolhido para o objeto inteiro.";
    box.append(label, select, hint);
    applyCandidateToForm(panel, active);
  }

  body.prepend(box);
}

function readEditorConfig(panel, base = {}) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!body) throw new Error("Editor indisponível");
  let rules;
  try {
    rules = JSON.parse(body.querySelector("#ha3dRules")?.value || "[]");
    if (!Array.isArray(rules)) throw new Error();
  } catch (_error) {
    throw new Error("Regras precisam ser uma lista JSON válida");
  }

  const entityId = body.querySelector("#ha3dEntity")?.value?.trim() || "";
  const readings = (body.querySelector("#ha3dReadings")?.value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [entity_id, attribute] = line.split(":", 2);
      return attribute ? { entity_id, attribute } : { entity_id };
    });

  return {
    entityId,
    config: {
      ...base,
      entity_id: entityId || undefined,
      readings,
      state_rules: rules,
      show_only_when_zoomed: Boolean(body.querySelector("#ha3dZoomOnly")?.checked),
    },
    area: body.querySelector("#ha3dArea")?.value || "",
  };
}

function refreshBindings(panel) {
  panel._refreshMarkers?.();
  panel._syncLightStates?.();
}

if (!proto.__ha3dBindingEditorOverrideV1) {
  proto.__ha3dBindingEditorOverrideV1 = true;

  proto._indexBindings = function () {
    this._objectsByEntity.clear();
    this._boundCount = 0;
    const explicit = this._config?.bindings || {};
    const autoBind = this._config?.auto_bind !== false;
    const states = this._hass?.states || {};

    this._model?.traverse((object) => {
      if (object.userData) delete object.userData.ha3dEntityId;
    });

    this._model?.traverse((object) => {
      const names = namesForObject(object);
      if (!names.length) return;
      let entityId = null;
      let blocked = false;

      for (const name of names) {
        if (!hasOwn(explicit, name)) continue;
        if (explicit[name] === UNBOUND) {
          blocked = true;
          break;
        }
        if (states[explicit[name]]) {
          entityId = explicit[name];
          break;
        }
      }

      if (!entityId && !blocked && autoBind) entityId = names.find((name) => states[name]) || null;
      if (!entityId || !states[entityId]) return;

      object.userData ||= {};
      object.userData.ha3dEntityId = entityId;
      if (!this._objectsByEntity.has(entityId)) {
        this._objectsByEntity.set(entityId, []);
        this._boundCount += 1;
      }
      this._objectsByEntity.get(entityId).push(object);
    });
  };

  proto._mappingForLight = function (light) {
    const states = this._hass?.states || {};
    const explicit = this._config?.bindings || {};
    const hierarchy = [];
    let node = light;
    while (node && node !== this._model?.parent) {
      hierarchy.push(node);
      if (node === this._model) break;
      node = node.parent;
    }

    for (const item of hierarchy) {
      for (const name of namesForObject(item)) {
        const mapped = explicit[name];
        if (mapped !== UNBOUND && mapped?.startsWith("light.") && states[mapped]) {
          return { entity: mapped, name: states[mapped].attributes?.friendly_name || mapped };
        }
      }
    }

    for (const item of hierarchy) {
      for (const name of namesForObject(item)) {
        if (explicit[name] === UNBOUND) return null;
      }
    }

    for (const item of hierarchy) {
      for (const name of namesForObject(item)) {
        if (name.startsWith("LightNode_light.")) {
          const entity = name.slice("LightNode_".length);
          if (states[entity]) return { entity, name: states[entity].attributes?.friendly_name || entity };
        }
        if (name.startsWith("light.") && states[name]) {
          return { entity: name, name: states[name].attributes?.friendly_name || name };
        }
      }
    }
    return null;
  };

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installBindingSourceUi(this);
    return result;
  };

  proto._saveEditorBinding = async function (name) {
    const root = this._selectedObject;
    const rootKey = objectKey(root) || name;
    if (!rootKey) return;
    const context = this._ha3dEditorBindingContext || { rootKey, candidates: [], active: null };
    const source = context.active;
    const advanced = { ...(this._config?.advanced_bindings || {}) };
    const areas = { ...(this._config?.area_bindings || {}) };
    const bindings = { ...(this._config?.bindings || {}) };
    const base = source?.config || advanced[rootKey] || {};

    let editor;
    try {
      editor = readEditorConfig(this, base);
    } catch (error) {
      this._setStatus?.(error.message || String(error));
      return;
    }

    if (!editor.entityId) {
      this._setStatus?.("Escolha uma entidade ou use Remover binding");
      return;
    }

    const sourceKey = source?.key;
    if (sourceKey && sourceKey !== rootKey) {
      delete advanced[sourceKey];
      delete areas[sourceKey];
      bindings[sourceKey] = UNBOUND;
    }

    advanced[rootKey] = editor.config;
    if (editor.area) areas[rootKey] = editor.area;
    else delete areas[rootKey];
    bindings[rootKey] = editor.entityId;

    try {
      await this._saveConfigPatch({ advanced_bindings: advanced, area_bindings: areas, bindings });
      refreshBindings(this);
      await this._renderEditorForm?.();
      this._setStatus?.(sourceKey && sourceKey !== rootKey ? `Binding migrado para o objeto inteiro: ${rootKey}` : `Binding salvo: ${rootKey}`);
    } catch (error) {
      this._setStatus?.(`Erro ao salvar: ${error.message || error}`);
    }
  };

  proto._removeEditorBinding = async function (name) {
    const root = this._selectedObject;
    const rootKey = objectKey(root) || name;
    if (!rootKey) return;
    const context = this._ha3dEditorBindingContext || { rootKey, candidates: [], active: null };
    const active = context.active;
    const activeEntity = active?.entity || (this._hass?.states?.[rootKey] ? rootKey : null);
    const advanced = { ...(this._config?.advanced_bindings || {}) };
    const areas = { ...(this._config?.area_bindings || {}) };
    const bindings = { ...(this._config?.bindings || {}) };

    const keys = new Set([rootKey]);
    if (active?.key) keys.add(active.key);
    if (activeEntity) {
      for (const candidate of context.candidates || []) {
        if (candidate.entity === activeEntity) keys.add(candidate.key);
      }
    }

    for (const key of keys) {
      delete advanced[key];
      delete areas[key];
      bindings[key] = UNBOUND;
    }

    try {
      await this._saveConfigPatch({ advanced_bindings: advanced, area_bindings: areas, bindings });
      refreshBindings(this);
      await this._renderEditorForm?.();
      this._setStatus?.(`Binding removido do objeto inteiro: ${rootKey}`);
    } catch (error) {
      this._setStatus?.(`Erro ao remover: ${error.message || error}`);
    }
  };
}
