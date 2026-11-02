'use strict';
/* device.js — the chip itself: tile grid, clusters, power, memory, clocks. */
(function () {
  const { fmt, h, el, esc } = window.UI;
  const CH = window.Charts;
  const Views = (window.Views = window.Views || {});

  const dom = {};
  let app = null;
  let info = null;
  let history = [];

  function mount(root, application) {
    app = application;
    info = app.state.device;
    root.innerHTML = `
      <div class="view-head">
        <div>
          <div class="view-title">ACPU-1 Tempest</div>
          <div class="view-sub">8 clusters × 8 Atmospheric Vector Tiles · 256 lanes per tile · 1.80 GHz nominal, 2.10 GHz boost · PCIe 6.0 ×16, 65 W slot-powered.</div>
        </div>
        <div class="mono dim" style="font-size:10.5px;text-align:right" id="d-header-right"></div>
      </div>
      <div class="metrics" id="d-spec"></div>
      <div class="grid-2" style="margin-top:14px;align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head">
              <span class="card-title">AVT utilisation · 8 × 8</span>
              <span class="mono dim" style="font-size:10px" id="d-tilesub">64 / 64 tiles</span>
            </div>
            <div class="card-body">
              <div class="tile-grid" id="d-tilegrid"></div>
              <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:10px;color:#61707F" class="mono">
                <span>idle</span><span class="teal">busy →</span><span>saturated</span>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Power &amp; junction temperature · 60 s</span><span class="mono dim" style="font-size:10px" id="d-powersub"></span></div>
            <div class="card-body">
              <canvas class="chart-canvas" id="d-powerspark" style="height:96px"></canvas>
              <div class="grid-2" style="margin-top:8px;gap:8px">
                <div><div class="upper">Card power</div><div class="num" style="font-size:18px" id="d-power">—</div></div>
                <div><div class="upper">Junction</div><div class="num" style="font-size:18px" id="d-temp">—</div></div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Event log</span><span class="mono dim" style="font-size:10px">device firmware</span></div>
            <div class="card-body"><div class="event-log" id="d-events"></div></div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Cluster utilisation</span><span class="mono dim" style="font-size:10px">8 clusters</span></div>
            <div class="card-body"><div class="cluster-strip" id="d-clusters"></div></div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Memory bandwidth</span><span class="mono dim" style="font-size:10px" id="d-memsub"></span></div>
            <div class="card-body" id="d-meters"></div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Clock domains</span><span class="mono dim" style="font-size:10px">9 domains</span></div>
            <div class="card-body"><div class="clock-list" id="d-clocks"></div></div>
          </div>
        </div>
      </div>`;
    dom.spec = el('#d-spec');
    dom.tilegrid = el('#d-tilegrid');
    dom.tilesub = el('#d-tilesub');
    dom.powerspark = el('#d-powerspark');
    dom.power = el('#d-power');
    dom.temp = el('#d-temp');
    dom.powersub = el('#d-powersub');
    dom.clusters = el('#d-clusters');
    dom.meters = el('#d-meters');
    dom.memsub = el('#d-memsub');
    dom.clocks = el('#d-clocks');
    dom.events = el('#d-events');
    dom.headerRight = el('#d-header-right');
    build();
    onTelemetry(app.state.telemetry || (info && info.state));
  }

  function build() {
    const chip = (info && info.chip) || {};
    const mem = (info && info.memory) || {};
    const pw = (info && info.power) || {};
    const spec = [
      { label: 'AVTs', value: String(chip.tiles || 64), sub: '8 clusters × 8 tiles' },
      { label: 'Lanes', value: fmt.int(chip.lanes || 16384), sub: '256 per tile' },
      { label: 'FP32 peak', value: `${chip.peakTflopsFp32 || 58.98} <span class="u">TFLOPS</span>`, sub: `fp16 ${chip.peakTflopsFp16 || 117.96} · fp8 ${chip.peakTopsFp8 || 235.93}` },
      { label: 'HBM3E', value: `${mem.hbmGb || 48} <span class="u">GB</span>`, sub: `${mem.hbmTbs || 2.4} TB/s · 2 stacks` },
      { label: 'Cache', value: `${mem.l2Mb || 24} + ${mem.l3Mb || 128} <span class="u">MB</span>`, sub: 'L2 per cluster 3 MB' },
    ];
    dom.spec.innerHTML = spec.map((s) => `
      <div class="metric">
        <div class="m-label">${esc(s.label)}</div>
        <div class="m-value">${s.value}</div>
        <div class="m-sub">${esc(s.sub)}</div>
      </div>`).join('');

    dom.headerRight.innerHTML = `${esc(chip.process || '')} · ${chip.transistorsG || 28.4} G transistors · ${chip.dieMm2 || 287.6} mm²`;

    dom.tilegrid.innerHTML = Array.from({ length: 64 }, (_, i) => {
      const c = Math.floor(i / 8);
      const t = i % 8;
      return `<div class="tile" data-tile="${i}" data-cluster="${c}" data-index="${t}"><span class="tile-id">${c}.${t}</span></div>`;
    }).join('');
    dom.tilegrid.querySelectorAll('[data-tile]').forEach((node) => {
      node.addEventListener('mousemove', (e) => showTileTip(node, e));
      node.addEventListener('mouseleave', () => { const tip = el('#chart-tip'); if (tip) tip.hidden = true; });
    });

    dom.clusters.innerHTML = Array.from({ length: 8 }, (_, i) => `
      <div class="cluster-col">
        <div class="cluster-bar-track"><div class="cluster-bar-fill" data-cbar="${i}" style="height:2%"></div></div>
        <div class="cluster-name">C${i}</div>
        <div class="cluster-val" data-cval="${i}">0 %</div>
      </div>`).join('');

    const meterDefs = [
      ['l2', 'L2 aggregate', '9.6 TB/s'],
      ['l3', 'L3 dies', '8.0 TB/s'],
      ['hbm', 'HBM3E', '2.4 TB/s'],
      ['noc', 'NoC', '16 Tb/s'],
    ];
    dom.meters.innerHTML = meterDefs.map(([id, label, cap]) => `
      <div class="meter" data-meter="${id}">
        <div class="meter-head"><span>${esc(label)}</span><b>0 % · ${esc(cap)}</b></div>
        <div class="meter-track"><div class="meter-fill" style="width:0%"></div></div>
      </div>`).join('');

    const domains = (info && info.clockDomains) || [];
    dom.clocks.innerHTML = domains.map((d) => `
      <div class="clock-row">
        <span class="cn">${esc(d.name)}</span>
        <span class="cg" data-clock="${esc(d.name)}">${d.ghz.toFixed(2)} GHz</span>
        <span class="cv">${d.vdd.toFixed(2)} V</span>
      </div>`).join('');

    const events = (info && info.eventLog) || [];
    dom.events.innerHTML = events.slice(-40).reverse().map((e) => `
      <div class="event-line">
        <span class="event-time">${fmt.clock(new Date(e.t).toISOString())}</span>
        <span class="event-kind">${esc(e.kind)}</span>
        <span class="event-text">${esc(e.text)}</span>
      </div>`).join('') || '<div class="dim">No device events yet.</div>';
  }

  function showTileTip(node, evt) {
    const tip = el('#chart-tip');
    const snap = app.state.telemetry;
    if (!tip || !snap) return;
    const i = Number(node.dataset.tile);
    const util = snap.tileUtil && snap.tileUtil.length === 64 ? snap.tileUtil[i] : 0;
    const cluster = Math.floor(i / 8);
    tip.innerHTML = `<div class="tip-x">AVT ${cluster}.${i % 8}</div>utilisation <b>${(util * 100).toFixed(1)} %</b><br>cluster <b>C${cluster}</b> · lanes <b>256</b><br>SRAM <b>256 KB</b> · halo <b>6 × 32 B</b>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, evt.clientX + 14)}px`;
    tip.style.top = `${Math.max(8, evt.clientY - tip.offsetHeight - 12)}px`;
  }

  function onTelemetry(snap) {
    if (!snap || !dom.tilegrid) return;
    history.push(snap);
    if (history.length > 600) history.shift();
    const til = snap.tileUtil && snap.tileUtil.length === 64 ? snap.tileUtil : new Array(64).fill(0);
    dom.tilegrid.querySelectorAll('[data-tile]').forEach((node) => {
      const v = Math.max(0, Math.min(1, til[Number(node.dataset.tile)] || 0));
      const col = v < 0.02 ? [19, 28, 38] : [
        Math.round(19 + (43 - 19) * v),
        Math.round(28 + (179 - 28) * v),
        Math.round(38 + (163 - 38) * v),
      ];
      node.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
      node.style.color = v > 0.55 ? 'rgba(6,20,18,0.75)' : 'rgba(230,237,243,0.45)';
    });
    const active = (snap.tileUtil || []).filter((v) => v > 0.5).length;
    dom.tilesub.textContent = `${active} / 64 tiles > 50 %`;

    (snap.clusterUtil || []).forEach((v, i) => {
      const bar = dom.clusters.querySelector(`[data-cbar="${i}"]`);
      const val = dom.clusters.querySelector(`[data-cval="${i}"]`);
      if (bar) bar.style.height = `${Math.max(2, Math.min(100, v * 100)).toFixed(1)}%`;
      if (val) val.textContent = `${(v * 100).toFixed(0)} %`;
    });

    dom.power.textContent = `${(snap.powerW || 0).toFixed(1)} W`;
    dom.temp.textContent = `${(snap.junctionC || 0).toFixed(1)} °C`;
    dom.powersub.textContent = `${((snap.powerW || 0) / 65 * 100).toFixed(0)} % of TDP · heatsink ${(snap.heatsinkC || 0).toFixed(1)} °C`;
    CH.lineSpark(dom.powerspark, [
      { values: history.map((s) => s.powerW), color: '#2BB3A3', fill: 'rgba(43,179,163,0.12)' },
      { values: history.map((s) => s.junctionC), color: '#F2A93B' },
    ], { min: 0, max: 95 });

    const mu = snap.memUtil || {};
    dom.meters.querySelectorAll('[data-meter]').forEach((row) => {
      const k = row.dataset.meter;
      const v = Math.max(0, Math.min(1, mu[k] || 0));
      const fill = row.querySelector('.meter-fill');
      fill.style.width = `${(v * 100).toFixed(1)}%`;
      fill.classList.toggle('amber', v > 0.7 && v <= 0.88);
      fill.classList.toggle('danger', v > 0.88);
      row.querySelector('.meter-head b').textContent = `${(v * 100).toFixed(0)} %`;
    });
    dom.memsub.textContent = `${(mu.hbm * 2.4 || 0).toFixed(2)} TB/s on HBM`;

    dom.clocks.querySelectorAll('[data-clock="AVT core"]').forEach((n) => { n.textContent = `${(snap.clockGHz || 1.8).toFixed(2)} GHz`; });
  }

  function refresh() {
    if (!dom.tilegrid) return;
    if (app.state.device) { info = app.state.device; }
    onTelemetry(app.state.telemetry);
  }

  Views.device = { mount, refresh, onTelemetry };
}());
