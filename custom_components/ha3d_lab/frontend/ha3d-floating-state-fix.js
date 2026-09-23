const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

function widgetList(panel) {
  return Array.isArray(panel?._config?.floating_widgets) ? panel._config.floating_widgets : [];
}

function stateWidget(panel, id) {
  return widgetList(panel).find((item) => item?.id === id && item?.type === "state") || null;
}

function selectedStateWidget(panel) {
  const id = panel?._selectedObject?.userData?.ha3dFloatingWidgetId;
  return id ? stateWidget(panel, id) : null;
}

function patchRuntime(panel, item) {
  const runtime = panel?._ha3dFloatingWidgets?.get?.(item?.id);
  if (runtime) runtime.config = item;
}

async function persistWidgets(panel, list) {
  const result = await panel._hass?.callApi?.("POST", "ha3d_lab_lab/floating_widgets", { floating_widgets: list });
  if (result) panel._config = result;
  return result;
}

async function migrateLegacyStateWidgets(panel) {
  if (!panel?._hass || !panel?._config) return;
  const current = widgetList(panel);
  let changed = false;
  const migrated = current.map((item) => {
    if (item?.type === "state" && item?.visibility === "click") {
      changed = true;
      return { ...item, visibility: "zoom", zoom_threshold: Number(item.zoom_threshold) || 1.15 };
    }
    return item;
  });
  if (!changed) return;

  try {
    await persistWidgets(panel, migrated);
    for (const item of widgetList(panel)) patchRuntime(panel, item);
    panel._setStatus?.("Balões Estado ajustados para proximidade");
  } catch (error) {
    console.error("[HA3D] state balloon migration failed", error);
  }
}

function patchStateForm(panel) {
  const item = selectedStateWidget(panel);
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!item || !body) return;

  const visibility = body.querySelector("#ha3dFwVisibility");
  const zoomRow = body.querySelector("#ha3dFwZoomRow");
  if (visibility) {
    const click = visibility.querySelector('option[value="click"]');
    click?.remove();
    if (visibility.value === "click") visibility.value = "zoom";
  }
  if (zoomRow) zoomRow.style.display = visibility?.value === "zoom" ? "grid" : "none";

  const hint = zoomRow?.querySelector(".ha3dHint");
  if (hint) hint.textContent = "Controla a distância em que o balão de estado aparece. Menor = precisa chegar mais perto.";

  // The marker slider is unrelated to floating state balloons. Keep its label explicit.
  const markerLabel = body.querySelector("#ha3dMarkerProximityRow label");
  if (markerLabel) markerLabel.textContent = "Distância para exibir o ícone";
}

if (!proto.__ha3dFloatingStateFixV1) {
  proto.__ha3dFloatingStateFixV1 = true;

  const oldCreate = proto._createFloatingWidget;
  proto._createFloatingWidget = async function (type = "text") {
    const before = new Set(widgetList(this).map((item) => item?.id));
    const result = await oldCreate?.call(this, type);
    if (type !== "state") return result;

    const created = widgetList(this).find((item) => item?.type === "state" && !before.has(item.id));
    if (!created) return result;
    const next = { ...created, visibility: "zoom", zoom_threshold: Number(created.zoom_threshold) || 1.15 };
    try {
      const list = widgetList(this).map((item) => item.id === created.id ? next : item);
      await persistWidgets(this, list);
      patchRuntime(this, next);
      this._selectFloatingWidget?.(created.id);
      await this._renderEditorForm?.();
      patchStateForm(this);
      this._setStatus?.("Balão Estado criado · ajuste a distância para aparecer");
    } catch (error) {
      console.error("[HA3D] state balloon default failed", error);
    }
    return result;
  };

  const oldRenderForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderForm?.apply(this, args);
    patchStateForm(this);
    return result;
  };

  const oldLoadModel = proto._loadModel;
  proto._loadModel = async function (...args) {
    const result = await oldLoadModel?.apply(this, args);
    queueMicrotask(() => migrateLegacyStateWidgets(this));
    return result;
  };

  const oldConnected = proto.connectedCallback;
  proto.connectedCallback = function (...args) {
    const result = oldConnected?.apply(this, args);
    setTimeout(() => migrateLegacyStateWidgets(this), 700);
    return result;
  };
}
