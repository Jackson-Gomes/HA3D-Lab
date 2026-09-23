const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");
const proto = Panel.prototype;

function selectedRuntime(panel) {
  const id = panel?._selectedObject?.userData?.ha3dVirtualLightId;
  return id ? panel?._ha3dVirtualLights?.get?.(id) || null : null;
}

function installExtraFields(panel) {
  const runtime = selectedRuntime(panel);
  const body = panel?.shadowRoot?.querySelector("#ha3dEditorBody");
  if (!runtime || !body || body.querySelector("#ha3dVlShowMarker")) return;

  const config = runtime.config || {};
  const host = document.createElement("div");
  host.id = "ha3dVlExtraOptions";
  host.innerHTML = `
    <div class="ha3dRow">
      <label>Mostrar ícone</label>
      <label style="display:flex;align-items:center;gap:8px"><input id="ha3dVlShowMarker" type="checkbox" ${config.show_marker === false ? "" : "checked"}> Exibir marcador sobre a luz</label>
      <span class="ha3dHint">O modo cinematográfico usa somente luzes com este ícone visível.</span>
    </div>
    <div class="ha3dRow">
      <label>Efeito do Spot</label>
      <select id="ha3dVlEffect">
        <option value="none" ${(config.effect || "none") === "none" ? "selected" : ""}>Nenhum</option>
        <option value="tv_flicker" ${config.effect === "tv_flicker" ? "selected" : ""}>Cintilação tipo TV</option>
      </select>
      <span class="ha3dHint">A cintilação usa a mesma variação orgânica azul/roxo da TV e só atua em Spot Light.</span>
    </div>
  `;

  const actions = body.querySelector(".ha3dEditorActions");
  if (actions) body.insertBefore(host, actions);
  else body.appendChild(host);
}

if (!proto.__ha3dVirtualLightOptionsV1) {
  proto.__ha3dVirtualLightOptionsV1 = true;

  const oldRenderEditorForm = proto._renderEditorForm;
  proto._renderEditorForm = async function (...args) {
    const result = await oldRenderEditorForm?.apply(this, args);
    installExtraFields(this);
    return result;
  };

  const oldSaveVirtualLightForm = proto._saveVirtualLightForm;
  proto._saveVirtualLightForm = async function (id, ...args) {
    const runtime = this._ha3dVirtualLights?.get?.(id);
    const body = this.shadowRoot?.querySelector("#ha3dEditorBody");
    if (runtime && body) {
      runtime.config = {
        ...runtime.config,
        show_marker: Boolean(body.querySelector("#ha3dVlShowMarker")?.checked),
        effect: body.querySelector("#ha3dVlEffect")?.value === "tv_flicker" ? "tv_flicker" : "none",
      };
    }
    return oldSaveVirtualLightForm?.call(this, id, ...args);
  };
}
