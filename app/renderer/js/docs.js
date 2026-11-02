'use strict';
/* docs.js — JavaScript, Python, HTTP and formula reference. */
(function () {
  const { fmt, el, esc } = window.UI;
  const Views = (window.Views = window.Views || {});

  const dom = {};
  let app = null;
  let tab = 'js';

  const JS_SNIPPET = `// Node 18+ — talks to the running ACPU Studio device service.
import { ACPUDevice } from './sdk/node/acpu.mjs';

const dev = new ACPUDevice();            // auto-discovers 127.0.0.1:9771
console.log(await dev.status());          // chip identity + live counters

const run = await dev.forecast({ members: 64, lead_days: 10 });
console.log(run.summary);
console.log(run.metrics.timeS, 's', run.metrics.energyJ, 'J');

// Or dispatch with the same call grammar the console uses:
const same = await dev.call('assimilate(members=64, cycles=12)');
`;

  const PY_SNIPPET = `# Python 3.8+ — no dependencies, standard library only.
from sdk.python.acpu import ACPUDevice

dev = ACPUDevice()                        # discovers the local service
print(dev.status()["device"])             # ACPU-1 Tempest

run = dev.forecast(members=64, lead_days=10, precision="adaptive")
print(run["summary"])
print(run["metrics"]["timeS"], "s", run["metrics"]["energyJ"], "J")

# Cycles of assimilation, dispersion, tracer transport and the benchmark table
asy = dev.assimilate(members=64, cycles=12)
mc = dev.dispersion(members=512, steps=120)
bench = dev.benchmark()
for row in bench["tables"][0]["rows"]:
    print(row["id"], row["time"], row["energy"], row["tflops"])
`;

  const ARCH = `+-----------------------------------------------------------------------------+
| ACPU Studio (Electron 45)                                                    |
|                                                                             |
|  renderer/  console . device . runs . docs      preload.js (contextBridge)  |
|      |  window.acpu.<method>()                        |                     |
|      +------------------- IPC -------------------------+                     |
|                                                                             |
|  main.js   run manager . telemetry fan-out (10 Hz) . settings . history     |
|      |-- core/formulas.js   registry . parser . 8 formulas . call preview   |
|      |-- core/kernels.js    L96 . FTLE . EnKF . advection . precision . MC  |
|      |-- core/device.js     virtual ACPU-1: 64 AVTs, DVFS, RC thermal       |
|      +-- HTTP 127.0.0.1:9771  /v1/device /v1/formulas /v1/run /v1/runs/:id  |
+-----------------------------------------------------------------------------+
        ^                                  ^
        | sdk/node/acpu.mjs                | sdk/python/acpu.py (stdlib only)
        +--------------- HTTP -------------+`;

  const HTTP_SNIPPET = `# The local device service is enabled by default on 127.0.0.1:9771.
curl -s http://127.0.0.1:9771/health
curl -s http://127.0.0.1:9771/v1/device | jq .state
curl -s http://127.0.0.1:9771/v1/formulas | jq '.formulas[].callName'

curl -s -X POST http://127.0.0.1:9771/v1/run \\
  -H 'Content-Type: application/json' \\
  -d '{"formula":"ensemble_forecast","params":{"members":64,"lead_days":10,"precision":"adaptive"}}'

# The same run can be dispatched from a single call string:
curl -s -X POST http://127.0.0.1:9771/v1/run \\
  -H 'Content-Type: application/json' \\
  -d '{"call":"lyapunov(leads=12, days=15)"}'
`;

  function mount(root, application) {
    app = application;
    root.innerHTML = `
      <div class="view-head">
        <div>
          <div class="view-title">Docs</div>
          <div class="view-sub">Three ways to call the same virtual device: the renderer, a dependency-free Python client, and the loopback HTTP service.</div>
        </div>
        <div class="mono dim" style="font-size:10.5px" id="doc-status"></div>
      </div>
      <div class="tabs">
        <button class="tab active" data-tab="js">JavaScript</button>
        <button class="tab" data-tab="py">Python</button>
        <button class="tab" data-tab="http">HTTP API</button>
        <button class="tab" data-tab="formulas">Formulas</button>
      </div>
      <div id="doc-body"></div>`;
    dom.body = el('#doc-body');
    dom.status = el('#doc-status');
    root.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        root.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
        render();
      });
    });
    render();
  }

  function codeBlock(code, label) {
    return `<div class="code-block"><button class="code-copy" data-copy="${esc(label)}">Copy</button><pre>${esc(code)}</pre></div>`;
  }

  function render() {
    const svc = app.state.settings && app.state.settings.service;
    if (dom.status) {
      dom.status.textContent = svc && svc.running
        ? `service ${svc.url} · ${(app.state.device && app.state.device.chip.tiles) || 64} AVTs`
        : 'service stopped — enable in Settings';
    }
    if (tab === 'js') {
      dom.body.innerHTML = `
        <div class="doc-h">Node client</div>
        <div class="doc-p">The Node SDK wraps the HTTP service and falls back to the core modules directly if the app is not running. It is dependency free and runs on Node 18 or newer.</div>
        ${codeBlock(JS_SNIPPET, 'node')}
        <div class="doc-h">Renderer API</div>
        <div class="doc-p">Inside the app the renderer only sees the preload bridge: <code class="inline-code">acpu.formulaList()</code>, <code class="inline-code">acpu.run(id, params)</code>, <code class="inline-code">acpu.onTelemetry(cb)</code>. No node integration, context isolation on.</div>
        ${codeBlock(`const formulas = await window.acpu.formulaList();
const res = await window.acpu.run('ensemble_forecast', { members: 64, lead_days: 10 });
window.acpu.onTelemetry((frame) => console.log(frame.powerW, frame.junctionC));`, 'renderer')}
        <div class="doc-h">How a run flows</div>
        <div class="doc-p">The renderer never touches the numerics: it calls the bridge, the main process runs the kernel and the device model, then replays the device timeline back at 10 Hz.</div>
        ${codeBlock(ARCH, 'architecture')}`;
    } else if (tab === 'py') {
      dom.body.innerHTML = `
        <div class="doc-h">Python client</div>
        <div class="doc-p">Standard library only — <code class="inline-code">urllib</code>, <code class="inline-code">json</code>, nothing else. It auto-discovers the service on 127.0.0.1 ports 9771–9780 and raises a clear error when ACPU Studio is not running.</div>
        ${codeBlock(PY_SNIPPET, 'python')}
        <div class="doc-h">Run the quickstart</div>
        ${codeBlock(`python3 sdk/python/examples/quickstart.py`, 'quickstart')}`;
    } else if (tab === 'http') {
      dom.body.innerHTML = `
        <div class="doc-h">HTTP API</div>
        <div class="doc-p">Loopback only. Every response is JSON. Errors carry <code class="inline-code">{error, code}</code> with a human-readable message.</div>
        <div class="card" style="margin-bottom:12px"><div class="table-wrap"><table class="grid">
          <thead><tr><th class="l">Method</th><th class="l">Path</th><th class="l">Returns</th></tr></thead>
          <tbody>
            <tr><td class="l mono">GET</td><td class="l mono">/health</td><td class="l">service identity, uptime, run count</td></tr>
            <tr><td class="l mono">GET</td><td class="l mono">/v1/device</td><td class="l">chip descriptor, live state, counters, event log</td></tr>
            <tr><td class="l mono">GET</td><td class="l mono">/v1/telemetry</td><td class="l">latest telemetry frame (~10 Hz)</td></tr>
            <tr><td class="l mono">GET</td><td class="l mono">/v1/formulas</td><td class="l">formula registry with parameter schemas</td></tr>
            <tr><td class="l mono">POST</td><td class="l mono">/v1/run</td><td class="l">{formula, params} or {call} → run record</td></tr>
            <tr><td class="l mono">GET</td><td class="l mono">/v1/runs</td><td class="l">run history (summaries)</td></tr>
            <tr><td class="l mono">GET</td><td class="l mono">/v1/runs/:id</td><td class="l">one run with charts and tables</td></tr>
          </tbody>
        </table></div></div>
        ${codeBlock(HTTP_SNIPPET, 'http')}`;
    } else {
      const rows = (app.state.formulas || []).map((f) => `
        <tr>
          <td class="l"><b>${esc(f.name)}</b></td>
          <td class="l mono" style="color:#2BB3A3">${esc(f.callName)}</td>
          <td class="l mono" style="font-size:10.5px;color:#8494A7">${f.params.map((p) => `${p.key}:${p.type === 'enum' ? p.options.map((o) => o.value).join('|') : p.type}`).join(', ')}</td>
          <td class="l" style="font-size:11px;color:#8494A7">${esc(f.description)}</td>
        </tr>`).join('');
      dom.body.innerHTML = `
        <div class="doc-h">Formula reference</div>
        <div class="doc-p">Generated from the live registry in <code class="inline-code">core/formulas.js</code>. Every formula validates its parameters server-side and rejects out-of-range values with a readable error.</div>
        <div class="card"><div class="table-wrap"><table class="grid">
          <thead><tr><th class="l">Formula</th><th class="l">Call</th><th class="l">Parameters</th><th class="l">What it does</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div></div>
        <div class="doc-h">Call grammar</div>
        <div class="doc-p">One line, named arguments, string values quoted. The console, the HTTP service and both SDKs share this parser.</div>
        ${codeBlock(`forecast(model="l96", members=64, lead_days=10, precision="adaptive")
lyapunov(leads=12, days=15)
assimilate(members=64, cycles=12, inflation=1.06)
transport(grid=48, steps=240, shear=1.0)
precision_study(members=32, lead_days=6)
dispersion(members=512, steps=120, turbulence=0.045)
conservation_audit(grid=48, steps=2000)
benchmark(precision="adaptive", resolution="operational")`, 'grammar')}`;
    }
    dom.body.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pre = btn.parentElement.querySelector('pre');
        window.UI.copy(pre.textContent, 'Snippet copied');
      });
    });
  }

  function refresh() { if (dom.body) render(); }

  Views.docs = { mount, refresh };
}());
