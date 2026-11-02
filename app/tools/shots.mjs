#!/usr/bin/env node
/*
 * tools/shots.mjs — launch ACPU Studio, drive it over the DevTools protocol and
 * capture the five acceptance screenshots at 1600 × 1000.
 *
 *   node tools/shots.mjs
 *
 * The app is started with ACPU_HEADLESS=1 so that it runs inside a sandboxed
 * automation environment (no helper-process sandbox, software rendering). The
 * pages are driven with Runtime.evaluate and captured with Page.captureScreenshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'shots');
const PORT = Number(process.env.ACPU_CDP_PORT || 9333);
const W = 1600;
const H = 1000;
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { process.stdout.write(`${msg}\n`); }

async function targetList() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    return await res.json();
  } catch {
    return null;
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      this.id += 1;
      this.pending.set(this.id, resolve);
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception
        ? r.result.exceptionDetails.exception.description
        : r.result.exceptionDetails.text);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async waitFor(expression, timeoutMs = 20000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await this.eval(expression);
      if (v) return v;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
      captureBeyondViewport: false,
    });
    const buf = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(file, buf);
    return buf.length;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, ACPU_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + path.join(ROOT, '.profile')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  child.stdout.on('data', (d) => { appLog += d.toString(); });
  child.stderr.on('data', (d) => { appLog += d.toString(); });

  let list = null;
  for (let i = 0; i < 80; i += 1) {
    list = await targetList();
    if (list && list.some((t) => t.type === 'page')) break;
    await sleep(250);
  }
  const page = (list || []).find((t) => t.type === 'page');
  if (!page) {
    console.error(appLog.slice(-3000));
    throw new Error('the app did not expose a DevTools page target');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const shots = [];
  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    }
  });

  // ---------------------------------------------------------------- console
  await cdp.waitFor('!!(window.acpu && document.querySelector("#c-run") && document.querySelectorAll(".rail-formula").length === 8)', 25000, 'console');

  // Seed a small, plausible history so the Runs view has content to show.
  await cdp.eval('window.acpu.runsClear()');
  await cdp.eval('window.acpu.run("ensemble_forecast", { members: 32, lead_days: 5, precision: "fp16" }, false)');
  await cdp.eval('window.acpu.run("data_assimilation", { members: 48, cycles: 10 }, false)');
  await cdp.eval('window.acpu.run("dispersion_montecarlo", { members: 768, steps: 100 }, false)');
  await sleep(1400); // let the first telemetry frames land
  shots.push(['01-console.png', await cdp.shot(path.join(OUT, '01-console.png'))]);

  // ---------------------------------------------------------------- run
  await cdp.eval('document.querySelector("#c-run").click()');
  await cdp.waitFor('document.querySelectorAll("#c-results canvas.chart-canvas").length >= 4', 40000, 'run results');
  await sleep(500);
  await cdp.eval('document.querySelector("#c-results").scrollIntoView({block:"start"})');
  await sleep(700);
  shots.push(['02-results.png', await cdp.shot(path.join(OUT, '02-results.png'))]);

  // ---------------------------------------------------------------- device
  await cdp.eval('document.querySelector(".rail-item[data-view=device]").click()');
  await sleep(600);
  // dispatch a real workload and capture the panel while the tiles are lit
  await cdp.eval('void (window.__bench = window.acpu.run("benchmark_suite", { precision: "adaptive" }, true))');
  await cdp.waitFor('parseFloat(document.querySelector("#d-power").textContent) > 40', 15000, 'device under load');
  await sleep(250);
  shots.push(['03-device.png', await cdp.shot(path.join(OUT, '03-device.png'))]);
  await cdp.waitFor('document.querySelector("#run-state-label").textContent !== "Running"', 20000, 'benchmark completion');
  await sleep(400);

  // ---------------------------------------------------------------- runs
  await cdp.eval('document.querySelector(".rail-item[data-view=runs]").click()');
  await sleep(800);
  await cdp.eval('document.querySelector("#r-table tbody tr") ? document.querySelector("#r-table tbody tr").click() : null');
  await sleep(1000);
  shots.push(['04-runs.png', await cdp.shot(path.join(OUT, '04-runs.png'))]);

  // ---------------------------------------------------------------- docs
  await cdp.eval('document.querySelector(".rail-item[data-view=docs]").click()');
  await sleep(700);
  shots.push(['05-docs.png', await cdp.shot(path.join(OUT, '05-docs.png'))]);

  ws.close();
  await sleep(200);
  try { child.kill('SIGTERM'); } catch { /* already gone */ }

  const bad = shots.filter(([, bytes]) => bytes < 40 * 1024);
  log('');
  log('ACPU Studio · screenshot run');
  log('─'.repeat(64));
  for (const [name, bytes] of shots) {
    log(`${name.padEnd(18)}${(bytes / 1024).toFixed(1).padStart(8)} KB   ${bytes >= 40 * 1024 ? 'OK' : 'TOO SMALL'}`);
  }
  if (errors.length) {
    log(`\nrenderer exceptions (${errors.length}):`);
    for (const e of errors.slice(0, 6)) log(`  ${String(e).split('\n')[0]}`);
  }
  if (bad.length) {
    log(`\nFAIL: ${bad.length} screenshot(s) under 40 KB`);
    process.exit(1);
  }
  log(`\nPASS — ${shots.length} screenshots in ${path.relative(process.cwd(), OUT) || OUT} at ${W}×${H}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
