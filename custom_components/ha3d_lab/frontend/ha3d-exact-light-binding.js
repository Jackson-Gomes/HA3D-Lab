// Exact light binding only. No legacy substring matching.
const Panel = customElements.get("ha3d-lab-panel");
if (!Panel) throw new Error("HA3D panel was not registered");

const proto = Panel.prototype;

if (!proto.__ha3dExactLightBindingV1) {
  proto.__ha3dExactLightBindingV1 = true;

  const exactLightEntityFromNode = (node, states, explicit) => {
    const names = [
      node?.userData?.ha3dOriginalNodeName,
      node?.name,
    ].filter(Boolean);

    for (const name of names) {
      const mapped = explicit[name];
      if (mapped?.startsWith("light.") && states[mapped]) return mapped;

      if (name.startsWith("LightNode_light.")) {
        const entity = name.slice("LightNode_".length);
        if (states[entity]) return entity;
      }

      if (name.startsWith("light.") && states[name]) return name;
    }

    return null;
  };

  proto._mappingForLight = function (light) {
    const states = this._hass?.states || {};
    const explicit = this._config?.bindings || {};

    let node = light;
    while (node && node !== this._model?.parent) {
      const entity = exactLightEntityFromNode(node, states, explicit);
      if (entity) {
        return {
          entity,
          name: states[entity].attributes?.friendly_name || entity,
        };
      }
      if (node === this._model) break;
      node = node.parent;
    }

    // Deliberately return null: no fuzzy/substring/legacy fallback.
    return null;
  };
}
