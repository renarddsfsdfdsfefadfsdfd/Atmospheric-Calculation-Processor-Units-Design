'use strict';
/* runs.js — run history table plus a full detail sheet. */
(function () {
  const { fmt, el, esc, toast } = window.UI;
  const CH = window.Charts;
  const Views = (window.Views = window.Views || {});

  const dom = {};
  let app = null;
  let selected = null;
  let detail = null;

  function mount(root, application) {
    app = application;
    root.innerHTML = `
      <div class="view-head">
        <div>
          <div class="view-title">Runs</div>
          <div class="view-sub">Every dispatch through the device model, with the exact parameters that produced it.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="r-refresh">Refresh</button>
          <button class="btn danger" id="r-clear">Clear all</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">History</span><span class="mono dim" style="font-size:10px" id="r-count"></span></div>
        <div class="table-wrap" id="r-table"></div>
      </div>
      <div class="run-detail" id="r-detail"></div>`;
    dom.table = el('#r-table');
    dom.detail = el('#r-detail');
    dom.count = el('#r-count');
    el('#r-refresh').addEventListener('click', () => app.refreshRuns());
    el('#r-clear').addEventListener('click', async () => {
      await window.acpu.runsClear();
      selected = null;
      detail = null;
      dom.detail.innerHTML = '';
      await app.refreshRuns();
      toast('Run history cleared');
    });
    render();
  }

  function render() {
    const runs = app.state.runs;
    dom.count.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
    if (!runs.length) {
      dom.table.innerHTML = '<div class="empty">No runs yet — open the Console, pick a formula and dispatch it on the ACPU.</div>';
      return;
    }
    dom.table.innerHTML = `
      <table class="grid runs-table">
        <thead><tr>
          <th class="l">Formula</th><th class="l">Parameters</th><th class="r">Time</th><th class="r">Energy</th>
          <th class="r">Throughput</th><th class="r">Power</th><th class="r">Tj</th><th class="l">When</th><th class="l"></th>
        </tr></thead>
        <tbody>
          ${runs.map((r) => {
    const m = r.metrics || {};
    const ps = Object.entries(r.params || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : v}`).join(' · ');
    return `<tr data-run="${esc(r.id)}" class="${r.id === selected ? 'selected' : ''}">
              <td class="l"><b>${esc(r.name)}</b><div class="dim mono" style="font-size:10px">${esc(r.callName)}</div></td>
              <td class="l mono" style="font-size:10.5px;color:#8494A7;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ps)}</td>
              <td class="r">${fmt.time(m.timeS)}</td>
              <td class="r">${fmt.energy(m.energyJ)}</td>
              <td class="r">${fmt.flops(m.tflops)}</td>
              <td class="r">${fmt.power(m.powerW)}</td>
              <td class="r">${m.peakTj ? m.peakTj.toFixed(1) : '—'} °C</td>
              <td class="l dim" style="font-size:10.5px">${fmt.stamp(r.startedAt)}</td>
              <td class="l"><button class="ghost-btn" data-del="${esc(r.id)}" title="Delete run">✕</button></td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>`;
    dom.table.querySelectorAll('[data-run]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        open(row.dataset.run);
      });
    });
    dom.table.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.acpu.runDelete(btn.dataset.del);
        if (selected === btn.dataset.del) { selected = null; dom.detail.innerHTML = ''; }
        await app.refreshRuns();
      });
    });
  }

  async function open(id) {
    selected = id;
    render();
    detail = await window.acpu.runGet(id);
    if (!detail) { dom.detail.innerHTML = '<div class="empty">That run is no longer in the store.</div>'; return; }
    const m = detail.metrics || {};
    const rows = [
      ['Device time', fmt.time(m.timeS)],
      ['Energy', fmt.energy(m.energyJ)],
      ['Mean power', fmt.power(m.powerW)],
      ['Throughput', fmt.flops(m.tflops)],
      ['Array utilisation', fmt.pct(m.util, 2)],
      ['Peak junction', `${fmt.num(m.peakTj, 1)} °C`],
      ['Cycles', fmt.int(m.cycles)],
      ['Bottleneck', m.bottleneck || '—'],
    ];
    const params = Object.entries(detail.params || {}).map(([k, v]) => `<span class="pill-mini">${esc(k)} <b style="color:#E6EDF3;margin-left:4px">${esc(String(v))}</b></span>`).join(' ');
    dom.detail.innerHTML = `
      <div class="card">
        <div class="card-head">
          <span class="card-title">${esc(detail.name)} · ${esc(detail.call)}</span>
          <span class="mono dim" style="font-size:10px">${fmt.stamp(detail.startedAt)}</span>
        </div>
        <div class="card-body">
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${params}</div>
          <div class="grid-3" style="gap:10px">
            <div class="card" style="background:#0F151D"><div class="card-body" style="padding:8px 10px">
              ${rows.slice(0, 4).map(([k, v]) => `<div class="tel-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
            </div></div>
            <div class="card" style="background:#0F151D"><div class="card-body" style="padding:8px 10px">
              ${rows.slice(4).map(([k, v]) => `<div class="tel-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
            </div></div>
            <div class="card" style="background:#0F151D"><div class="card-body" style="padding:8px 10px">
              <div class="upper" style="margin-bottom:4px">Summary</div>
              <div style="font-size:11.5px;color:#8494A7;line-height:1.45">${esc(detail.summary || '')}</div>
            </div></div>
          </div>
        </div>
      </div>
      <div class="charts">
        ${(detail.charts || []).map((c, i) => `
          <div class="chart-card">
            <div class="chart-head"><span class="chart-title">${esc(c.title || '')}</span></div>
            <div class="chart-canvas-wrap"><canvas class="chart-canvas" data-dchart="${i}"></canvas></div>
          </div>`).join('')}
      </div>`;
    (detail.charts || []).forEach((c, i) => {
      const canvas = dom.detail.querySelector(`[data-dchart="${i}"]`);
      if (canvas) CH.mount(canvas, c);
    });
  }

  function refresh() {
    if (!dom.table) return;
    render();
  }

  Views.runs = { mount, refresh };
}());
