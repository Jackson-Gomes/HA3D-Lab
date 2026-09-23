const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;
const DEFAULT_FACTOR = 1.15;
const MIN_FACTOR = 0.25;
const MAX_FACTOR = 3.0;
const STEP = 0.05;

function clamp(value, min = MIN_FACTOR, max = MAX_FACTOR) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_FACTOR;
  return Math.min(max, Math.max(min, number));
}

function entityIdFromEditor(panel) {
  const input = panel?.shadowRoot?.querySelector("#ha3dEditorBody #ha3dEntity");
  const value = String(input?.value || "").trim();
  if (value) return value;
  return String(panel?._ha3dEditorBindingContext?.active?.entity || panel?._selectedObject?.userData?.ha3dEntityId || "").trim();
}

function factorFor(panel, entityId) {
  return clamp(panel?._config?.marker_proximity?.[entityId] ?? DEFAULT_FACTOR);
}

function formatFactor(value) {
  return `${Math.round(clamp(value) * 100)}%`;
}

function installSlider(panel) {
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  const zoomOnly = body?.querySelector("#ha3dZoomOnly");
  if (!body || !zoomOnly) return;

  body.querySelector("#ha3dMarkerProximityRow")?.remove();
  const row = document.createElement("div");
  row.id = "ha3dMarkerProximityRow";
  row.className = "ha3dRow";
  row.innerHTML = `
    <label>Distância para exibir ícone e informações</label>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center">
      <input id="ha3dMarkerProximity" type="range" min="${MIN_FACTOR}" max="${MAX_FACTOR}" step="${STEP}">
      <output id="ha3dMarkerProximityOut" style="min-width:48px;text-align:right;font-size:11px;opacity:.78"></output>
    </div>
    <span class="ha3dHint">Menor = precisa aproximar mais. Maior = ícone e valores dos sensores aparecem de mais longe.</span>
  `;

  const zoomRow = zoomOnly.closest?.(".ha3dRow") || zoomOnly.parentElement;
  zoomRow?.insertAdjacentElement("afterend", row);

  const slider = row.querySelector("#ha3dMarkerProximity");
  const output = row.querySelector("#ha3dMarkerProximityOut");
  const entityInput = body.querySelector("#ha3dEntity");

  const syncValue = () => {
    const entityId = entityIdFromEditor(panel);
    const value = factorFor(panel, entityId);
    slider.value = String(value);
    output.value = formatFactor(value);
    slider.disabled = !zoomOnly.checked;
    row.style.opacity = zoomOnly.checked ? "1" : ".5";
  };

  slider.addEventListener("input", () => {
    output.value = formatFactor(slider.value);
  });
  zoomOnly.addEventListener("change", syncValue);
  entityInput?.addEventListener("change", syncValue);
  entityInput?.addEventListener("blur", syncValue);
  syncValue();
}

async function persistSlider(panel, entityId, factor) {
  if (!entityId) return;
  const current = { ...(panel?._config?.marker_proximity || {}) };
  current[entityId] = clamp(factor);
  const result = await panel._hass.callApi("POST", "ha3d_lab_lab/marker_proximity", { marker_proximity: current });
  panel._config = { ...(panel._config || {}), marker_proximity: result?.marker_proximity || current };
}

function advancedConfigForEntity(panel, entityId) {
  return Object.values(panel?._config?.advanced_bindings || {}).find((item) => item?.entity_id === entityId) || null;
}

if (!proto.__ha3dMarkerProximitySliderV1) {
  proto.__ha3dMarkerProximitySliderV1 = true;

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installSlider(this);
    return result;
  };

  const oldSaveEditorBinding = proto._saveEditorBinding;
  proto._saveEditorBinding = async function (...args) {
    const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
    const entityId = String(body?.querySelector("#ha3dEntity")?.value || "").trim();
    const factor = clamp(body?.querySelector("#ha3dMarkerProximity")?.value ?? factorFor(this, entityId));

    const result = await oldSaveEditorBinding?.apply(this, args);
    if (!entityId || !advancedConfigForEntity(this, entityId)) return result;

    try {
      await persistSlider(this, entityId, factor);
      this._setStatus?.(`Binding salvo · ícone e informações próximos em ${formatFactor(factor)}`);
    } catch (error) {
      console.error("[HA3D] marker proximity save failed", error);
      this._setStatus?.(`Binding salvo, mas falhou proximidade do ícone/informações: ${error.message || error}`);
    }
    return result;
  };

  const oldUpdateLightMarkers = proto._updateLightMarkers;
  proto._updateLightMarkers = function (...args) {
    const result = oldUpdateLightMarkers?.apply(this, args);
    const distance = this?._camera && this?._controls
      ? this._camera.position.distanceTo(this._controls.target)
      : Infinity;
    const modelScale = Math.max(0.001, Number(this?._modelScale) || 10);

    for (const [entityId, binding] of this?._lightBindings?.entries?.() || []) {
      const marker = binding?.marker;
      if (!marker) continue;
      const config = advancedConfigForEntity(this, entityId);
      if (config?.show_only_when_zoomed) {
        const factor = factorFor(this, entityId);
        marker.dataset.ha3dProximityManaged = "1";
        marker.style.display = distance < modelScale * factor ? "block" : "none";
      } else if (marker.dataset.ha3dProximityManaged === "1") {
        marker.style.display = "";
        delete marker.dataset.ha3dProximityManaged;
      }
    }
    return result;
  };
}
