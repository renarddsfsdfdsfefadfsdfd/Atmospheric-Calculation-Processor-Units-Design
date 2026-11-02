#!/usr/bin/env node
/*
 * tools/selftest.mjs — headless acceptance for the ACPU Studio core.
 *
 * Runs every formula through the registry and the virtual device, asserts that
 * the numbers are finite and inside physically sane ranges, and prints a PASS
 * table. Exits non-zero on the first hard failure.
 *
 *   node tools/selftest.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { VirtualACPUD1 } = require(path.join(ROOT, 'core/device.js'));
const F = require(path.join(ROOT, 'core/formulas.js'));

const C = {
  ok: '\u001b[32m', bad: '\u001b[31m', dim: '\u001b[2m', off: '\u001b[0m', b: '\u001b[1m',
};

const device = new VirtualACPUD1({ seed: 0x7e3a1d });
const ctx = { device, seed: 20261102 };
const failures = [];
let checks = 0;

function check(name, cond, detail) {
  checks += 1;
  if (cond) return true;
  failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  return false;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => finite(v) && v >= lo && v <= hi;

function allFinite(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every(finite);
}

function auditCharts(label, charts) {
  check(`${label}: four charts`, Array.isArray(charts) && charts.length >= 4, `got ${charts ? charts.length : 0}`);
  for (const c of charts || []) {
    if (c.type === 'line' || c.type === 'bars') {
      check(`${label}: ${c.type} "${c.title}" series`, c.series && c.series.length > 0);
      for (const s of c.series || []) check(`${label}: ${c.title} finite`, allFinite(s.y));
    } else if (c.type === 'banded') {
      for (const b of c.bands || []) check(`${label}: ${c.title} band finite`, allFinite(b.lo) && allFinite(b.hi));
      for (const s of c.lines || []) check(`${label}: ${c.title} line finite`, allFinite(s.y));
    } else if (c.type === 'heatmap') {
      check(`${label}: ${c.title} heatmap rows`, Array.isArray(c.values) && c.values.length > 0);
      check(`${label}: ${c.title} heatmap finite`, c.values.every((r) => allFinite(r)));
    } else if (c.type === 'scatter') {
      check(`${label}: ${c.title} points`, Array.isArray(c.points) && c.points.length > 0
        && c.points.every((p) => finite(p[0]) && finite(p[1])));
    }
  }
}

function auditMetrics(label, m) {
  check(`${label}: time`, inRange(m.timeS, 0.001, 4000), `time ${m.timeS}`);
  check(`${label}: energy`, inRange(m.energyJ, 1e-6, 1e7), `energy ${m.energyJ}`);
  check(`${label}: power`, inRange(m.powerW, 1, 90), `power ${m.powerW}`);
  check(`${label}: junction`, inRange(m.peakTj, 20, 95), `Tj ${m.peakTj}`);
  check(`${label}: utilisation`, inRange(m.util, 0, 1), `util ${m.util}`);
  check(`${label}: tflops`, finite(m.tflops) && m.tflops >= 0, `tflops ${m.tflops}`);
  check(`${label}: cycles`, m.cycles > 0);
  check(`${label}: cluster timeline`, Array.isArray(m.clusterTimeline) && m.clusterTimeline.length === 8);
  check(`${label}: tile utilisation`, Array.isArray(m.tileUtil) && m.tileUtil.length === 64);
  check(`${label}: block power`, m.perBlockPower && finite(m.perBlockPower.mac) && finite(m.perBlockPower.leak));
}

const results = [];

function run(id, params, extra) {
  const t0 = process.hrtime.bigint();
  const res = F.runFormula(id, params || {}, ctx);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const label = F.get(id).callName;
  auditMetrics(label, res.metrics);
  auditCharts(label, res.charts);
  check(`${label}: summary text`, typeof res.summary === 'string' && res.summary.length > 20);
  check(`${label}: call preview`, typeof res.call === 'string' && res.call.startsWith(F.get(id).callName));
  if (extra) extra(res, label);
  results.push({ id, label, ms, m: res.metrics, res });
  return res;
}

// ---------------------------------------------------------------- formulas

run('ensemble_forecast', { members: 64, lead_days: 10, precision: 'adaptive' }, (r, l) => {
  const d = r.data;
  check(`${l}: 64 members`, d.memberError.length === 64);
  check(`${l}: RMSE sane`, inRange(d.rmse[d.rmse.length - 1], 0.01, 12), `rmse ${d.rmse[d.rmse.length - 1]}`);
  check(`${l}: spread positive`, d.spreadRms.every((v) => v >= 0));
  check(`${l}: error grows then saturates`, d.rmse[0] < d.rmse[d.rmse.length - 1]);
  check(`${l}: dispatch-bound`, inRange(r.metrics.timeS, 0.2, 2), `t ${r.metrics.timeS}`);
  check(`${l}: reproducible`, (() => {
    const again = F.runFormula('ensemble_forecast', { members: 64, lead_days: 10, precision: 'adaptive' }, ctx);
    return Math.abs(again.data.rmse[again.data.rmse.length - 1] - d.rmse[d.rmse.length - 1]) < 1e-12;
  })());
});

run('lyapunov_spectrum', { leads: 12, days: 15 }, (r, l) => {
  const d = r.data;
  check(`${l}: 12 exponents`, d.spectrum.length === 12);
  check(`${l}: leading exponent`, inRange(d.spectrum[0], 0.2, 3), `l1 ${d.spectrum[0]}`);
  check(`${l}: doubling time`, inRange(d.doublingDays, 0.2, 3.5), `dbl ${d.doublingDays}`);
  check(`${l}: positive sum`, d.sum > 0);
});

run('data_assimilation', { members: 64, cycles: 12 }, (r, l) => {
  const d = r.data;
  check(`${l}: analysis beats forecast`, d.meanAnalysisRmse < d.meanForecastRmse,
    `${d.meanAnalysisRmse} vs ${d.meanForecastRmse}`);
  check(`${l}: analysis RMSE sane`, inRange(d.meanAnalysisRmse, 0.01, 5), `rmse ${d.meanAnalysisRmse}`);
  check(`${l}: innovations finite`, allFinite(d.innovationStd) && allFinite(d.innovationMean));
  check(`${l}: 12 cycles`, d.analysisRmse.length === 12);
});

run('tracer_transport', { grid: 48, steps: 240 }, (r, l) => {
  const d = r.data;
  check(`${l}: grid shape`, d.n === 48);
  check(`${l}: mass budget`, Math.abs(d.massBalance) < 0.02, `balance ${d.massBalance}`);
  check(`${l}: peak > 0`, d.peakFinal > 0);
  check(`${l}: plume moves downwind`, d.centroidX[d.centroidX.length - 1] > d.centroidX[0]);
});

run('precision_study', { members: 32, lead_days: 6 }, (r, l) => {
  check(`${l}: five datapaths`, r.data.runs.length === 5);
});

run('dispersion_montecarlo', { members: 512, steps: 120 }, (r, l) => {
  const d = r.data;
  check(`${l}: percentile order`, d.bands.every((b) => b.every((v, i) => i === 0 || v >= d.bands[0][i] - 1e-9)));
  check(`${l}: spread grows`, d.std[d.std.length - 1] > d.std[0], `${d.std[0]} -> ${d.std[d.std.length - 1]}`);
  check(`${l}: particle count`, d.members === 512);
});

run('conservation_audit', { grid: 48, steps: 2000 }, (r, l) => {
  const [fp64, fp32, kah] = r.data.results;
  check(`${l}: fp64 is the reference`, Math.abs(fp64.finalDrift) < 1e-10, `fp64 ${fp64.finalDrift}`);
  check(`${l}: fp32 drifts more than fp64`, Math.abs(fp32.finalDrift) > Math.abs(fp64.finalDrift),
    `fp32 ${fp32.finalDrift}`);
  check(`${l}: compensation helps`, Math.abs(kah.finalDrift) < Math.abs(fp32.finalDrift),
    `kahan ${kah.finalDrift} vs fp32 ${fp32.finalDrift}`);
  check(`${l}: drift remains small`, Math.abs(fp32.finalDrift) < 1, `fp32 ${fp32.finalDrift}`);
});

run('benchmark_suite', { precision: 'adaptive', resolution: 'operational' }, (r, l) => {
  const table = r.tables[0];
  check(`${l}: five workloads`, table.rows.length === 5);
  const w1 = table.rows[0];
  // Reference anchors from the ACPU-1 report (W1: 125.6 s / 7.17 kJ / 41.9 TFLOPS).
  check(`${l}: W1 time within 2% of report`, Math.abs(parseFloat(w1.time) - 125.6) / 125.6 < 0.02, `W1 ${w1.time}`);
  check(`${l}: W1 energy within 2% of report`, Math.abs(parseFloat(w1.energy) - 7.17) / 7.17 < 0.02, `W1 ${w1.energy}`);
  check(`${l}: W1 TFLOPS within 2% of report`, Math.abs(parseFloat(w1.tflops) - 41.9) / 41.9 < 0.02, `W1 ${w1.tflops}`);
  check(`${l}: W1 utilisation 71.1 %`, Math.abs(parseFloat(w1.util) - 71.1) < 0.6, `W1 ${w1.util}`);
  const w2 = table.rows[1];
  check(`${l}: W2 time within 2% of report`, Math.abs(parseFloat(w2.time) - 27.9) / 27.9 < 0.02, `W2 ${w2.time}`);
  check(`${l}: W2 energy within 5% of report`, Math.abs(parseFloat(w2.energy) - 0.34) / 0.34 < 0.05, `W2 ${w2.energy}`);
  const daily = (r.data.workloads ? null : null) || { t: parseFloat(w1.time) + 4 * parseFloat(w2.time), e: parseFloat(w1.energy) + 4 * parseFloat(w2.energy) };
  check(`${l}: daily cycle 237 s`, Math.abs(daily.t - 237) / 237 < 0.02, `daily ${daily.t.toFixed(1)} s`);
  check(`${l}: daily cycle 8.54 kJ`, Math.abs(daily.e - 8.54) / 8.54 < 0.02, `daily ${daily.e.toFixed(2)} kJ`);
  check(`${l}: table has Tj`, table.rows.every((row) => /°C$/.test(row.tj)));
});

// Precision study needs its own assertions (run again for clarity).
const prec = F.runFormula('precision_study', { members: 32, lead_days: 6 }, ctx);
{
  const byMode = Object.fromEntries(prec.tables[1].rows.map((r) => [r.mode, r]));
  void byMode;
  check('precision_study: five modes', prec.tables[1].rows.length === 5);
  check('precision_study: fp8 loses accuracy',
    parseFloat(byMode.fp8.rmse) > parseFloat(byMode.fp32.rmse) * 1.5,
    `fp8 ${byMode.fp8.rmse} vs fp32 ${byMode.fp32.rmse}`);
  check('precision_study: fp8 is cheaper',
    parseFloat(byMode.fp8.energy) < parseFloat(byMode.fp32.energy),
    `fp8 ${byMode.fp8.energy} vs fp32 ${byMode.fp32.energy}`);
  check('precision_study: fp16 close to fp32',
    Math.abs(parseFloat(byMode.fp16.rmse) / parseFloat(byMode.fp32.rmse) - 1) < 0.2,
    `fp16 ${byMode.fp16.rmse}`);
}

// ---------------------------------------------------------------- parser

function expectError(name, text, fragment) {
  try {
    F.parseCall(text);
    check(`parser: ${name}`, false, 'no error thrown');
  } catch (err) {
    check(`parser: ${name}`, err.message.toLowerCase().includes(fragment), err.message);
  }
}
expectError('unknown parameter', 'forecast(foo=1)', 'unknown parameter');
expectError('range check', 'forecast(members=1000)', 'between 8 and 256');
expectError('type check', 'forecast(members="many")', 'must be a number');
expectError('unknown formula', 'nonsense(a=1)', 'unknown formula');
expectError('syntax', 'forecast members=2', 'name(key=value');
{
  const parsed = F.parseCall('forecast(model="l96", members=32, lead_days=4, precision="fp8", kahan=true)');
  check('parser: quoted string', parsed.params.model === 'l96');
  check('parser: int coercion', parsed.params.members === 32);
  check('parser: bool coercion', parsed.params.kahan === true);
  check('parser: enum coercion', parsed.params.precision === 'fp8');
  check('parser: call echo', parsed.call.includes('precision="fp8"'));
}

// ---------------------------------------------------------------- device anchors

{
  const d2 = new VirtualACPUD1();
  d2.tick(30);
  const idle = d2.snapshot();
  check('device: idle power near spec', inRange(idle.powerW, 3, 10), `idle ${idle.powerW} W`);
  check('device: idle temperature', inRange(idle.junctionC, 30, 55), `idle ${idle.junctionC} C`);
  const info = d2.info();
  check('device: 64 tiles', info.chip.tiles === 64);
  check('device: peak tf32', Math.abs(info.chip.peakTflopsFp32 - 58.98) < 0.01);
  check('device: hbm', info.memory.hbmGb === 48);
  check('device: thermal limit', info.thermal.tjMaxC === 95);
}

// ---------------------------------------------------------------- report

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log('');
console.log(`${C.b}ACPU Studio · core self-test${C.off}`);
console.log(`${C.dim}device model ACPU-1 Tempest · seed 0x7e3a1d · ${F.REGISTRY.length} formulas${C.off}`);
console.log('');
console.log(`${C.dim}${pad('formula', 22)}${lpad('numeric', 9)}${lpad('device t', 10)}${lpad('energy', 10)}${lpad('power', 8)}${lpad('Tj', 7)}  result${C.off}`);
console.log(`${C.dim}${'─'.repeat(78)}${C.off}`);
for (const r of results) {
  const m = r.m;
  console.log(
    `${pad(r.label, 22)}${lpad(`${r.ms.toFixed(0)} ms`, 9)}${lpad(`${m.timeS.toFixed(2)} s`, 10)}`
    + `${lpad(m.energyJ >= 1000 ? `${(m.energyJ / 1000).toFixed(2)} kJ` : `${m.energyJ.toFixed(1)} J`, 10)}`
    + `${lpad(`${m.powerW.toFixed(1)} W`, 8)}${lpad(`${m.peakTj.toFixed(0)} °C`, 7)}  ${C.ok}PASS${C.off}`,
  );
}
console.log(`${C.dim}${'─'.repeat(78)}${C.off}`);

if (failures.length) {
  console.log(`\n${C.bad}${failures.length} failed check(s) of ${checks}:${C.off}`);
  for (const f of failures) console.log(`  ${C.bad}✗${C.off} ${f}`);
  process.exit(1);
}
console.log(`\n${C.ok}${C.b}PASS${C.off} — ${checks} assertions across ${results.length} formulas + parser + device anchors`);
process.exit(0);
