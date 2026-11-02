#!/usr/bin/env node
/*
 * sdk/node/acpu.mjs — Node client for the ACPU Studio device service.
 *
 * Zero dependencies. It talks to the loopback HTTP service that ACPU Studio
 * starts on 127.0.0.1:9771 (Settings → Local device service). If the service is
 * not running the SDK falls back to the core modules directly, so CLI use and
 * unit tests still work without the GUI.
 *
 * Library:
 *   import { ACPUDevice } from './sdk/node/acpu.mjs';
 *   const dev = new ACPUDevice();
 *   const run = await dev.forecast({ members: 64, lead_days: 10 });
 *
 * CLI:
 *   node sdk/node/acpu.mjs forecast --members 64 --lead 10
 *   node sdk/node/acpu.mjs benchmark --json
 *   node sdk/node/acpu.mjs status
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);

const DEFAULT_PORTS = [9771, 9772, 9773, 9774, 9775, 9776, 9777, 9778, 9779, 9780];
const HOST = '127.0.0.1';

export class ACPUServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ACPUServiceError';
    this.code = code || 'service_unavailable';
  }
}

/** Discover a running ACPU Studio device service on the loopback interface. */
export async function discover({ ports = DEFAULT_PORTS, timeoutMs = 400 } = {}) {
  for (const port of ports) {
    const url = `http://${HOST}:${port}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${url}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.status === 'ok') return { url, port, health: body };
    } catch {
      /* try the next port */
    }
  }
  return null;
}

const NOT_RUNNING = [
  'ACPU Studio is not running (no device service answered on 127.0.0.1:9771-9780).',
  'Start the app and make sure Settings -> Local device service is enabled,',
  'then retry. In the desktop UI the service state is shown next to the wordmark.',
].join('\n');

export class ACPUDevice {
  /**
   * @param {object} opts
   * @param {string} [opts.url]   explicit base URL, e.g. http://127.0.0.1:9771
   * @param {number} [opts.port]  explicit port
   * @param {number} [opts.timeoutMs] request timeout
   */
  constructor(opts = {}) {
    this.url = opts.url || (opts.port ? `http://${HOST}:${opts.port}` : null);
    this.timeoutMs = opts.timeoutMs || 120000;
    this._ready = null;
    this._core = null;
  }

  async _resolve() {
    if (this.url) return this.url;
    if (!this._ready) {
      this._ready = discover().then((found) => {
        if (!found) return null;
        this.url = found.url;
        return found.url;
      });
    }
    return this._ready;
  }

  async _request(method, pathname, body) {
    const base = await this._resolve();
    if (!base) throw new ACPUServiceError(NOT_RUNNING);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ACPUServiceError(`could not reach ${base}${pathname}: ${err.message}`, 'transport');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      throw new ACPUServiceError((data && data.error) || `${res.status} ${res.statusText}`, (data && data.code) || 'http_error');
    }
    return data;
  }

  /** Chip identity, live state and counters. */
  async status() {
    const dev = await this._request('GET', '/v1/device');
    return {
      device: `${dev.chip.name} ${dev.chip.codename}`,
      tiles: dev.chip.tiles,
      clusters: dev.chip.clusters,
      clockGHz: dev.state.clockGHz,
      powerW: dev.state.powerW,
      junctionC: dev.state.junctionC,
      runs: dev.counters.runs,
      energyJ: dev.counters.energyJ,
      service: dev.service,
      raw: dev,
    };
  }

  async formulas() {
    const body = await this._request('GET', '/v1/formulas');
    return body.formulas;
  }

  async telemetry() {
    return this._request('GET', '/v1/telemetry');
  }

  async runs() {
    return (await this._request('GET', '/v1/runs')).runs;
  }

  async runById(id) {
    return this._request('GET', `/v1/runs/${encodeURIComponent(id)}`);
  }

  /** Dispatch a formula by registry id or call name. */
  async run(formula, params = {}) {
    const body = await this._request('POST', '/v1/run', { formula, params });
    return body.result || body;
  }

  /** Dispatch with the console call grammar: assimilate(members=64, cycles=12). */
  async call(text) {
    const body = await this._request('POST', '/v1/run', { call: text });
    return body.result || body;
  }

  // ---- typed helpers -----------------------------------------------------

  forecast(opts = {}) {
    return this.run('ensemble_forecast', {
      members: opts.members == null ? 64 : opts.members,
      lead_days: opts.lead_days == null ? (opts.lead == null ? 10 : opts.lead) : opts.lead_days,
      precision: opts.precision || 'adaptive',
      kahan: !!opts.kahan,
      model: opts.model || 'l96',
    });
  }

  lyapunov(opts = {}) {
    return this.run('lyapunov_spectrum', { leads: opts.leads == null ? 12 : opts.leads, days: opts.days == null ? 15 : opts.days });
  }

  assimilate(opts = {}) {
    return this.run('data_assimilation', {
      members: opts.members == null ? 64 : opts.members,
      cycles: opts.cycles == null ? 12 : opts.cycles,
      obs_frac: opts.obs_frac == null ? 0.5 : opts.obs_frac,
      inflation: opts.inflation == null ? 1.06 : opts.inflation,
      obs_error: opts.obs_error == null ? 0.5 : opts.obs_error,
    });
  }

  transport(opts = {}) {
    return this.run('tracer_transport', {
      grid: opts.grid == null ? 48 : opts.grid,
      steps: opts.steps == null ? 240 : opts.steps,
      shear: opts.shear == null ? 1.0 : opts.shear,
      diffusivity: opts.diffusivity == null ? 0.01 : opts.diffusivity,
    });
  }

  dispersion(opts = {}) {
    return this.run('dispersion_montecarlo', {
      members: opts.members == null ? 512 : opts.members,
      steps: opts.steps == null ? 120 : opts.steps,
      turbulence: opts.turbulence == null ? 0.045 : opts.turbulence,
      shear: opts.shear == null ? 0.6 : opts.shear,
    });
  }

  precisionStudy(opts = {}) {
    return this.run('precision_study', {
      members: opts.members == null ? 32 : opts.members,
      lead_days: opts.lead_days == null ? 6 : opts.lead_days,
    });
  }

  conservation(opts = {}) {
    return this.run('conservation_audit', {
      grid: opts.grid == null ? 48 : opts.grid,
      steps: opts.steps == null ? 2000 : opts.steps,
    });
  }

  benchmark(opts = {}) {
    return this.run('benchmark_suite', {
      precision: opts.precision || 'adaptive',
      resolution: opts.resolution || 'operational',
    });
  }

  /** Offline fallback used by the CLI when the app is not running. */
  core() {
    if (!this._core) {
      const device = new (require(path.join(ROOT, 'core/device.js')).VirtualACPUD1)();
      const formulas = require(path.join(ROOT, 'core/formulas.js'));
      this._core = { device, formulas };
    }
    return this._core;
  }
}

