// Pure visual estimator. Coordinates, calibration and heading remain upstream.
export class RobotMotion {
  constructor({ horizon = 600, distanceLimit = .15, speedLimit = .8 } = {}) {
    this.horizon = horizon; this.distanceLimit = distanceLimit; this.speedLimit = speedLimit;
    this.samples = []; this.velocity = [0, 0, 0]; this.rendered = [0, 0, 0]; this.average = 0; this.interval = 0; this.mode = 'REAL'; this.lastFrame = null;
  }
  sample(stamp, now, point) {
    if (!Number.isFinite(stamp) || !Number.isFinite(now) || !point.every(Number.isFinite)) return false;
    const last = this.samples.at(-1);
    if (last && stamp <= last.stamp) return false;
    this.interval = last ? stamp - last.stamp : 0;
    this.average = this.average ? this.average * .65 + this.interval * .35 : this.interval;
    const dt = this.interval / 1000;
    this.velocity = point.map((value, i) => dt > 0 && dt <= 8 ? (value - last.point[i]) / dt : 0);
    const speed = Math.hypot(...this.velocity);
    // Discontinuities are not credible motion. Wait for the next usable sample.
    if (speed > this.speedLimit) this.velocity.fill(0);
    this.samples.push({ stamp, at: now, point: [...point] }); if (this.samples.length > 3) this.samples.shift();
    if (!last) { this.rendered = [...point]; this.lastFrame = now; }
    return true;
  }
  update(now, moving = true) {
    const last = this.samples.at(-1); if (!last) return this.rendered;
    const age = Math.max(0, now - last.at), dt = Math.max(0, Math.min(100, now - (this.lastFrame ?? now)));
    this.lastFrame = now;
    const horizon = Math.min(this.horizon, this.average * .35);
    const predict = moving && horizon > 0 && age < horizon;
    const distance = Math.hypot(...this.velocity) * age / 1000;
    const factor = predict ? Math.min(1, this.distanceLimit / Math.max(distance, 1e-9)) * age / 1000 : 0;
    const alpha = 1 - Math.exp(-dt / 180);
    let error = 0;
    for (let i = 0; i < 3; i++) {
      const target = last.point[i] + this.velocity[i] * factor;
      this.rendered[i] += (target - this.rendered[i]) * alpha;
      if (Math.abs(target - this.rendered[i]) < .0001) this.rendered[i] = target;
      error += Math.abs(target - this.rendered[i]);
    }
    this.mode = predict && Math.hypot(...this.velocity) > 0 ? 'PREDIÇÃO' : error > .001 ? 'INTERPOLANDO' : age > this.horizon ? 'PARADO' : 'REAL';
    return this.rendered;
  }
}

const Panel = globalThis.customElements?.get('ha3d-lab-panel');
if (Panel) {
  const proto = Panel.prototype;
  const enabledKey = 'ha3d_lab_robot_motion_v1';
  const states = new WeakMap();
  const update = proto._updateRobots;
  proto._updateRobots = function (snap = false) {
    const result = update.call(this, snap);
    if (!this._labMotionEnabled || this._robotCalibration) return result;
    const now = performance.now();
    const debug = this._labMotionDebug && now >= (this._labMotionDebugAt || 0);
    let text = '';
    for (const entry of this._robotEntries?.values() || []) {
      const root = entry.object || entry.icon; if (!root?.visible) continue;
      let state = states.get(entry);
      if (!state || snap) { state = { estimator: new RobotMotion(), vector: new Panel.HA3D_THREE.Vector3() }; states.set(entry, state); }
      const motion = state.estimator, stamp = Date.parse(entry.lastStamp);
      const age = Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : Infinity;
      // Use source timestamp, not render calls, as the sample identity and age.
      motion.sample(stamp, now - age, [entry.target.x, entry.target.y, entry.target.z]);
      const vacuum = this._hass?.states?.[entry.config.vacuum_entity]?.state;
      const p = motion.update(now, age < motion.horizon && ['cleaning', 'returning'].includes(vacuum));
      if (!motion.samples.length) continue;
      state.vector.set(p[0], p[1], p[2]);
      if (root.parent) root.parent.worldToLocal(state.vector);
      root.position.copy(state.vector); // Quaternion/heading is left untouched.
      if (debug) {
        const raw = this._hass?.states?.[entry.config.position_entity];
        text += `${entry.config.name || entry.config.id}\nRecebida X/Y: ${raw?.state || '—'}\nRender XYZ: ${p.map(v => v.toFixed(3)).join(' / ')}\nIdade: ${Math.round(age)} ms · intervalo: ${Math.round(motion.interval)} ms\nMédia: ${Math.round(motion.average)} ms · velocidade: ${Math.hypot(...motion.velocity).toFixed(3)} un/s\n${motion.mode}\n`;
      }
    }
    if (debug) { this._labMotionDebugAt = now + 250; const node = this.shadowRoot.querySelector('#labMotionDebug'); if (node) node.textContent = text || 'Nenhum robô com posição válida.'; }
    return result;
  };
  const shell = proto._renderShell;
  proto._renderShell = function (...args) {
    const result = shell.apply(this, args);
    try { this._labMotionEnabled = localStorage.getItem(enabledKey) === '1'; } catch { this._labMotionEnabled = false; }
    const section = document.createElement('section'); section.id = 'labMotionSettings';
    section.innerHTML = '<h3 style="font-size:14px">Movimento visual do robô</h3><label><input id="labMotionEnabled" type="checkbox"> Continuidade experimental</label><p style="font-size:12px">Previsão limitada a 600 ms e 0,15 unidade da cena. A posição real continua sendo a referência.</p><label><input id="labMotionDebugEnabled" type="checkbox"> Mostrar diagnóstico</label><pre id="labMotionDebug" style="white-space:pre-wrap;font-size:11px" hidden></pre>';
    this.shadowRoot.querySelector('#viewsPanel').append(section);
    section.querySelector('#labMotionEnabled').checked = this._labMotionEnabled;
    section.querySelector('#labMotionEnabled').addEventListener('change', event => {
      this._labMotionEnabled = event.target.checked;
      try { localStorage.setItem(enabledKey, this._labMotionEnabled ? '1' : '0'); } catch { this._setStatus('Preferência válida somente nesta sessão.'); }
      for (const entry of this._robotEntries?.values() || []) states.delete(entry);
      this._updateRobots(true);
    });
    section.querySelector('#labMotionDebugEnabled').addEventListener('change', event => {
      this._labMotionDebug = event.target.checked; section.querySelector('#labMotionDebug').hidden = !event.target.checked;
      if (!this._labMotionEnabled) section.querySelector('#labMotionDebug').textContent = 'Continuidade experimental desligada.';
    });
    return result;
  };
}
