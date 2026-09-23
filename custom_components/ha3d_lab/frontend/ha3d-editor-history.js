// One history entry per acknowledged operation, never one per rendered frame.
export class EditorHistory {
  constructor(limit = 50) { this.limit = limit; this.undoStack = []; this.redoStack = []; this.busy = false; }
  record(command) {
    this.undoStack.push(command); if (this.undoStack.length > this.limit) this.undoStack.shift(); this.redoStack.length = 0;
  }
  async travel(direction, apply) {
    if (this.busy) return false;
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const command = from.at(-1); if (!command) return false;
    this.busy = true;
    try { await apply(structuredClone(command[direction === 'undo' ? 'before' : 'after'])); from.pop(); to.push(command); return true; }
    finally { this.busy = false; }
  }
}

const Panel = globalThis.customElements?.get('ha3d-lab-panel');
const FIELDS = ['object_positions', 'bindings', 'advanced_bindings', 'area_bindings'];
if (Panel) {
  const proto = Panel.prototype;
  function state(panel) { return panel._labHistory ||= new EditorHistory(); }
  function buttons(panel) {
    const history = state(panel), busy = history.busy || panel._labSaving;
    const undo = panel.shadowRoot?.querySelector('#labUndo'), redo = panel.shadowRoot?.querySelector('#labRedo');
    if (undo) undo.disabled = Boolean(busy || !history.undoStack.length);
    if (redo) redo.disabled = Boolean(busy || !history.redoStack.length);
  }
  function restoreScene(panel) {
    for (const object of panel._ha3dLogicalRoots || []) {
      // Assets own their transforms separately; do not reset them through GLB history.
      if (object.userData?.ha3dSceneAssetId) continue;
      const key = object.userData?.ha3dOriginalNodeName || object.name;
      const transform = panel._config?.object_positions?.[key] || object.userData?.ha3dBaseTransformV2;
      if (!transform) continue;
      object.position.fromArray(transform.position); object.rotation.fromArray(transform.rotation); object.scale.fromArray(transform.scale); object.updateMatrixWorld(true);
    }
    panel._refreshMarkers?.();
    if (panel._selectedObject && panel._editorMode) panel._selectForEditor(panel._selectedObject);
  }
  const save = proto._saveConfigPatch;
  proto._saveConfigPatch = async function (patch) {
    const history = state(this);
    if (this._labSaving || history.busy) throw Error('Aguarde a gravação em andamento.');
    const fields = FIELDS.filter(key => Object.hasOwn(patch, key));
    const before = structuredClone(Object.fromEntries(fields.map(key => [key, this._config?.[key] || {}])));
    const captured = structuredClone(patch);
    this._labSaving = true; buttons(this);
    try {
      const result = await save.call(this, captured);
      const after = structuredClone(Object.fromEntries(fields.map(key => [key, this._config?.[key] || {}])));
      if (fields.length && JSON.stringify(before) !== JSON.stringify(after)) history.record({ before, after });
      return result;
    } finally { this._labSaving = false; buttons(this); }
  };
  proto._labTravelHistory = async function (direction) {
    if (!this._hass?.user?.is_admin || !this._editorMode || this._labSaving || this._transformControls?.dragging) return;
    const history = state(this);
    try {
      const work = history.travel(direction, async patch => { await save.call(this, patch); restoreScene(this); });
      buttons(this); const changed = await work;
      if (changed) this._setStatus(direction === 'undo' ? 'Operação desfeita' : 'Operação refeita');
    } catch (error) { this._setStatus(`Não foi possível alterar o histórico: ${error.message}`); }
    finally { buttons(this); }
  };
  const shell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = shell.apply(this, args), editor = this.shadowRoot.querySelector('#ha3dEditor');
    const row = document.createElement('div'); row.className = 'ha3dEditorActions';
    row.innerHTML = '<button type="button" id="labUndo" disabled>Desfazer</button><button type="button" id="labRedo" disabled>Refazer</button>';
    editor.querySelector('.ha3dTransform').before(row);
    row.querySelector('#labUndo').addEventListener('click', () => this._labTravelHistory('undo'));
    row.querySelector('#labRedo').addEventListener('click', () => this._labTravelHistory('redo'));
    this.shadowRoot.addEventListener('keydown', event => {
      if (!this._editorMode || event.target.closest('input,textarea,select,[contenteditable]') || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); this._labTravelHistory(event.shiftKey ? 'redo' : 'undo'); }
    });
    return result;
  };
  const load = proto._loadModel;
  proto._loadModel = async function (...args) { const result = await load.apply(this, args); this._labHistory = new EditorHistory(); buttons(this); return result; };
}