export default ACPUDevice;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ALIASES = {
  lead: 'lead_days',
  leads: 'leads',
  cycles: 'cycles',
  members: 'members',
  steps: 'steps',
  grid: 'grid',
  precision: 'precision',
  days: 'days',
  inflation: 'inflation',
  obs_frac: 'obs_frac',
  obs_error: 'obs_error',
  shear: 'shear',
  diffusivity: 'diffusivity',
  turbulence: 'turbulence',
  kahan: 'kahan',
  resolution: 'resolution',
};

function parseArgv(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) { args[key] = true; continue; }
      const num = Number(next);
      args[key] = Number.isFinite(num) && next.trim() !== '' ? num : next;
      i += 1;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fmtFlops(t) {
  if (t >= 1) return `${t.toFixed(2)} TFLOPS`;
  const f = t * 1e12;
  if (f >= 1e9) return `${(f / 1e9).toFixed(2)} GFLOPS`;
  if (f >= 1e6) return `${(f / 1e6).toFixed(1)} MFLOPS`;
  return `${(f / 1e3).toFixed(0)} kFLOPS`;
}

function fmtMetrics(m) {
  return [
    `  time       ${m.timeS} s`,
    `  energy     ${m.energyJ >= 1000 ? `${(m.energyJ / 1000).toFixed(2)} kJ` : `${m.energyJ.toFixed(2)} J`}`,
    `  power      ${m.powerW} W`,
    `  throughput ${fmtFlops(m.tflops)}`,
    `  peak Tj    ${m.peakTj} °C`,
  ].join('\n');
}

async function cli() {
  const argv = parseArgv(process.argv.slice(2));
  const action = argv._[0] || 'status';
  const json = !!argv.json;
  const dev = new ACPUDevice({ url: process.env.ACPU_URL || undefined, port: process.env.ACPU_PORT || undefined });

  if (action === 'status') {
    const st = await dev.status();
    if (json) { console.log(JSON.stringify(st, null, 2)); return; }
    console.log(`ACPU Studio · ${st.device}`);
    console.log(`  service   ${st.service && st.service.url ? st.service.url : 'offline (using core modules)'}`);
    console.log(`  tiles     ${st.tiles} (${st.clusters} clusters)`);
    console.log(`  clock     ${st.clockGHz} GHz`);
    console.log(`  power     ${st.powerW} W`);
    console.log(`  junction  ${st.junctionC} °C`);
    console.log(`  runs      ${st.runs} · ${st.energyJ} J total`);
    return;
  }

  if (action === 'formulas') {
    const list = await dev.formulas();
    if (json) { console.log(JSON.stringify(list, null, 2)); return; }
    for (const f of list) console.log(`${f.callName.padEnd(20)} ${f.name} — ${f.description.split('.')[0]}.`);
    return;
  }

  const params = {};
  for (const [k, v] of Object.entries(argv)) {
    if (k === '_' || k === 'json') continue;
    params[ALIASES[k] || k] = v;
  }
  const alias = { forecast: 'ensemble_forecast', lyapunov: 'lyapunov_spectrum', assimilate: 'data_assimilation', transport: 'tracer_transport', dispersion: 'dispersion_montecarlo', precision: 'precision_study', conservation: 'conservation_audit', benchmark: 'benchmark_suite' };

  let result;
  try {
    result = await dev.run(alias[action] || action, params);
  } catch (err) {
    if (err instanceof ACPUServiceError && err.code === 'service_unavailable') {
      // offline: run the core modules in-process
      const { formulas, device } = dev.core();
      result = formulas.runFormula(alias[action] || action, params, { device, seed: 20261102 });
      console.log('(offline: ACPU Studio is not running, executed against core/formulas.js)');
    } else {
      throw err;
    }
  }

  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`${result.name} · ${result.call}`);
  console.log(result.summary);
  console.log(fmtMetrics(result.metrics));
  if (action === 'benchmark' && result.tables && result.tables[0]) {
    console.log('');
    const t = result.tables[0];
    console.log(t.rows.map((r) => `${r.id}  ${r.time.padStart(8)}  ${r.energy.padStart(9)}  ${r.tflops.padStart(7)} TF  ${r.power.padStart(7)}  ${r.tj}`).join('\n'));
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  cli().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
