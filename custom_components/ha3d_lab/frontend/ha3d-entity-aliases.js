const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function aliases(panel) {
  const value = panel?._config?.entity_aliases;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function entityDisplayName(panel, entityId) {
  if (!entityId) return "";
  const alias = String(aliases(panel)[entityId] || "").trim();
  if (alias) return alias;
  return panel?._hass?.states?.[entityId]?.attributes?.friendly_name || entityId;
}

function currentEditorEntity(panel) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  const value = body?.querySelector("#ha3dEntity")?.value?.trim()
    || body?.querySelector("#ha3dFwEntity")?.value?.trim()
    || panel?._selectedObject?.userData?.ha3dEntityId
    || "";
  return ENTITY_ID.test(value) ? value : "";
}

function refreshMarkerNames(panel) {
  for (const [entityId, binding] of panel?._lightBindings?.entries?.() || []) {
    const name = entityDisplayName(panel, entityId);
    if (!binding || !name) continue;
    binding.name = name;
    if (binding.marker) {
      const state = panel?._hass?.states?.[entityId];
      const unavailable = ["unknown", "unavailable"].includes(state?.state);
      binding.marker.title = unavailable ? `${name} — indisponível` : name;
      binding.marker.setAttribute("aria-label", name);
    }
  }
}

function renderTextWidgetWithAlias(panel, runtime) {
  const config = runtime?.config;
  const card = runtime?.card;
  const entityId = config?.entity_id;
  if (!config || !card || !entityId) return;
  const state = panel?._hass?.states?.[entityId];
  const title = card.querySelector(".ha3dFloatTitle");
  if (title) title.textContent = entityDisplayName(panel, entityId);

  if (config.type !== "text" || !String(config.text || "").includes("{name}")) return;
  const valueNode = card.querySelector(".ha3dFloatValue");
  if (!valueNode) return;
  const attribute = config.attribute ? state?.attributes?.[config.attribute] : undefined;
  const value = config.attribute ? attribute : state?.state;
  valueNode.textContent = String(config.text || config.name || "")
    .replaceAll("{state}", String(value ?? "—"))
    .replaceAll("{name}", entityDisplayName(panel, entityId))
    .replaceAll("{entity_id}", entityId)
    .replaceAll("{attribute}", String(config.attribute ? attribute ?? "—" : ""));
}

function refreshWidgetNames(panel) {
  for (const runtime of panel?._ha3dFloatingWidgets?.values?.() || []) renderTextWidgetWithAlias(panel, runtime);
}

function refreshAliases(panel) {
  refreshMarkerNames(panel);
  refreshWidgetNames(panel);
}

async function saveAlias(panel, entityId, alias) {
  if (!ENTITY_ID.test(entityId)) {
    panel?._setStatus?.("Escolha uma entidade válida antes de renomear");
    return;
  }
  const next = { ...aliases(panel) };
  const clean = String(alias || "").trim();
  if (clean) next[entityId] = clean;
  else delete next[entityId];

  try {
    const result = await panel._hass.callApi("POST", "ha3d_lab_lab/entity_aliases", { entity_aliases: next });
    panel._config = { ...(panel._config || {}), entity_aliases: result?.entity_aliases || next };
    refreshAliases(panel);
    panel._setStatus?.(clean ? `Nome no HA3D salvo: ${clean}` : `Nome HA3D removido: ${entityId}`);
  } catch (error) {
    panel._setStatus?.(`Erro ao salvar nome: ${error.message || error}`);
  }
}

function installAliasEditor(panel) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!body) return;
  body.querySelector("#ha3dEntityAliasRow")?.remove();

  const entityId = currentEditorEntity(panel);
  if (!entityId) return;

  const stateName = panel?._hass?.states?.[entityId]?.attributes?.friendly_name || entityId;
  const currentAlias = String(aliases(panel)[entityId] || "");
  const row = document.createElement("div");
  row.id = "ha3dEntityAliasRow";
  row.className = "ha3dRow";
  row.innerHTML = `
    <label>Nome no HA3D</label>
    <input id="ha3dEntityAlias" maxlength="120" autocomplete="off" placeholder="${String(stateName).replaceAll('"', '&quot;')}">
    <span class="ha3dHint">Altera somente o nome exibido no HA3D. O entity_id real continua <b>${entityId}</b>.</span>
    <div class="ha3dEditorActions">
      <button id="ha3dSaveEntityAlias" class="secondary" type="button">Salvar nome</button>
      <button id="ha3dClearEntityAlias" class="secondary" type="button">Usar nome do HA</button>
    </div>`;
  const input = row.querySelector("#ha3dEntityAlias");
  input.value = currentAlias;
  row.querySelector("#ha3dSaveEntityAlias")?.addEventListener("click", () => saveAlias(panel, entityId, input.value));
  row.querySelector("#ha3dClearEntityAlias")?.addEventListener("click", async () => {
    input.value = "";
    await saveAlias(panel, entityId, "");
  });
  body.prepend(row);

  for (const selector of ["#ha3dEntity", "#ha3dFwEntity"]) {
    const entityInput = body.querySelector(selector);
    if (entityInput && entityInput.dataset.ha3dAliasWatch !== "1") {
      entityInput.dataset.ha3dAliasWatch = "1";
      entityInput.addEventListener("change", () => installAliasEditor(panel));
    }
  }
}

if (!proto.__ha3dEntityAliasesV1) {
  proto.__ha3dEntityAliasesV1 = true;
  proto._ha3dEntityDisplayName = function (entityId) {
    return entityDisplayName(this, entityId);
  };

  const oldMakeMarker = proto._makeLightMarker;
  proto._makeLightMarker = function (entityId, name, ...args) {
    const binding = oldMakeMarker?.call(this, entityId, entityDisplayName(this, entityId) || name, ...args);
    if (binding) {
      binding.name = entityDisplayName(this, entityId) || name || entityId;
      if (binding.marker) binding.marker.title = binding.name;
    }
    return binding;
  };

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installAliasEditor(this);
    return result;
  };

  const oldBindMarkers = proto._bindEntityLightMarkers;
  proto._bindEntityLightMarkers = function (...args) {
    const result = oldBindMarkers?.apply(this, args);
    refreshAliases(this);
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    if (!this._ha3dAliasRefreshTimer) {
      this._ha3dAliasRefreshTimer = setInterval(() => refreshAliases(this), 500);
    }
    return result;
  };

  const oldDisconnected = proto.disconnectedCallback;
  proto.disconnectedCallback = function (...args) {
    if (this._ha3dAliasRefreshTimer) clearInterval(this._ha3dAliasRefreshTimer);
    this._ha3dAliasRefreshTimer = 0;
    return oldDisconnected?.apply(this, args);
  };
}
