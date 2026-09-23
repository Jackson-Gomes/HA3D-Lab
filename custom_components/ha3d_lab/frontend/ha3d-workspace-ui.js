// Loaded last: group existing controls without replacing their behavior or DOM.
const Panel = customElements.get('ha3d-lab-panel');
const MODES = ['live', 'edit', 'build', 'buy', 'views', 'system'];
const LABELS = ['Live', 'Edit', 'Build', 'Buy / Assets', 'Views', 'System'];
const editing = mode => mode === 'edit' || mode === 'buy';

function install(panel) {
  const shadow = panel.shadowRoot;
  if (!shadow || shadow.querySelector('#labModes')) return;
  const style = document.createElement('style');
  style.textContent = `
    #root[data-lab-mode] #brand strong{font-size:14px}#root[data-lab-mode] #brand{max-width:190px}
    #labModes{position:absolute;z-index:70;top:max(12px,env(safe-area-inset-top));left:210px;right:12px;display:flex;gap:4px;padding:4px;border-radius:14px;background:#18232a;border:1px solid #ffffff24;max-width:610px}
    #labModes button{flex:1;min-width:0;min-height:44px;padding:8px;font-size:12px;background:transparent;border-color:transparent;white-space:nowrap}
    #labModes button[aria-pressed=true]{background:#235e63;border-color:#69d7c4}#labModes button:focus-visible{outline:2px solid #fff;outline-offset:2px}
    #root[data-lab-mode] #actions{position:absolute;top:64px;right:0;flex-wrap:wrap;max-width:calc(100vw - 24px)}
    #root[data-lab-mode] #actions button{min-height:44px}
    #root[data-lab-mode] #editorButton,#root[data-lab-mode] #viewsButton{display:none!important}
    #root:not([data-lab-mode=system]) #uploadButton,#root:not([data-lab-mode=system]) #robotsButton{display:none!important}
    #root[data-lab-mode] #viewsPanel,#root[data-lab-mode] #ha3dRobots,#root[data-lab-mode] #ha3dEditor{top:126px;max-height:calc(100vh - 204px);overflow:auto}
    #root[data-lab-mode] #viewsPanel{display:none!important}
    #root[data-lab-mode=views] #viewsPanel,#root[data-lab-mode=system] #viewsPanel{display:block!important}
    #root[data-lab-robots=open] #viewsPanel{display:none!important}
    #root[data-lab-mode=views] #graphicsSection,#root[data-lab-mode=views] #globalLightSection{display:none!important}
    #root[data-lab-mode=system] #viewsPanel>:not(#graphicsSection):not(#globalLightSection){display:none!important}
    #root:not([data-lab-mode=system]) #ha3dRobots{display:none!important}
    #root:not([data-lab-mode=edit]):not([data-lab-mode=buy]) #ha3dEditor{display:none!important}
    #labBuild{display:none;position:absolute;top:126px;left:12px;z-index:40;width:min(360px,calc(100vw - 24px));padding:18px;border-radius:16px;background:#17232a;border:1px solid #ffffff24}
    #root[data-lab-mode=build] #labBuild{display:block}#labBuild h2{font-size:16px;margin-top:0}#labBuild p{font-size:13px;line-height:1.5;color:#ccd8dd}
    #labBuild ul{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}#labBuild li{background:#ffffff0d;border-radius:6px;padding:6px;font-size:12px}
    #root[data-lab-mode] #ha3dEditor.minimized{max-height:calc(100vh - 204px)}
    #root[data-lab-mode] .labStatus{font-size:11px;color:#9be7d8}
    @media(max-width:700px){
      #labModes{top:62px;left:8px;right:8px;gap:1px;padding:3px}#labModes button{font-size:10px;padding:5px 2px}
      #root[data-lab-mode] #actions{top:106px}#root[data-lab-mode] #brand{max-width:calc(100vw - 24px)}
      #root[data-lab-mode] #ha3dEditor,#root[data-lab-mode] #ha3dRobots,#root[data-lab-mode] #viewsPanel,#labBuild{top:166px;max-height:calc(100vh - 242px);left:12px;right:12px;width:auto}
    }
  `;
  shadow.append(style);
  const root = shadow.querySelector('#root');
  const nav = document.createElement('nav'); nav.id = 'labModes'; nav.setAttribute('aria-label', 'Modos do HA3D Lab');
  MODES.forEach((mode, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.mode = mode;
    button.textContent = LABELS[index]; button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => panel._labSetMode(mode)); nav.append(button);
  });
  root.append(nav);
  const build = document.createElement('section'); build.id = 'labBuild';
  build.innerHTML = '<h2>Build · planejamento</h2><p>Área reservada para construção. Use Edit para transformar objetos existentes e Buy / Assets para adicionar GLBs.</p><ul><li>Paredes</li><li>Pisos</li><li>Portas</li><li>Janelas</li><li>Alinhamento</li></ul><p>Ferramentas estruturais ainda não implementadas nesta versão experimental.</p>';
  root.append(build);
  shadow.querySelector('#brand strong').textContent = 'HA3D Lab · lab.1';
  shadow.querySelector('#robotsButton')?.addEventListener('click', () => {
    root.dataset.labRobots = shadow.querySelector('#ha3dRobots')?.classList.contains('open') ? 'open' : 'closed';
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel._robotCalibration && !panel._transformControls?.dragging) panel._labSetMode('live');
  });
  panel._labSetMode('live');
}

const proto = Panel.prototype;
proto._labSetMode = function (mode) {
  if (!MODES.includes(mode)) return false;
  if ((this._robotCalibration || this._robotSaving || this._transformControls?.dragging) && mode !== this._labMode) {
    this._setStatus('Conclua ou cancele a operação aberta antes de trocar de modo.'); return false;
  }
  if (['edit', 'buy', 'build', 'system'].includes(mode) && !this._hass?.user?.is_admin) {
    this._setStatus('Este modo requer um administrador.'); return false;
  }
  if (Boolean(this._editorMode) !== editing(mode)) {
    this._labChangingMode = true;
    try { this._toggleEditor(); } finally { this._labChangingMode = false; }
  }
  this._labMode = mode;
  const root = this.shadowRoot.querySelector('#root'); root.dataset.labMode = mode; root.dataset.labRobots = 'closed';
  this.shadowRoot.querySelector('#ha3dRobots')?.classList.remove('open');
  this.shadowRoot.querySelector('#robotsButton')?.classList.remove('active');
  this.shadowRoot.querySelectorAll('#labModes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if (editing(mode)) {
    this.shadowRoot.querySelector('#ha3dEditor')?.classList.remove('minimized');
    const collapse = this.shadowRoot.querySelector('#ha3dCollapseEditor'); if (collapse) collapse.textContent = 'Recolher';
  }
  this.dispatchEvent(new CustomEvent('lab-mode-changed', { detail: mode }));
  return true;
};
// Custom-element lifecycle callbacks are captured at define(). _renderShell is
// dynamically dispatched by the registered callback and is the reliable hook.
const renderShell = proto._renderShell;
proto._renderShell = function (...args) { const result = renderShell.apply(this, args); install(this); return result; };
const toggleEditor = proto._toggleEditor;
proto._toggleEditor = function (...args) {
  // Keep long-press and other existing entry points in sync with the workspace.
  if (!this._labChangingMode && this._labMode) return this._labSetMode(this._editorMode ? 'live' : 'edit');
  return toggleEditor.apply(this, args);
};
