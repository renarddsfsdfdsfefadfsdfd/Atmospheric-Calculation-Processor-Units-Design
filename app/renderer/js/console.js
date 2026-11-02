'use strict';
/* console.js — formula workbench: parameters, call preview, run, results, log. */
(function () {
  const { fmt, h, el, esc, tick, highlightCall, toast } = window.UI;
  const Views = (window.Views = window.Views || {});
  const CH = window.Charts;

  const dom = {};
  let app = null;
  let formula = null;
  let params = {};
  let running = false;
  let charts = [];
  let telRefs = null;

  const PHASES = ['map', 'schedule', 'execute', 'reduce'];
  const PHASE_LABEL = { map: 'map', schedule: 'schedule', execute: 'execute', reduce: 'reduce' };

  function mount(root, application) {
    app = application;
    root.innerHTML = `
      <div class="console-head">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="pill-mini teal" id="c-category">Forecast</span>
            <span class="console-id" id="c-id"></span>
          </div>
          <h1 class="console-title" id="c-title" style="margin-top:6px"></h1>
          <div class="math" id="c-math"></div>
          <div class="console-desc" id="c-desc"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <span class="card-title">Parameters</span>
          <span class="mono dim" style="font-size:10px" id="c-schema"></span>
        </div>
        <div class="params" id="c-params"></div>
      </div>
      <div style="margin-top:12px">
        <div class="callbar">
          <div class="callcode mono" id="c-call"></div>
          <button class="icon-btn" id="c-copy" title="Copy call">⧉</button>
        </div>
        <div class="run-row">
          <button class="run-btn" id="c-run">Run on ACPU <span class="kbd-hint">⌘↵</span></button>
          <div class="run-meta" id="c-meta"></div>
        </div>
        <div class="progress" id="c-progress" hidden>
          <div class="progress-top">
            <span class="mono" id="c-phase">map</span>
            <span class="mono dim" id="c-pct">0 %</span>
          </div>
          <div class="progress-track"><div class="progress-fill" id="c-fill"></div></div>
          <div class="phases">
            ${PHASES.map((p) => `<div class="phase" data-phase="${p}">${PHASE_LABEL[p]}</div>`).join('')}
          </div>
        </div>
      </div>
      <div id="c-results"></div>
      <div class="card" style="margin-top:20px">
        <div class="card-head"><span class="card-title">Streaming log</span><span class="mono dim" style="font-size:10px" id="c-logcount"></span></div>
        <div class="log" id="c-log"></div>
      </div>`;
    dom.category = el('#c-category');
    dom.id = el('#c-id');
    dom.title = el('#c-title');
    dom.math = el('#c-math');
    dom.desc = el('#c-desc');
    dom.schema = el('#c-schema');
    dom.params = el('#c-params');
    dom.call = el('#c-call');
    dom.copy = el('#c-copy');
    dom.run = el('#c-run');
    dom.meta = el('#c-meta');
    dom.progress = el('#c-progress');
    dom.phase = el('#c-phase');
    dom.pct = el('#c-pct');
    dom.fill = el('#c-fill');
    dom.results = el('#c-results');
    dom.log = el('#c-log');
    dom.logCount = el('#c-logcount');

    dom.copy.addEventListener('click', () => window.UI.copy(dom.call.textContent, 'Call copied'));
    dom.run.addEventListener('click', () => app.runSelected());
    buildTelemetryColumn();
    app.state.logs.slice(-40).forEach(addLog);
    if (formula) select(app.state.selected);
  }

  // ------------------------------------------------------------ formula

  function select(id) {
    formula = app.state.byId[id];
    if (!formula) return;
    params = {};
    for (const p of formula.params) params[p.key] = p.default;
    app.state.params = params;
    dom.category.textContent = formula.category;
    dom.id.textContent = formula.id;
    dom.title.textContent = formula.name;
    dom.math.textContent = formula.math;
    dom.desc.textContent = formula.description;
    dom.schema.textContent = `${formula.params.length} parameters · schema v1`;
    dom.results.innerHTML = '';
    charts = [];
    dom.progress.hidden = true;
    renderParams();
    renderCall();
    addLog({ t: new Date().toISOString(), sev: 'info', msg: `selected ${formula.name} · ${formula.example}` });
  }

  function renderParams() {
    dom.params.innerHTML = formula.params.map((p) => {
      const id = `p-${p.key}`;
      if (p.type === 'bool') {
        return `<div class="param">
          <div class="param-head"><span class="param-label">${esc(p.label)}</span></div>
          <label class="switch">
            <input type="checkbox" id="${id}" ${params[p.key] ? 'checked' : ''} />
            <span class="track"></span>
            <span class="sw-label" data-sw="${p.key}">${params[p.key] ? 'enabled' : 'disabled'}</span>
          </label>
          <div class="param-help">${esc(p.help || '')}</div>
        </div>`;
      }
      if (p.type === 'enum') {
        return `<div class="param">
          <div class="param-head"><span class="param-label">${esc(p.label)}</span></div>
          <select id="${id}">
            ${p.options.map((o) => `<option value="${esc(o.value)}" ${params[p.key] === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
          <div class="param-help">${esc(p.help || '')}</div>
        </div>`;
      }
      const step = p.step || (p.type === 'int' ? 1 : 0.01);
      const fill = ((params[p.key] - p.min) / (p.max - p.min)) * 100;
      return `<div class="param">
        <div class="param-head">
          <span class="param-label">${esc(p.label)}<span class="unit">${esc(p.unit && p.unit.length <= 4 ? p.unit : `${p.min}–${p.max}`)}</span></span>
          <input class="param-value" type="number" id="${id}-num" min="${p.min}" max="${p.max}" step="${step}" value="${params[p.key]}" />
        </div>
        <input type="range" id="${id}-rng" min="${p.min}" max="${p.max}" step="${step}" value="${params[p.key]}" style="--fill:${fill}%" />
        <div class="param-help">${esc(p.help || '')}</div>
      </div>`;
    }).join('');

    for (const p of formula.params) {
      const id = `p-${p.key}`;
      if (p.type === 'bool') {
        el(`#${id}`).addEventListener('change', (e) => {
          params[p.key] = e.target.checked;
          const sw = dom.params.querySelector(`[data-sw="${p.key}"]`);
          if (sw) sw.textContent = e.target.checked ? 'enabled' : 'disabled';
          afterChange();
        });
      } else if (p.type === 'enum') {
        el(`#${id}`).addEventListener('change', (e) => { params[p.key] = e.target.value; afterChange(); });
      } else {
        const rng = el(`#${id}-rng`);
        const num = el(`#${id}-num`);
        const sync = (raw, from) => {
          let v = Number(raw);
          if (!Number.isFinite(v)) return;
          v = Math.max(p.min, Math.min(p.max, v));
          if (p.type === 'int') v = Math.round(v);
          params[p.key] = v;
          if (from !== 'rng') rng.value = String(v);
          if (from !== 'num') num.value = String(v);
          rng.style.setProperty('--fill', `${((v - p.min) / (p.max - p.min)) * 100}%`);
          afterChange();
        };
        rng.addEventListener('input', (e) => sync(e.target.value, 'rng'));
        num.addEventListener('change', (e) => sync(e.target.value, 'num'));
        num.addEventListener('input', (e) => { if (e.target.value !== '') sync(e.target.value, 'num'); });
      }
    }
  }

  function afterChange() {
    app.state.params = { ...params };
    renderCall();
  }

  function renderCall() {
    const call = app.state.byId[formula.id] && window.App ? buildCall() : formula.example;
    dom.call.innerHTML = highlightCall(call);
    dom.meta.innerHTML = `device <b>ACPU-1</b> · seed <b>20261102</b> · deterministic`;
  }

  function buildCall() {
    const parts = formula.params.map((p) => {
      const v = params[p.key];
      const lit = typeof v === 'string' ? `"${v}"` : String(v);
      return `${p.key}=${lit}`;
    });
    return `${formula.callName}(${parts.join(', ')})`;
  }

  // ------------------------------------------------------------ run

  function onRunStart(f, p) {
    running = true;
    dom.run.disabled = true;
    dom.run.innerHTML = 'Running… <span class="kbd-hint">⌘↵</span>';
    dom.progress.hidden = false;
    setProgress(0, 'map');
    dom.results.innerHTML = '';
    charts = [];
    addLog({ t: new Date().toISOString(), sev: 'info', msg: `run ${f.callName}(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ')})` });
  }

  function onRunEvent(p) {
    addLog({ t: new Date().toISOString(), sev: 'info', msg: `dispatch ${p.runId} accepted · ${fmt.time((p.wallMs || 1000) / 1000)} replay` });
  }

  function setProgress(pct, phase) {
    dom.fill.style.width = `${Math.max(2, pct * 100).toFixed(1)}%`;
    dom.pct.textContent = `${Math.round(pct * 100)} %`;
    dom.phase.textContent = phase;
    const order = PHASES.indexOf(phase);
    dom.progress.querySelectorAll('.phase').forEach((node, i) => {
      node.classList.toggle('active', i === order);
      node.classList.toggle('done', i < order);
    });
  }

  function onProgress(p) {
    setProgress(p.pct, p.phase);
  }

  function onRunFail(message) {
    running = false;
    dom.run.disabled = false;
    dom.run.innerHTML = 'Run on ACPU <span class="kbd-hint">⌘↵</span>';
    dom.progress.hidden = true;
    dom.results.innerHTML = `<div class="card" style="margin-top:14px"><div class="card-body" style="color:#E5534B">${esc(message)}</div></div>`;
    addLog({ t: new Date().toISOString(), sev: 'err', msg: message });
  }

  function onResult(rec) {
    running = false;
    dom.run.disabled = false;
    dom.run.innerHTML = 'Run on ACPU <span class="kbd-hint">⌘↵</span>';
    setProgress(1, 'reduce');
    addLog({ t: new Date().toISOString(), sev: 'ok', msg: `${rec.name} complete · ${fmt.time(rec.metrics.timeS)} · ${fmt.energy(rec.metrics.energyJ)}` });
    renderResults(rec);
  }

  function renderResults(rec) {
    const m = rec.metrics;
    const metrics = [
      { label: 'Device time', value: fmt.time(m.timeS), sub: `${fmt.int(m.cycles)} cycles`, accent: true, tickTo: m.timeS, render: (v) => fmt.time(v) },
      { label: 'Energy', value: fmt.energy(m.energyJ), sub: blockShare(m), tickTo: m.energyJ, render: (v) => fmt.energy(v) },
      { label: 'Power', value: fmt.power(m.powerW), sub: `peak ${fmt.power(m.peakPowerW || m.powerW)}`, tickTo: m.powerW, render: (v) => fmt.power(v) },
      { label: 'Throughput', value: fmt.flops(m.tflops), sub: `${fmt.pct(m.util, m.util < 0.01 ? 4 : 1)} of peak`, tickTo: m.tflops, render: (v) => fmt.flops(v) },
      { label: 'Peak Tj', value: `${fmt.num(m.peakTj, 1)} °C`, sub: `limit 95 °C · ${fmt.num(95 - m.peakTj, 1)} K margin`, tickTo: m.peakTj, render: (v) => `${v.toFixed(1)} °C` },
    ];

    const chartCards = (rec.charts || []).map((c, i) => `
      <div class="chart-card">
        <div class="chart-head">
          <span class="chart-title">${esc(c.title || '')}</span>
          <span class="chart-legend">${legendFor(c)}</span>
        </div>
        <div class="chart-canvas-wrap"><canvas class="chart-canvas" data-chart="${i}"></canvas></div>
        ${c.note ? `<div class="chart-note">${esc(c.note)}</div>` : ''}
      </div>`).join('');

    const tables = (rec.tables || []).map((t, i) => `
      <div class="card" style="margin-top:12px">
        <div class="card-head">
          <span class="card-title">${esc(t.title)}</span>
          ${t.note ? `<span class="dim" style="font-size:10px">${esc(t.note)}</span>` : ''}
        </div>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr>${t.columns.map((c) => `<th class="${c.align === 'right' ? 'r' : 'l'}">${esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td class="${c.align === 'right' ? 'r' : 'l'}">${esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        ${t.spark ? `<div class="spark-row"><span class="spark-label">${esc(t.spark.label)}</span><canvas class="spark-canvas" data-spark="${i}"></canvas></div>` : ''}
      </div>`).join('');

    dom.results.innerHTML = `
      <div class="section-title">Result · ${esc(rec.call)}</div>
      <div class="metrics">${metrics.map((x, i) => `
        <div class="metric ${x.accent ? 'accent' : ''}">
          <div class="m-label">${esc(x.label)}</div>
          <div class="m-value" data-metric="${i}"></div>
          <div class="m-sub">${esc(x.sub)}</div>
        </div>`).join('')}</div>
      <div class="charts">${chartCards}</div>
      ${tables}
      <div class="card" style="margin-top:12px">
        <div class="card-head"><span class="card-title">Findings</span><span class="dim" style="font-size:10px">${esc(rec.summary || '')}</span></div>
        <div class="card-body notes">
          ${(rec.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
        </div>
      </div>`;

    // metric tickers
    metrics.forEach((x, i) => {
      const node = dom.results.querySelector(`[data-metric="${i}"]`);
      if (!node) return;
      if (Number.isFinite(x.tickTo)) tick(node, x.tickTo, x.render);
      else node.textContent = x.value;
    });

    charts = [];
    (rec.charts || []).forEach((spec, i) => {
      const canvas = dom.results.querySelector(`[data-chart="${i}"]`);
      if (!canvas) return;
      if (spec.type === 'heatmap') {
        const rows = spec.values.length;
        const cols = spec.values[0].length;
        canvas.style.height = `${Math.max(150, Math.min(210, 120 + (cols / rows > 3 ? 0 : 30)))}px`;
      }
      CH.mount(canvas, spec);
      charts.push(canvas);
    });
    (rec.tables || []).forEach((t, i) => {
      if (!t.spark) return;
      const canvas = dom.results.querySelector(`[data-spark="${i}"]`);
      if (canvas) CH.sparkline(canvas, t.spark.values, { max: Math.max(0.2, ...t.spark.values) });
    });
  }

  /** Two largest power blocks as a share of the card total. */
  function blockShare(m) {
    const bp = m.perBlockPower || {};
    const total = Object.values(bp).reduce((a, b) => a + b, 0) || 1;
    const top = Object.entries(bp)
      .filter(([k]) => k !== 'board')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (!top.length) return '';
    return top.map(([k, v]) => `${k.toUpperCase()} ${((v / total) * 100).toFixed(0)} %`).join(' · ');
  }

  function legendFor(c) {
    const items = [];
    if (c.series) c.series.forEach((s, i) => items.push([s.name, CH.palette[i % CH.palette.length]]));
    if (c.lines) c.lines.forEach((s, i) => items.push([s.name, s.color || CH.palette[(i + 1) % CH.palette.length]]));
    if (c.bands) c.bands.forEach((b) => items.push([b.name, 'rgba(43,179,163,0.45)']));
    if (c.type === 'heatmap' && c.unit) items.push([`0 – ${CH.fmtNum(c.vmax)} ${c.unit}`, 'linear-gradient(90deg,#0B1015,#2BB3A3,#F2A93B)']);
    return items.slice(0, 6).map(([name, color]) => `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${esc(name)}</span>`).join('');
  }

  // ------------------------------------------------------------ log

  function addLog(entry) {
    if (!dom.log) return;
    const line = document.createElement('div');
    line.className = `log-line ${entry.sev}`;
    line.innerHTML = `<span class="log-time">${fmt.clock(entry.t)}</span><span class="log-sev ${entry.sev}">${entry.sev === 'ok' ? 'ok' : entry.sev}</span><span class="log-msg">${esc(entry.msg)}</span>`;
    dom.log.appendChild(line);
    while (dom.log.children.length > 160) dom.log.removeChild(dom.log.firstChild);
    dom.log.scrollTop = dom.log.scrollHeight;
    if (dom.logCount) dom.logCount.textContent = `${dom.log.children.length} lines`;
  }

  // ------------------------------------------------------------ telemetry column

  function buildTelemetryColumn() {
    const host = el('#telemetry');
    if (!host) return;
    host.innerHTML = `
      <div class="tel-head"><span class="t">Telemetry</span><span class="mono dim" style="font-size:10px" id="t-hz">10 Hz</span></div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Card power</span><span class="tel-sub" id="t-power-sub">TDP 65 W</span></div>
        <div class="tel-big" id="t-power">6.3<span class="u">W</span></div>
        <canvas class="sparkline" id="t-power-spark"></canvas>
      </div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Junction</span><span class="tel-sub" id="t-temp-sub">limit 95 °C</span></div>
        <div class="tel-big" id="t-temp">40<span class="u">°C</span></div>
        <canvas class="sparkline" id="t-temp-spark"></canvas>
      </div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Cluster occupancy</span><span class="tel-sub" id="t-tiles">64 / 64 tiles</span></div>
        <div class="mini-grid" id="t-tilegrid">${Array.from({ length: 8 }, (_, i) => `<div class="mini-tile" data-tile="${i}"></div>`).join('')}</div>
      </div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Block power</span><span class="tel-sub" id="t-block-sum">—</span></div>
        <div class="block-bars" id="t-blocks"></div>
      </div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Memory bandwidth</span><span class="tel-sub" id="t-mem-top">—</span></div>
        <div id="t-meters"></div>
      </div>
      <div class="tel-block">
        <div class="tel-row"><span class="k">Last run</span><span class="tel-sub" id="t-last-age">—</span></div>
        <div id="t-last" class="dim" style="font-size:11px">No run yet this session.</div>
      </div>`;
    telRefs = {
      power: el('#t-power'),
      powerSub: el('#t-power-sub'),
      powerSpark: el('#t-power-spark'),
      temp: el('#t-temp'),
      tempSub: el('#t-temp-sub'),
      tempSpark: el('#t-temp-spark'),
      tiles: el('#t-tiles'),
      tileGrid: Array.from(document.querySelectorAll('#t-tilegrid .mini-tile')),
      miniTiles: true,
      blockSum: el('#t-block-sum'),
      blocks: el('#t-blocks'),
      memTop: el('#t-mem-top'),
      meters: el('#t-meters'),
      last: el('#t-last'),
      lastAge: el('#t-last-age'),
      hz: el('#t-hz'),
    };
    const BLOCKS = [
      ['mac', 'MAC arrays', 18], ['sram', 'SRAM + L2', 7], ['l3', 'L3 dies', 5], ['noc', 'NoC', 4.5],
      ['hbm', 'HBM PHY', 8], ['pcie', 'PCIe / IO', 3], ['clock', 'Clock + PLL', 2.5], ['leak', 'Leakage', 4],
      ['misc', 'Misc', 3], ['board', 'Board + fans', 3],
    ];
    telRefs.blocks.innerHTML = BLOCKS.map(([id, label, max]) => `
      <div class="block-bar" data-block="${id}">
        <span>${label}</span>
        <span class="bb-track"><span class="bb-fill" style="width:0%"></span></span>
        <b>0.0 W</b>
      </div>`).join('');
    telRefs.blockMax = Object.fromEntries(BLOCKS.map(([id, , max]) => [id, max]));
    telRefs.meters.innerHTML = [
      ['l2', 'L2 · 24 MB · 9.6 TB/s'],
      ['l3', 'L3 · 128 MB · 8.0 TB/s'],
      ['hbm', 'HBM3E · 2.4 TB/s'],
      ['noc', 'NoC · 16 Tb/s'],
    ].map(([id, label]) => `
      <div class="meter" data-meter="${id}">
        <div class="meter-head"><span>${label}</span><b>0 %</b></div>
        <div class="meter-track"><div class="meter-fill" style="width:0%"></div></div>
      </div>`).join('');
  }

  function onTelemetry(snap) {
    if (!telRefs || !snap) return;
    telRefs.power.innerHTML = `${(snap.powerW || 0).toFixed(1)}<span class="u">W</span>`;
    telRefs.powerSub.textContent = `${((snap.powerW || 0) / 65 * 100).toFixed(0)} % of 65 W TDP`;
    telRefs.temp.innerHTML = `${Math.round(snap.junctionC || 0)}<span class="u">°C</span>`;
    telRefs.tempSub.textContent = `${Math.max(0, 95 - (snap.junctionC || 0)).toFixed(1)} K to Tj,max`;
    telRefs.tiles.textContent = `${snap.tilesActive || 64} / 64 tiles`;
    if (telRefs.hz) telRefs.hz.textContent = `${app.state.settings && app.state.settings.telemetryHz ? app.state.settings.telemetryHz : 10} Hz`;

    const hist = app.state.history;
    if (hist.length > 2) {
      CH.lineSpark(telRefs.powerSpark, [{ values: hist.map((s) => s.powerW), color: '#2BB3A3', fill: 'rgba(43,179,163,0.12)' }], { min: 0 });
      CH.lineSpark(telRefs.tempSpark, [{ values: hist.map((s) => s.junctionC), color: '#F2A93B', fill: 'rgba(242,169,59,0.10)' }], { min: 30 });
    }

    const cl = snap.clusterUtil || new Array(8).fill(0);
    telRefs.tileGrid.forEach((node, i) => {
      const t = Math.max(0, Math.min(1, cl[i] || 0));
      node.style.background = t < 0.05 ? '#16202B' : `rgba(43,179,163,${0.14 + t * 0.78})`;
      node.title = `cluster ${i} · ${(t * 100).toFixed(0)} %`;
    });

    const bp = snap.blockPower || {};
    let sum = 0;
    telRefs.blocks.querySelectorAll('[data-block]').forEach((row) => {
      const id = row.dataset.block;
      const w = bp[id] || 0;
      sum += w;
      const max = telRefs.blockMax[id] || 10;
      row.querySelector('.bb-fill').style.width = `${Math.min(100, (w / max) * 100).toFixed(1)}%`;
      row.querySelector('b').textContent = `${w.toFixed(1)} W`;
    });
    telRefs.blockSum.textContent = `${sum.toFixed(1)} W`;

    const mu = snap.memUtil || {};
    let top = ['l2', 'l3', 'hbm', 'noc'].reduce((a, k) => ((mu[k] || 0) > (mu[a] || 0) ? k : a), 'l2');
    telRefs.memTop.textContent = `${(mu[top] * 100 || 0).toFixed(0)} % ${top.toUpperCase()}`;
    telRefs.meters.querySelectorAll('[data-meter]').forEach((row) => {
      const k = row.dataset.meter;
      const v = Math.max(0, Math.min(1, mu[k] || 0));
      const fill = row.querySelector('.meter-fill');
      fill.style.width = `${(v * 100).toFixed(1)}%`;
      fill.classList.toggle('amber', v > 0.7 && v <= 0.88);
      fill.classList.toggle('danger', v > 0.88);
      row.querySelector('b').textContent = `${(v * 100).toFixed(0)} %`;
    });

    if (!app.state.lastResult && app.state.runs && app.state.runs.length && app.state.runs[0].metrics) {
      const r0 = app.state.runs[0];
      app.state.lastResult = {
        name: r0.name, callName: r0.callName, call: r0.call, startedAt: r0.startedAt,
        metrics: { timeS: r0.metrics.timeS, energyJ: r0.metrics.energyJ, peakTj: r0.metrics.peakTj },
      };
    }
    if (app.state.lastResult) {
      const m = app.state.lastResult.metrics;
      telRefs.last.innerHTML = `<div class="tel-row"><span class="k">${esc(app.state.lastResult.callName || '')}</span><span class="v">${fmt.time(m.timeS)}</span></div>
        <div class="tel-row"><span class="k">energy</span><span class="v">${fmt.energy(m.energyJ)}</span></div>
        <div class="tel-row"><span class="k">peak Tj</span><span class="v">${m.peakTj.toFixed(1)} °C</span></div>`;
      telRefs.lastAge.textContent = window.UI.relTime(app.state.lastResult.startedAt);
    }
  }

  function refresh() {
    if (charts.length) charts.forEach((c) => window.Charts.render(c));
    if (telRefs && app.state.telemetry) onTelemetry(app.state.telemetry);
  }

  Views.console = { mount, select, refresh, onTelemetry, onLog: addLog, onRunStart, onRunEvent, onProgress, onResult, onRunFail };
}());
