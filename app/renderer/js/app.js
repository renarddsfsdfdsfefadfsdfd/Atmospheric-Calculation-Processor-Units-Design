'use strict';
/*
 * app.js — shell state, routing, telemetry fan-out and the settings modal.
 * The views (console, device, runs, docs) are separate classic scripts that
 * register themselves on window.Views and are mounted lazily.
 */
(function () {
  const { fmt, h, el, toast, esc } = window.UI;
  const Views = (window.Views = window.Views || {});

  const state = {
    view: 'console',
    formulas: [],
    byId: {},
    selected: null,
    params: {},
    settings: null,
    device: null,
    telemetry: null,
    history: [],
    running: false,
    runId: null,
    runs: [],
    logs: [],
    lastResult: null,
    platform: 'darwin',
  };
  const mounted = {};

  const App = {
    state,
    log(sev, msg) {
      const entry = { t: new Date().toISOString(), sev, msg };
      state.logs.push(entry);
      if (state.logs.length > 240) state.logs.shift();
      if (mounted.console) mounted.console.onLog(entry);
    },
    setView,
    selectFormula,
    runSelected,
    refreshRuns,
    requestAnimationFrame,
  };
  window.App = App;

  // -------------------------------------------------------------- top bar

  const chipRefs = {};
  function buildChips() {
    const host = el('#device-chips');
    host.innerHTML = `
      <div class="chip device">
        <span class="v" id="chip-device">ACPU-1</span>
        <span class="k">·</span><span class="v" id="chip-tiles">64/64 tiles</span>
        <span class="k">·</span><span class="v" id="chip-clock">1.80 GHz</span>
      </div>
      <div class="chip">
        <span class="v" id="chip-power">6.3 W</span>
        <span class="k">·</span><span class="v" id="chip-temp">40 °C</span>
      </div>
      <div class="chip">
        <span class="k">Source</span><span class="v" id="chip-service">9771</span>
      </div>`;
    for (const id of ['device', 'tiles', 'clock', 'power', 'temp', 'service']) chipRefs[id] = el(`#chip-${id}`);
  }

  function updateChips(snap) {
    if (!snap || !chipRefs.power) return;
    const active = snap.tilesActive == null ? 64 : snap.tilesActive;
    chipRefs.tiles.textContent = `${active}/64 tiles`;
    chipRefs.clock.textContent = `${(snap.clockGHz || 1.8).toFixed(2)} GHz`;
    chipRefs.power.textContent = `${(snap.powerW || 0).toFixed(1)} W`;
    chipRefs.temp.textContent = `${Math.round(snap.junctionC || 0)} °C`;
    chipRefs.power.classList.toggle('warn', (snap.powerW || 0) > 45);
    chipRefs.temp.classList.toggle('warn', (snap.junctionC || 0) > 85);
  }

  function setRunState(running, label) {
    const pill = el('#run-state');
    pill.classList.toggle('running', !!running);
    pill.classList.toggle('idle', !running);
    el('#run-state-label').textContent = label || (running ? 'Running' : 'Idle');
  }

  // -------------------------------------------------------------- rail

  function renderFormulaList() {
    const host = el('#formula-list');
    const q = (el('#formula-search').value || '').trim().toLowerCase();
    const items = state.formulas.filter((f) => {
      if (!q) return true;
      return `${f.name} ${f.category} ${f.id} ${f.description}`.toLowerCase().includes(q);
    });
    if (!items.length) {
      host.innerHTML = '<div class="rail-empty">No formula matches that search.</div>';
      return;
    }
    host.innerHTML = items.map((f) => `
      <button class="rail-formula ${f.id === state.selected ? 'active' : ''}" data-formula="${esc(f.id)}">
        <span class="rf-name">${esc(f.name)}</span>
        <span class="rf-cat">${esc(f.category)}</span>
      </button>`).join('');
    host.querySelectorAll('[data-formula]').forEach((btn) => {
      btn.addEventListener('click', () => selectFormula(btn.dataset.formula));
    });
  }

  // -------------------------------------------------------------- routing

  function setView(name, opts = {}) {
    state.view = name;
    const ids = ['console', 'device', 'runs', 'docs'];
    for (const id of ids) {
      const section = el(`#view-${id}`);
      if (!section) continue;
      section.hidden = id !== name;
      if (id === name && !mounted[id] && Views[id]) {
        Views[id].mount(section, App);
        mounted[id] = Views[id];
      }
    }
    const main = el('#main');
    if (main) {
      main.scrollTop = 0;
      // Re-assert after the new section has laid out (hidden->visible can
      // restore a stale scroll offset).
      requestAnimationFrame(() => { main.scrollTop = 0; });
      setTimeout(() => { main.scrollTop = 0; }, 60);
    }
    document.body.classList.toggle('no-tel', name !== 'console');
    document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'console' && mounted.console) mounted.console.refresh();
    if (name === 'device' && mounted.device) mounted.device.refresh();
    if (name === 'runs' && mounted.runs) mounted.runs.refresh();
    if (name === 'docs' && mounted.docs) mounted.docs.refresh();
    if (opts.anchor) {
      const node = el(opts.anchor);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function selectFormula(id) {
    if (!state.byId[id]) return;
    state.selected = id;
    state.params = {};
    renderFormulaList();
    setView('console');
    if (mounted.console) mounted.console.select(id);
  }

  // -------------------------------------------------------------- runs

  async function refreshRuns() {
    state.runs = await window.acpu.runsList();
    if (mounted.runs) mounted.runs.refresh();
    const total = state.runs.reduce((a, r) => a + (r.metrics ? r.metrics.energyJ : 0), 0);
    el('#stat-runs').textContent = String(state.runs.length);
    el('#stat-energy').textContent = window.UI.fmt.energy(total);
  }

  async function runSelected() {
    if (state.running) return;
    const f = state.byId[state.selected];
    if (!f) return;
    const params = {};
    for (const p of f.params) {
      const v = state.params[p.key];
      params[p.key] = v === undefined ? p.default : v;
    }
    state.running = true;
    state.runId = null;
    setRunState(true, 'Running');
    if (mounted.console) mounted.console.onRunStart(f, params);
    App.log('info', `dispatch ${f.callName} → ${f.name}`);
    try {
      const res = await window.acpu.run(state.selected, params, true);
      if (!res.ok) throw new Error(res.error || 'run failed');
      const rec = res.record;
      state.lastResult = rec;
      App.log('ok', `${rec.call} → ${fmt.time(rec.metrics.timeS)} · ${fmt.energy(rec.metrics.energyJ)} · ${fmt.power(rec.metrics.powerW)} · peak Tj ${rec.metrics.peakTj} °C`);
      if (mounted.console) mounted.console.onResult(rec);
      await refreshRuns();
    } catch (err) {
      App.log('err', err.message);
      toast(err.message, 'err', 5000);
      if (mounted.console) mounted.console.onRunFail(err.message);
    } finally {
      state.running = false;
      state.runId = null;
      setRunState(false);
    }
  }

  // -------------------------------------------------------------- telemetry

  function onTelemetry(snap) {
    state.telemetry = snap;
    state.history.push(snap);
    if (state.history.length > 600) state.history.shift();
    updateChips(snap);
    if (mounted.console) mounted.console.onTelemetry(snap);
    if (mounted.device && state.view === 'device') mounted.device.onTelemetry(snap);
  }

  // -------------------------------------------------------------- settings

  function openSettings() {
    const s = state.settings || {};
    const svc = s.service || {};
    const modal = el('#settings-modal');
    const scrim = el('#settings-scrim');
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">Settings</div>
        <button class="ghost-btn" data-close>Close</button>
      </div>
      <div class="modal-body">
        <div class="setting">
          <div class="setting-info">
            <div class="setting-name">Local device service</div>
            <div class="setting-desc">HTTP endpoint the Python and Node SDKs call. Loopback only.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="set-service" ${s.serviceEnabled ? 'checked' : ''} />
            <span class="track"></span>
            <span class="sw-label" id="set-service-label">${s.serviceEnabled ? 'on' : 'off'}</span>
          </label>
        </div>
        <div class="setting">
          <div class="setting-info">
            <div class="setting-name">Service port</div>
            <div class="setting-desc" id="set-service-status">${svc.running ? `Listening on ${esc(svc.url)}` : 'Stopped'}</div>
          </div>
          <input type="number" id="set-port" min="1024" max="65535" value="${s.servicePort || 9771}" />
        </div>
        <div class="setting">
          <div class="setting-info">
            <div class="setting-name">Animate dispatches</div>
            <div class="setting-desc">Replay the device timeline at wall-clock speed (~1 s per run).</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="set-animate" ${s.animateRuns !== false ? 'checked' : ''} />
            <span class="track"></span>
            <span class="sw-label">${s.animateRuns !== false ? 'on' : 'off'}</span>
          </label>
        </div>
        <div class="setting">
          <div class="setting-info">
            <div class="setting-name">Telemetry rate</div>
            <div class="setting-desc">Frames per second streamed to the panel (4–20).</div>
          </div>
          <input type="number" id="set-hz" min="4" max="20" value="${s.telemetryHz || 10}" />
        </div>
        <div class="setting">
          <div class="setting-info">
            <div class="setting-name">Data directory</div>
            <div class="setting-desc mono" style="font-size:10px">${esc(s.dataDir || '')}</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>Done</button>
        <button class="btn primary" id="set-save">Save</button>
      </div>`;
    modal.hidden = false;
    scrim.hidden = false;
    const close = () => { modal.hidden = true; scrim.hidden = true; };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    scrim.onclick = close;
    el('#set-service').addEventListener('change', (e) => {
      el('#set-service-label').textContent = e.target.checked ? 'on' : 'off';
    });
    el('#set-save').addEventListener('click', async () => {
      const patch = {
        serviceEnabled: el('#set-service').checked,
        servicePort: Number(el('#set-port').value) || 9771,
        animateRuns: el('#set-animate').checked,
        telemetryHz: Number(el('#set-hz').value) || 10,
      };
      const next = await window.acpu.saveSettings(patch);
      state.settings = next;
      const chip = el('#chip-service');
      if (chip) chip.textContent = next.service && next.service.running ? String(next.service.port) : 'off';
      toast('Settings saved');
      close();
    });
  }

  // -------------------------------------------------------------- boot

  async function boot() {
    buildChips();
    const info = await window.acpu.deviceInfo();
    state.device = info;
    state.platform = info.app ? info.app.platform : 'darwin';
    if (info.service) {
      const chip = el('#chip-service');
      chip.textContent = info.service.running ? String(info.service.port) : 'off';
      el('#btn-service').classList.toggle('on', !!info.service.running);
      el('#btn-service').title = info.service.running
        ? `Device service listening on ${info.service.url}`
        : 'Device service stopped — enable it in Settings';
    }
    state.settings = await window.acpu.settings();
    const formulas = await window.acpu.formulaList();
    state.formulas = formulas;
    for (const f of formulas) state.byId[f.id] = f;
    state.selected = formulas.length ? formulas[0].id : null;
    renderFormulaList();

    document.querySelectorAll('.rail-item').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    el('#btn-settings').addEventListener('click', openSettings);
    el('#btn-service').addEventListener('click', () => {
      const svc = state.settings && state.settings.service;
      if (!svc || !svc.running) { openSettings(); return; }
      window.acpu.copy(`${svc.url}/health`);
      toast(`Service ${svc.url} · health URL copied`);
    });
    el('#formula-search').addEventListener('input', renderFormulaList);
    el('#formula-search').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.value = ''; renderFormulaList(); }
      if (e.key === 'Enter') {
        const first = el('#formula-list .rail-formula');
        if (first) selectFormula(first.dataset.formula);
      }
    });

    window.acpu.onTelemetry(onTelemetry);
    window.acpu.onRunStarted((p) => {
      state.runId = p.runId;
      if (mounted.console) mounted.console.onRunEvent(p);
    });
    window.acpu.onRunProgress((p) => {
      if (mounted.console) mounted.console.onProgress(p);
    });
    window.acpu.onRunDone(async (summary) => {
      if (summary) state.lastResult = { ...summary, startedAt: summary.startedAt };
      await refreshRuns();
    });

    setRunState(false);
    setView('console');
    if (mounted.console) mounted.console.select(state.selected);
    await refreshRuns();
    App.log('ok', `ACPU-1 Tempest online · ${info.chip.tiles} AVTs · ${info.chip.peakTflopsFp32} TFLOPS fp32 · ${info.memory.hbmGb} GB HBM3E`);
    if (state.settings && state.settings.service && state.settings.service.running) {
      App.log('info', `device service ${state.settings.service.url}`);
    }
    const snap = await window.acpu.telemetry();
    if (snap) onTelemetry(snap);

    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); el('#formula-search').focus(); return; }
      if (meta && e.key === 'Enter') { e.preventDefault(); runSelected(); return; }
      if (e.key === 'Escape') {
        const modal = el('#settings-modal');
        if (modal && !modal.hidden) { modal.hidden = true; el('#settings-scrim').hidden = true; return; }
      }
      if (!typing && !meta && ['1', '2', '3', '4'].includes(e.key)) {
        setView(['console', 'device', 'runs', 'docs'][Number(e.key) - 1]);
      }
    });
  }

  window.addEventListener('error', (e) => {
    App.log('err', `renderer: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    App.log('err', `renderer: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
  });

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error(err);
      document.body.innerHTML = `<div style="padding:40px;color:#E5534B;font-family:monospace">ACPU Studio failed to start: ${esc(err.message)}</div>`;
    });
  });
}());
