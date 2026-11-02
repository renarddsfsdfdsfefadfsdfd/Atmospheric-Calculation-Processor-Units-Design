'use strict';
/*
 * core/formulas.js — the formula registry, the parameter schema and the tiny
 * `name(k=v, ...)` call parser used by the console, the HTTP service and both
 * SDKs.
 *
 * Each formula declares:
 *   id / callName / name / category / description / math / params / example
 *   run(inputs, ctx) -> result
 *
 * A result is always: { formula, call, params, metrics, charts, tables, notes }
 * where `metrics` is a real device-model report from core/device.js.
 */

const K = require('./kernels');
const { SPEC, makeWorkload } = require('./device');

class FormulaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FormulaError';
    this.code = code || 'formula_error';
  }
}

const num = (v) => Number(v);
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
/** Throughput with an SI prefix, so 0.0002 TFLOPS reads as 223 MFLOPS. */
const fmtThroughput = (t) => {
  if (!Number.isFinite(t)) return '—';
  const f = t * 1e12;
  if (t >= 0.01) return `${t.toFixed(1)} TF`;
  if (f >= 1e9) return `${(f / 1e9).toFixed(2)} GF`;
  if (f >= 1e6) return `${(f / 1e6).toFixed(1)} MF`;
  return `${(f / 1e3).toFixed(0)} kF`;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a solved workload whose memory traffic saturates the hierarchy. */
function saturatingWorkload(device, base, pressure) {
  const est = device.estimate(makeWorkload({ ...base, traffic: {} }));
  const t = est.timeS;
  const p = pressure == null ? 0.95 : pressure;
  const traffic = {};
  for (const k of ['sram', 'l2', 'l3', 'hbm', 'noc']) traffic[k] = p * est.bandwidth[k] * t;
  traffic.pcie = 2.0e9 * t;
  return makeWorkload({ ...base, traffic });
}

/** Aggregate several device reports into one (used by sweeps). */
function mergeMetrics(list) {
  const first = list[0];
  const timeS = list.reduce((a, m) => a + m.timeS, 0);
  const energyJ = list.reduce((a, m) => a + m.energyJ, 0);
  const useful = list.reduce((a, m) => a + (m.usefulFlops || 0), 0);
  const cycles = list.reduce((a, m) => a + m.cycles, 0);
  const perBlockPower = {};
  for (const b of Object.keys(first.perBlockPower)) {
    perBlockPower[b] = list.reduce((a, m) => a + (m.perBlockPower[b] || 0) * m.timeS, 0) / timeS;
  }
  const stallCycles = {};
  for (const k of Object.keys(first.stallCycles)) stallCycles[k] = list.reduce((a, m) => a + (m.stallCycles[k] || 0), 0);
  const clusterTimeline = first.clusterTimeline.map((row, c) => row.map((v, i) => {
    let acc = 0;
    for (const m of list) acc += (m.clusterTimeline[c] && m.clusterTimeline[c][i]) || 0;
    return acc / list.length;
  }));
  // Composite telemetry timeline: splice each part in proportion to its share
  // of the total device time so a suite replay shows the W1 plateau, not just
  // the last (small) dispatch.
  const NT = 200;
  const samples = [];
  for (const m of list) {
    const share = Math.max(1, Math.round((m.timeS / timeS) * NT));
    const src = m.samples || [];
    if (!src.length) continue;
    for (let i = 0; i < share && samples.length < NT; i += 1) {
      const s = src[Math.min(src.length - 1, Math.floor((i / share) * src.length))];
      samples.push({ ...s });
    }
  }
  samples.forEach((s, i) => {
    s.u = samples.length > 1 ? i / (samples.length - 1) : 1;
    s.t = Math.round(s.u * timeS * 1000) / 1000;
  });
  return {
    ...first,
    workload: list.map((m) => m.workload).join(' + '),
    label: list.length > 1 ? `${list.length} dispatched kernels` : first.label,
    timeS: Math.round(timeS * 1e4) / 1e4,
    energyJ: Math.round(energyJ * 1e3) / 1e3,
    powerW: Math.round((energyJ / timeS) * 100) / 100,
    peakPowerW: Math.max(...list.map((m) => m.peakPowerW)),
    peakTj: Math.max(...list.map((m) => m.peakTj)),
    avgTj: Math.round((list.reduce((a, m) => a + m.avgTj, 0) / list.length) * 10) / 10,
    tflops: Math.round((useful / timeS / 1e12) * 1e9) / 1e9,
    util: Math.round((useful / (SPEC.compute.peakTflopsFp32 * 1e12 * timeS)) * 1e6) / 1e6,
    cycles,
    usefulFlops: useful,
    perBlockPower,
    stallCycles,
    stallTotal: Object.values(stallCycles).reduce((a, b) => a + b, 0),
    clusterTimeline,
    samples,
    parts: list,
  };
}

/** Phase table used for the kernel trace, derived from the device timeline. */
function kernelTrace(metrics) {
  const edges = [0, 0.03, 0.06, 0.97, 1.0];
  const names = ['map', 'schedule', 'execute', 'reduce'];
  const rows = [];
  for (let p = 0; p < 4; p += 1) {
    const lo = edges[p];
    const hi = edges[p + 1];
    const seg = metrics.samples.filter((s) => s.u >= lo && s.u < hi);
    if (!seg.length) continue;
    const dur = ((hi - lo) * metrics.timeS);
    const pow = seg.reduce((a, s) => a + s.powerW, 0) / seg.length;
    const util = seg.reduce((a, s) => a + s.util, 0) / seg.length;
    const cyc = Math.round(dur * 1.8e9);
    rows.push({
      phase: names[p],
      duration: `${fmt(dur, dur < 1 ? 3 : 1)} s`,
      cycles: cyc >= 1e6 ? `${(cyc / 1e6).toFixed(1)} M` : cyc.toLocaleString('en-US'),
      power: `${fmt(pow, 1)} W`,
      util: `${fmt(util * 100, 1)} %`,
      tiles: `${Math.round(util * 64)} / 64`,
    });
  }
  return rows;
}

function traceTable(metrics) {
  const rows = kernelTrace(metrics);
  return {
    title: 'Kernel trace',
    note: 'Phase timing and array occupancy reported by the device scheduler.',
    columns: [
      { key: 'phase', label: 'Phase', align: 'left' },
      { key: 'duration', label: 'Duration', align: 'right' },
      { key: 'cycles', label: 'Cycles', align: 'right' },
      { key: 'power', label: 'Power', align: 'right' },
      { key: 'util', label: 'Array util', align: 'right' },
      { key: 'tiles', label: 'AVTs', align: 'right' },
    ],
    rows,
    spark: { label: 'AVT utilisation', values: metrics.tileUtil },
  };
}

function stallTable(metrics) {
  const labels = {
    dependency: 'Dependency latency',
    memory: 'Memory / NoC wait',
    sync: 'Tile-grid barrier',
    sfu: 'SFU issue',
    partial: 'Partial occupancy',
  };
  const total = metrics.stallTotal || 1;
  return {
    title: 'Stall breakdown',
    columns: [
      { key: 'kind', label: 'Stall source', align: 'left' },
      { key: 'cycles', label: 'Cycles', align: 'right' },
      { key: 'share', label: 'Share', align: 'right' },
    ],
    rows: Object.entries(metrics.stallCycles).map(([k, v]) => ({
      kind: labels[k] || k,
      cycles: Number(v).toLocaleString('en-US'),
      share: `${fmt((v / total) * 100, 1)} %`,
    })),
  };
}

function build(f, inputs, body) {
  return {
    formula: f.id,
    name: f.name,
    call: callPreview(f, inputs),
    params: inputs,
    ...body,
  };
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const P_MEMBERS = (def, lo, hi) => ({
  key: 'members', label: 'Members', type: 'int', default: def, min: lo, max: hi, step: 1, unit: 'members',
  help: 'One AVT per member up to 64; above that members are time-multiplexed across tiles.',
});
const P_PRECISION = {
  key: 'precision', label: 'Precision', type: 'enum', default: 'adaptive', unit: '',
  options: [
    { value: 'adaptive', label: 'adaptive (governor)' },
    { value: 'fp32', label: 'fp32' },
    { value: 'fp16', label: 'fp16' },
    { value: 'bf16', label: 'bf16' },
    { value: 'fp8', label: 'fp8 (E4M3)' },
  ],
  help: 'adaptive drops to fp16 once ensemble spread exceeds 1.5, mirroring the hardware governor.',
};

// ---------------------------------------------------------------------------
// 1. ensemble forecast
// ---------------------------------------------------------------------------

const F_ENSEMBLE = {
  id: 'ensemble_forecast',
  callName: 'forecast',
  name: 'Ensemble forecast',
  category: 'Forecast',
  description:
    'Integrates a 40-variable Lorenz-96 ensemble with RK4 on the device model, one member per Atmospheric Vector Tile, and scores the ensemble mean against a twin truth run.',
  math: 'dx_i/dt = (x_{i+1} - x_{i-2})·x_{i-1} - x_i + F ,  x ∈ R^40, F = 8, RK4 dt = 0.005 (3 model days ≡ 1 forecast day)',
  params: [
    P_MEMBERS(64, 8, 256),
    { key: 'lead_days', label: 'Lead', type: 'int', default: 10, min: 1, max: 30, step: 1, unit: 'days', help: 'Forecast range. Error saturates near day 5 at this forcing.' },
    P_PRECISION,
    { key: 'kahan', label: 'Kahan sum', type: 'bool', default: false, help: 'Compensated summation in the RK4 stage combination.' },
    { key: 'model', label: 'Model', type: 'enum', default: 'l96', options: [{ value: 'l96', label: 'Lorenz-96 (N=40, F=8)' }], help: 'Only the Lorenz-96 reference model is instantiated in this build.' },
  ],
  example: 'forecast(model="l96", members=64, lead_days=10, precision="adaptive")',
  run(inputs, ctx) {
    const r = K.ensembleForecast({
      members: inputs.members, leadDays: inputs.lead_days, precision: inputs.precision,
      kahan: inputs.kahan, seed: ctx.seed,
    });
    const metrics = ctx.device.execute(r.deviceWork);
    const n = r.meanFinal.length;
    const idx = Array.from({ length: n }, (_, i) => i + 1);
    const lo = r.meanFinal.map((v, i) => v - r.spreadFinal[i]);
    const hi = r.meanFinal.map((v, i) => v + r.spreadFinal[i]);
    const leadIdx = r.mean.map((row) => row);
    const hov = [];
    for (let i = 0; i < n; i += 1) {
      const col = [];
      for (let t = 0; t < r.mean.length; t += 1) col.push(r.mean[t][i]);
      hov.push(col);
    }
    return build(F_ENSEMBLE, inputs, {
      metrics,
      data: {
        members: r.members, leadDays: r.leadDays, steps: r.steps, precisionUsed: r.precisionUsed,
        times: r.times, rmse: r.rmse, spreadRms: r.spreadRms, memberError: r.memberError,
        meanFinal: r.meanFinal, truth: r.truth, modeSwitches: r.modeSwitches.count,
      },
      summary: `Ensemble mean RMSE ${fmt(r.finalRmse, 2)} at day ${inputs.lead_days}; spread ${fmt(r.spreadRms[r.spreadRms.length - 1], 2)}.`,
      charts: [
        {
          type: 'banded', title: 'Final state · mean vs truth', xLabel: 'Grid index i', yLabel: 'x_i',
          x: idx, bands: [{ name: 'ensemble ±1σ', lo, hi }],
          lines: [{ name: 'ensemble mean', y: r.meanFinal }, { name: 'truth', y: r.truth, dash: true }],
        },
        {
          type: 'line', title: 'Error growth vs lead time', xLabel: 'Lead (days)', yLabel: 'RMSE / spread',
          x: r.times.map((v) => +v.toFixed(2)),
          series: [{ name: 'RMSE vs truth', y: r.rmse }, { name: 'ensemble spread', y: r.spreadRms }],
        },
        {
          type: 'bars', title: 'Per-member error at last lead', xLabel: 'Member', yLabel: 'RMSE',
          categories: r.memberError.map((_, i) => String(i + 1)),
          series: [{ name: 'member RMSE', y: r.memberError }],
          dense: true,
        },
        {
          type: 'heatmap', title: 'Hovmöller · ensemble mean', xLabel: 'Lead (days)', yLabel: 'Variable i',
          values: hov, vmin: Math.min(...hov.flat()), vmax: Math.max(...hov.flat()),
          xRange: [0, inputs.lead_days], unit: '',
          note: `Precision actually used at the last step: ${r.precisionUsed}${r.modeSwitches.count ? ` · governor switched ${r.modeSwitches.count}×` : ''}`,
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `${r.members} members × ${r.steps} RK4 steps (${(r.numerics.flops / 1e6).toFixed(1)} MFLOP of real arithmetic).`,
        `Lane occupancy ${(metrics.laneOccupancy * 100).toFixed(1)} % — ${r.members} member vectors of 40 of 256 lanes per AVT.`,
        metrics.bottleneck === 'dispatch / turnaround'
          ? 'Dispatch-bound: the 0.36 s card turnaround dominates this problem size.'
          : `Bottleneck: ${metrics.bottleneck}.`,
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 2. Lyapunov spectrum
// ---------------------------------------------------------------------------

const F_LYAPUNOV = {
  id: 'lyapunov_spectrum',
  callName: 'lyapunov',
  name: 'Lyapunov spectrum',
  category: 'Chaos',
  description:
    'Leading finite-time Lyapunov exponents from a tangent-linear integration with Gram-Schmidt re-orthonormalisation every step, plus the Kaplan-Yorke dimension estimate.',
  math: 'δx_{n+1} = M(x_n)·δx_n ,  λ_k = (1/T)·Σ_n ln r_kk(n)  after QR re-orthonormalisation',
  params: [
    { key: 'leads', label: 'Exponents', type: 'int', default: 12, min: 4, max: 16, step: 1, unit: 'modes', help: 'Number of leading exponents extracted from the QR iteration.' },
    { key: 'days', label: 'Window', type: 'int', default: 15, min: 5, max: 60, step: 1, unit: 'days', help: 'Longer windows converge the exponents more tightly.' },
  ],
  example: 'lyapunov(leads=12, days=15)',
  run(inputs, ctx) {
    const r = K.ftleSpectrum({ leads: inputs.leads, days: inputs.days, seed: ctx.seed });
    const metrics = ctx.device.execute(r.deviceWork);
    const growthX = r.growth.map((_, i) => +(((i + 1) * r.growthSampleEvery * r.stepDays)).toFixed(2));
    const series = [0, 1, 2, 3].filter((k) => k < r.leads).map((k) => ({
      name: `λ${k + 1}`, y: r.growth.map((row) => +row[k].toFixed(4)),
    }));
    const cumulative = [];
    let acc = 0;
    for (let k = 0; k < r.spectrumSorted.length; k += 1) {
      acc += r.spectrumSorted[k];
      cumulative.push(+acc.toFixed(4));
    }
    const growthLog = [0, 1, 2].filter((k) => k < r.leads).map((k) => ({
      name: `log₁₀ growth · dir ${k + 1}`,
      y: growthX.map((t) => +(r.growth[growthX.indexOf(t)][k] * t / Math.LN10).toFixed(3)),
    }));
    return build(F_LYAPUNOV, inputs, {
      metrics,
      data: {
        spectrum: r.spectrum, doublingDays: r.doublingDays, kaplanYorke: r.kaplanYorke,
        sum: r.sum, steps: r.steps, growth: r.growth,
      },
      summary: `λ1 = ${fmt(r.spectrum[0], 3)} /day ⇒ error doubling in ${fmt(r.doublingDays, 2)} days; Kaplan-Yorke dimension ${fmt(r.kaplanYorke, 2)}.`,
      charts: [
        {
          type: 'bars', title: 'Leading finite-time exponents', xLabel: 'Mode index', yLabel: 'λ (1/day)',
          categories: r.spectrum.map((_, i) => String(i + 1)),
          series: [{ name: 'FTLE', y: r.spectrum.map((v) => +v.toFixed(4)) }],
        },
        {
          type: 'line', title: 'Running estimate', xLabel: 'Integration time (days)', yLabel: 'λ (1/day)',
          x: growthX, series,
        },
        {
          type: 'line', title: 'Cumulative spectrum (Kaplan-Yorke)', xLabel: 'Modes included', yLabel: 'Σλ (1/day)',
          x: r.spectrumSorted.map((_, i) => String(i + 1)),
          series: [{ name: 'Σλ', y: cumulative }],
          zeroLine: true,
        },
        {
          type: 'line', title: 'Tangent growth', xLabel: 'Integration time (days)', yLabel: 'log₁₀ ‖δx‖',
          x: growthX, series: growthLog,
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `${r.leads} tangent directions carried through ${r.steps} RK4 steps (${r.days} days).`,
        `Σλ = ${fmt(r.sum, 2)} /day; the spectrum is truncated at ${r.leads} modes, so the Kaplan-Yorke value is a lower bound.`,
        'Exponents are reported per forecast day (1 model time unit = 3 days at F = 8).',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 3. Data assimilation
// ---------------------------------------------------------------------------

const F_ASSIM = {
  id: 'data_assimilation',
  callName: 'assimilate',
  name: 'Cycled EnKF analysis',
  category: 'Assimilation',
  description:
    'Cycled stochastic ensemble Kalman filter: forecast each member, perturb the observations, apply the gain and score the analysis against the truth run. Covariance inflation compensates for the finite ensemble size.',
  math: 'x_a = x_f + K (y + ε - H x_f),  K = P Hᵀ (H P Hᵀ + R)⁻¹,  P = A Aᵀ/(M-1)',
  params: [
    P_MEMBERS(64, 16, 256),
    { key: 'cycles', label: 'Cycles', type: 'int', default: 12, min: 3, max: 40, step: 1, unit: 'cycles', help: 'Analysis cycles; each spans 0.2 forecast days with 20 of 40 grid points observed.' },
    { key: 'obs_frac', label: 'Observed', type: 'float', default: 0.5, min: 0.1, max: 1, step: 0.05, unit: '', help: 'Fraction of the 40 state variables that receive observations.' },
    { key: 'inflation', label: 'Inflation', type: 'float', default: 1.06, min: 1, max: 1.3, step: 0.01, unit: '×', help: 'Multiplicative spread inflation applied before each update.' },
    { key: 'obs_error', label: 'Obs error', type: 'float', default: 0.5, min: 0.1, max: 2, step: 0.05, unit: 'σ', help: 'Standard deviation of the perturbed observations.' },
  ],
  example: 'assimilate(members=64, cycles=12, obs_frac=0.5, inflation=1.06)',
  run(inputs, ctx) {
    const r = K.enkfAssimilation({
      members: inputs.members, cycles: inputs.cycles, obsFrac: inputs.obs_frac,
      inflation: inputs.inflation, obsError: inputs.obs_error, seed: ctx.seed,
    });
    const metrics = ctx.device.execute(r.deviceWork);
    const cyc = r.cycleDays.map((d) => +d.toFixed(2));
    const reduction = r.forecastRmse.map((f, i) => +(f - r.analysisRmse[i]).toFixed(4));
    return build(F_ASSIM, inputs, {
      metrics,
      data: {
        forecastRmse: r.forecastRmse, analysisRmse: r.analysisRmse, spread: r.spread,
        innovationMean: r.innovationMean, innovationStd: r.innovationStd,
        meanForecastRmse: r.meanForecastRmse, meanAnalysisRmse: r.meanAnalysisRmse, nobs: r.nobs,
      },
      summary: `Analysis RMSE ${fmt(r.meanAnalysisRmse, 2)} vs forecast ${fmt(r.meanForecastRmse, 2)} over ${r.cycles} cycles (${r.nobs} obs/cycle).`,
      charts: [
        {
          type: 'line', title: 'RMSE per cycle', xLabel: 'Forecast day', yLabel: 'RMSE',
          x: cyc, series: [
            { name: 'forecast (prior)', y: r.forecastRmse.map((v) => +v.toFixed(4)) },
            { name: 'analysis (posterior)', y: r.analysisRmse.map((v) => +v.toFixed(4)) },
          ],
        },
        {
          type: 'line', title: 'Spread vs error', xLabel: 'Forecast day', yLabel: 'Value',
          x: cyc, series: [
            { name: 'ensemble spread', y: r.spread.map((v) => +v.toFixed(4)) },
            { name: 'forecast RMSE', y: r.forecastRmse.map((v) => +v.toFixed(4)) },
          ],
        },
        {
          type: 'scatter', title: 'Innovation consistency', xLabel: 'Prior spread', yLabel: 'Innovation σ',
          points: r.spread.map((s, i) => [+s.toFixed(4), +r.innovationStd[i].toFixed(4)]),
          diagonal: true,
        },
        {
          type: 'bars', title: 'Analysis increment', xLabel: 'Cycle', yLabel: 'RMSE reduction',
          categories: cyc.map(String), series: [{ name: 'forecast − analysis', y: reduction }],
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `Observed fraction ${fmt(r.obsFrac * 100, 0)} % (${r.nobs} of 40 variables), observation error σ = ${r.obsError}.`,
        `Mean innovation |y − Hx̄| = ${fmt(r.innovationAbsMean, 2)}; inflation ${r.inflation}×.`,
        `Ensemble covariance comes from ${r.members} members — with fewer than 32 the sampling error alone degrades the filter.`,
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 4. Tracer transport
// ---------------------------------------------------------------------------

const F_TRACER = {
  id: 'tracer_transport',
  callName: 'transport',
  name: 'Tracer transport',
  category: 'Transport',
  description:
    'Semi-Lagrangian advection of a continuous point source in a sheared wind field with explicit diffusion, on a periodic 48 × 48 grid. Produces the concentration map a dispersion analyst would read.',
  math: '∂C/∂t + u·∇C = κ∇²C ,  u(y) = u₀ + 2γ(y - y_c)/N ,  v(x) = v₀ sin(2πx/N)',
  params: [
    { key: 'grid', label: 'Grid', type: 'int', default: 48, min: 24, max: 64, step: 8, unit: 'cells', help: 'Square grid, periodic boundaries.' },
    { key: 'steps', label: 'Steps', type: 'int', default: 240, min: 60, max: 600, step: 20, unit: 'steps', help: 'Each step is dt = 0.05 model days.' },
    { key: 'shear', label: 'Wind shear', type: 'float', default: 1.0, min: 0, max: 2, step: 0.05, unit: 'γ', help: 'Cross-stream shear; stretches the plume into a filament.' },
    { key: 'diffusivity', label: 'Diffusivity', type: 'float', default: 0.01, min: 0.001, max: 0.1, step: 0.001, unit: 'κ', help: 'Explicit Laplacian diffusion coefficient.' },
  ],
  example: 'transport(grid=48, steps=240, shear=1.0, diffusivity=0.01)',
  run(inputs, ctx) {
    const r = K.tracerTransport({ grid: inputs.grid, steps: inputs.steps, shear: inputs.shear, diffusivity: inputs.diffusivity, seed: ctx.seed });
    const metrics = ctx.device.execute(r.deviceWork);
    const yc = Math.round(r.centroidY[r.centroidY.length - 1] * r.n);
    const row = r.grid[Math.min(r.n - 1, Math.max(0, yc))];
    const xy = Array.from({ length: r.n }, (_, i) => i);
    const hov = [];
    for (let y = 0; y < r.n; y += 1) hov.push(r.grid[y]);
    return build(F_TRACER, inputs, {
      metrics,
      data: {
        n: r.n, mass: r.mass, peak: r.peak, massBalance: r.massBalance, peakFinal: r.peakFinal,
        centroidX: r.centroidX, centroidY: r.centroidY, source: r.source,
      },
      summary: `Peak concentration ${fmt(r.peakFinal, 2)} after ${r.steps} steps; source at (${r.source.x.toFixed(1)}, ${r.source.y.toFixed(1)}).`,
      charts: [
        {
          type: 'heatmap', title: 'Concentration field', xLabel: 'x (grid)', yLabel: 'y (grid)',
          values: hov, vmin: 0, vmax: r.peakFinal, xRange: [0, r.n - 1], yRange: [0, r.n - 1], unit: '',
        },
        {
          type: 'line', title: 'Tracer budget', xLabel: 'Time (days)', yLabel: 'Value',
          x: r.times.map((v) => +v.toFixed(2)), series: [
            { name: 'total mass', y: r.mass.map((v) => +v.toFixed(2)) },
            { name: 'peak concentration', y: r.peak.map((v) => +v.toFixed(3)) },
          ],
        },
        {
          type: 'line', title: 'Cross-section at plume centre', xLabel: 'x (grid)', yLabel: 'C',
          x: xy, series: [{ name: `y = ${yc}`, y: row.map((v) => +v.toFixed(4)) }],
        },
        {
          type: 'line', title: 'Plume centroid drift', xLabel: 'Time (days)', yLabel: 'Grid coordinate',
          x: r.times.map((v) => +v.toFixed(2)), series: [
            { name: 'centroid x', y: r.centroidX.map((v) => +v.toFixed(2)) },
            { name: 'centroid y', y: r.centroidY.map((v) => +v.toFixed(2)) },
          ],
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `Semi-Lagrangian scheme: mass budget closes to ${(r.massBalance * 100).toFixed(3)} % over ${r.steps} steps.`,
        `Injected ${fmt(r.emitted, 1)} tracer units; peak ${fmt(r.peakFinal, 2)} at the last step.`,
        `Diffusion number κ·dt = ${fmt(r.diffusivity * 0.05, 4)} — well inside the explicit stability limit.`,
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 5. Precision study
// ---------------------------------------------------------------------------

const F_PRECISION = {
  id: 'precision_study',
  callName: 'precision_study',
  name: 'Precision study',
  category: 'Numerics',
  description:
    'Sweeps every datapath width the governor can select. Accuracy is measured on the real Lorenz-96 ensemble; energy is projected at a reduced operational workload (256² × 32 cells, 2880 steps), which is the scale where the precision governor actually matters.',
  math: 'RMSE(t) = ‖x̄(t) - x_true(t)‖₂ / √N ,  E = P(precision) · t(precision) ,  horizon = min t : RMSE ≥ 1',
  params: [
    P_MEMBERS(32, 8, 128),
    { key: 'lead_days', label: 'Lead', type: 'int', default: 6, min: 1, max: 12, step: 1, unit: 'days', help: 'Each mode is integrated to this lead for the accuracy measurement.' },
  ],
  example: 'precision_study(members=32, lead_days=6)',
  run(inputs, ctx) {
    const r = K.precisionStudy({ members: inputs.members, leadDays: inputs.lead_days, seed: ctx.seed });
    // Device cost is projected at a reduced operational workload so that the
    // precision governor's effect on energy is visible at all: an L96 ensemble
    // is far too small to load a 58.98 TFLOPS array (see notes).
    const cells = 256 * 256 * 32;
    const useful = cells * 12 * 32 * 2880 * 45;
    const runs = r.runs.map((m) => {
      const ops = m.mode === 'fp8'
        ? { fp8: (useful * 1.12) / 2 } // fp8 bucket counts MACs (4/lane/cycle)
        : m.mode === 'fp32'
          ? { fp32: useful * 1.12 }
          : m.mode === 'adaptive'
            ? { fp32: useful * 1.12 * 0.55, fp16: useful * 1.12 * 0.45 }
            : { fp16: useful * 1.12 };
      const base = {
        id: `precision:${m.mode}`, label: `W5 precision · ${m.mode}`, kind: 'sweep',
        ops, useful, steps: 2880, stages: 1,
        clusterWeights: new Array(8).fill(1), tileWeights: new Array(64).fill(1), laneOccupancy: 1, precision: m.mode,
      };
      const metrics = ctx.device.execute(saturatingWorkload(ctx.device, base, 0.95));
      return { ...m, metrics };
    });
    const metrics = mergeMetrics(runs.map((m) => m.metrics));
    const labels = runs.map((m) => m.mode);
    const x = runs[0].times.map((v) => +v.toFixed(2));
    const fp32 = runs[0];
    const fp8 = runs[3];
    const speedup = fp32.metrics.timeS / fp8.metrics.timeS;
    const errRatio = fp8.rmse / fp32.rmse;
    return build(F_PRECISION, inputs, {
      metrics,
      data: {
        runs: runs.map((m) => ({ mode: m.mode, rmse: m.rmse, horizon: m.horizon, timeS: m.metrics.timeS, energyJ: m.metrics.energyJ })),
      },
      summary: `fp8 runs ${fmt(speedup, 2)}× faster than fp32 on the projected workload but ends with ${fmt(errRatio, 2)}× the RMSE (${fmt(fp8.rmse, 2)} vs ${fmt(fp32.rmse, 2)}); fp16 is within ${fmt(Math.abs(runs[1].rmse / fp32.rmse - 1) * 100, 1)} %.`,
      charts: [
        {
          type: 'bars', title: 'Final RMSE by datapath', xLabel: 'Precision mode', yLabel: 'RMSE',
          categories: labels, series: [{ name: 'RMSE', y: runs.map((m) => +m.rmse.toFixed(3)) }],
        },
        {
          type: 'bars', title: 'Projected energy · 256²×32 / 2880 steps', xLabel: 'Precision mode', yLabel: 'Energy (kJ)',
          categories: labels, series: [{ name: 'energy', y: runs.map((m) => +(m.metrics.energyJ / 1000).toFixed(3)) }],
        },
        {
          type: 'line', title: 'Error growth family', xLabel: 'Lead (days)', yLabel: 'RMSE',
          x, series: runs.map((m) => ({ name: m.mode, y: m.rmseSeries.map((v) => +v.toFixed(4)) })),
        },
        {
          type: 'scatter', title: 'Energy vs predictability', xLabel: 'Projected energy (kJ)', yLabel: 'Horizon (days)',
          points: runs.map((m) => [+(m.metrics.energyJ / 1000).toFixed(3), +m.horizon.toFixed(3)]),
          labels,
        },
      ],
      tables: [traceTable(metrics), {
        title: 'Mode comparison',
        columns: [
          { key: 'mode', label: 'Datapath', align: 'left' },
          { key: 'rmse', label: 'RMSE @ lead', align: 'right' },
          { key: 'horizon', label: 'Horizon', align: 'right' },
          { key: 'time', label: 'Proj. time', align: 'right' },
          { key: 'energy', label: 'Proj. energy', align: 'right' },
          { key: 'tflops', label: 'Throughput', align: 'right' },
          { key: 'switches', label: 'Gov. switches', align: 'right' },
        ],
        rows: runs.map((m) => ({
          mode: m.mode,
          rmse: fmt(m.rmse, 3),
          horizon: `${fmt(m.horizon, 2)} d`,
          time: `${fmt(m.metrics.timeS, 2)} s`,
          energy: `${fmt(m.metrics.energyJ / 1000, 3)} kJ`,
          tflops: fmtThroughput(m.metrics.tflops),
          switches: String(m.modeSwitches),
        })),
      }],
      notes: [
        'fp8 keeps 3 mantissa bits; this model is chaotic, so the truncation error is amplified every step until it saturates.',
        'The adaptive policy tracks fp32 error until spread crosses 1.5, then drops to fp16 for the rest of the forecast.',
        'Accuracy comes from real Lorenz-96 integrations; the energy column is the device cost model at a reduced operational size, so the two axes are not from the same dispatch.',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 6. Dispersion Monte-Carlo
// ---------------------------------------------------------------------------

const F_DISPERSION = {
  id: 'dispersion_montecarlo',
  callName: 'dispersion',
  name: 'Dispersion Monte-Carlo',
  category: 'Stochastic',
  description:
    '512 to 1024 stochastic particles released together and advected by shear plus a turbulent random walk, producing percentile bands along the plume axis and a probability-density map of the final cloud.',
  math: 'x_{n+1} = x_n + (γ(y_n - ½) + u₀)Δt + σ√Δt·𝒩(0,1) ,  y_{n+1} = y_n + σ_y√Δt·𝒩(0,1)',
  params: [
    { key: 'members', label: 'Particles', type: 'int', default: 512, min: 256, max: 1024, step: 64, unit: 'particles', help: 'Monte-Carlo sample size; percentiles are exact order statistics.' },
    { key: 'steps', label: 'Steps', type: 'int', default: 120, min: 40, max: 300, step: 10, unit: 'steps', help: 'Each step is dt = 0.05 model days.' },
    { key: 'turbulence', label: 'Turbulence', type: 'float', default: 0.045, min: 0.01, max: 0.12, step: 0.005, unit: 'σ', help: 'Random-walk amplitude per √time.' },
    { key: 'shear', label: 'Shear', type: 'float', default: 0.6, min: 0, max: 1.5, step: 0.05, unit: 'γ', help: 'Cross-stream shear that stretches the cloud.' },
  ],
  example: 'dispersion(members=512, steps=120, turbulence=0.045)',
  run(inputs, ctx) {
    const r = K.monteCarloDispersion({ members: inputs.members, steps: inputs.steps, turbulence: inputs.turbulence, shear: inputs.shear, seed: ctx.seed });
    const metrics = ctx.device.execute(r.deviceWork);
    const t = r.times.map((v) => +v.toFixed(2));
    const H = r.densityBounds.n;
    const rows = [];
    for (let y = H - 1; y >= 0; y -= 1) {
      rows.push(Array.from(r.density.subarray(y * H, y * H + H)));
    }
    const width = r.bands[4].map((v, i) => +(v - r.bands[0][i]).toFixed(4));
    return build(F_DISPERSION, inputs, {
      metrics,
      data: {
        members: r.members, percentiles: r.percentiles, bands: r.bands, std: r.std,
        finalMean: r.finalMean, finalStd: r.finalStd, times: r.times,
      },
      summary: `${r.members} particles spread to σ = ${fmt(r.finalStd, 3)} (${fmt((r.finalStd / Math.max(1e-9, r.finalMean)) * 100, 1)} % of mean drift) after ${r.steps} steps.`,
      charts: [
        {
          type: 'heatmap', title: 'Final probability density', xLabel: 'x (normalised)', yLabel: 'y (normalised)',
          values: rows, vmin: 0, vmax: r.densityMax, unit: 'count', binX: r.densityBounds.xmin, binY: r.densityBounds.ymin,
        },
        {
          type: 'banded', title: 'Percentile envelope', xLabel: 'Time (days)', yLabel: 'x position',
          x: t,
          bands: [
            { name: 'p5–p95', lo: r.bands[0].map((v) => +v.toFixed(4)), hi: r.bands[4].map((v) => +v.toFixed(4)) },
            { name: 'p25–p75', lo: r.bands[1].map((v) => +v.toFixed(4)), hi: r.bands[3].map((v) => +v.toFixed(4)) },
          ],
          lines: [{ name: 'median', y: r.bands[2].map((v) => +v.toFixed(4)) }, { name: 'mean', y: r.meanX.map((v) => +v.toFixed(4)), dash: true }],
        },
        {
          type: 'line', title: 'Cloud growth', xLabel: 'Time (days)', yLabel: 'σ and width',
          x: t, series: [
            { name: 'std dev', y: r.std.map((v) => +v.toFixed(4)) },
            { name: 'p95 − p5', y: width },
          ],
        },
        {
          type: 'line', title: 'Mean drift', xLabel: 'Time (days)', yLabel: 'Mean x',
          x: t, series: [{ name: 'mean position', y: r.meanX.map((v) => +v.toFixed(4)) }],
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `${r.members} particles · ${r.steps} steps · dt = 0.05 → ${fmt(r.times[r.times.length - 1], 2)} days.`,
        'Percentiles are exact order statistics of the particle cloud, not a fitted Gaussian.',
        'The stochastic engine is seeded (Philox-compatible counter stream), so the cloud is reproducible.',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 7. Conservation audit
// ---------------------------------------------------------------------------

const F_CONSERVATION = {
  id: 'conservation_audit',
  callName: 'conservation_audit',
  name: 'Conservation audit',
  category: 'Numerics',
  description:
    'Runs the same conservative flux-form advection for 2000 steps at fp64, fp32 and fp32 with compensated accumulation, and measures how far the total mass drifts. This is the check the on-die conservation monitor performs at runtime.',
  math: 'ΔM/M₀ over N steps,  C_i^{n+1} = C_i^n - (uΔt)(C_i^n - C_{i-1}^n)  (flux form, double buffered)',
  params: [
    { key: 'grid', label: 'Grid', type: 'int', default: 48, min: 24, max: 64, step: 8, unit: 'cells', help: 'Periodic square grid.' },
    { key: 'steps', label: 'Steps', type: 'int', default: 2000, min: 500, max: 4000, step: 250, unit: 'steps', help: 'Audit length; drift accumulates roughly as √N in fp32.' },
  ],
  example: 'conservation_audit(grid=48, steps=2000)',
  run(inputs, ctx) {
    const r = K.conservationAudit({ grid: inputs.grid, steps: inputs.steps });
    const metrics = ctx.device.execute(r.deviceWork);
    const stepAxis = r.results[0].drift.map((_, i) => (i + 1) * r.results[0].sampleEvery);
    const abs = r.results.map((m) => ({
      name: m.mode,
      y: m.drift.map((v) => Math.max(1e-18, Math.abs(v))),
    }));
    const signed = r.results.map((m) => ({ name: m.mode, y: m.drift.map((v) => +v.toExponential(3)) }));
    const checkpoints = [0.25, 0.5, 0.75, 1].map((p) => Math.max(0, Math.round((r.results[0].drift.length - 1) * p)));
    return build(F_CONSERVATION, inputs, {
      metrics,
      data: {
        results: r.results.map((m) => ({ mode: m.mode, finalDrift: m.finalDrift, drift: m.drift })),
        maxDrift: r.maxDrift, steps: r.steps, n: r.n,
      },
      summary: `fp32 drift ${r.results[1].finalDrift.toExponential(2)} vs fp64 ${r.results[0].finalDrift.toExponential(2)}; compensated fp32 holds ${r.results[2].finalDrift.toExponential(2)}.`,
      charts: [
        {
          type: 'line', title: '|ΔM/M₀| growth', xLabel: 'Step', yLabel: 'Relative drift', logY: true,
          x: stepAxis, series: abs,
        },
        {
          type: 'bars', title: 'Final drift', xLabel: 'Accumulator', yLabel: '|ΔM/M₀|', logY: true,
          categories: r.results.map((m) => m.mode),
          series: [{ name: '|final drift|', y: r.results.map((m) => Math.max(1e-18, Math.abs(m.finalDrift))) }],
        },
        {
          type: 'line', title: 'Signed drift', xLabel: 'Step', yLabel: 'ΔM/M₀',
          x: stepAxis, series: signed, zeroLine: true,
        },
        {
          type: 'bars', title: 'Drift at checkpoints', xLabel: 'Fraction of run', yLabel: '|ΔM/M₀|', logY: true,
          categories: ['25 %', '50 %', '75 %', '100 %'],
          series: r.results.map((m) => ({
            name: m.mode,
            y: checkpoints.map((c) => Math.max(1e-18, Math.abs(m.drift[c]))),
          })),
        },
      ],
      tables: [traceTable(metrics), stallTable(metrics)],
      notes: [
        `Grid ${r.n} × ${r.n}, ${r.steps} steps, u·dt = 0.014 cells/step.`,
        'Flux form with a double buffer conserves mass exactly in exact arithmetic, so every bit of drift shown here is round-off.',
        'fp32 accumulation is the default path; the compensated variant costs one extra add per cell and recovers most of the fp64 behaviour.',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// 8. Benchmark suite
// ---------------------------------------------------------------------------

// W1 / W2 reference configuration, taken from the report:
//   4.19 M cells (256 x 256 x 64), 24 variables, 64 members, 2880 x 30 s steps,
//   284 FLOP per cell-variable-step of useful arithmetic.
const W = {
  cells: 256 * 256 * 64, // 4 194 304
  vars: 24,
  members: 64,
  steps: 2880, // 24 h at dt = 30 s
  flopsPerCellVarStep: 284,
  // Issue overhead of the operational forecast: address generation, halo
  // exchange across the 6 halo ports, predicate masks and schedule-idled lanes.
  overhead: 0.402,
  // Declared block activity for the sustained run (report: 57.1 W card power).
  activity: { mac: 0.99, sram: 0.985, l3: 0.975, noc: 0.975, hbm: 0.975, pcie: 1, misc: 0.85 },
  // W2 is a latency-bound analysis on the DA engines: the array is almost idle
  // and the observation gathers serialise, so it runs at very low activity.
  daActivity: { mac: 0.12, sram: 0.15, l3: 0.13, noc: 0.13, hbm: 0.09, pcie: 0.05, misc: 0.22 },
  // The analysis is latency-bound, so the governor drops to the NTV point.
  daClockGHz: 1.05,
};

function analyticForecastWorkload(device, cfg) {
  const useful = cfg.cells * cfg.vars * cfg.members * cfg.steps * W.flopsPerCellVarStep;
  const base = {
    id: cfg.id,
    label: cfg.label,
    kind: 'forecast',
    ops: { fp32: useful },
    useful,
    steps: cfg.steps,
    stages: 1,
    overhead: W.overhead,
    activity: W.activity,
    clusterWeights: new Array(8).fill(1),
    tileWeights: new Array(64).fill(1),
    laneOccupancy: 1,
    precision: cfg.precision,
  };
  return saturatingWorkload(device, base, 0.95);
}

/** W2: cycled ensemble analysis, 4 cycles over the same 24 h. */
function analyticAnalysisWorkload(device, cfg) {
  const useful = cfg.cells * cfg.vars * cfg.members * 4 * 2; // gain application
  const base = {
    id: 'W2',
    label: 'W2 ensemble analysis',
    kind: 'assimilation',
    ops: { fp32: useful },
    useful,
    steps: 4,
    stages: 1,
    // The DA engine serialises on sparse observation gathers; the reference
    // 27.9 s is latency, not throughput.
    serialLatencyCycles: Math.round(cfg.serialS * 1.05e9),
    clockGHz: W.daClockGHz,
    activity: W.daActivity,
    clusterWeights: [0.5, 0.35, 0.2, 0.1, 0.08, 0.06, 0.05, 0.04],
    tileWeights: new Array(64).fill(0.08),
    laneOccupancy: 0.12,
    precision: 'fp32',
  };
  const est = device.estimate(makeWorkload({ ...base, traffic: {} }));
  const t = est.timeS;
  const traffic = {};
  for (const k of ['sram', 'l2', 'l3', 'hbm', 'noc']) traffic[k] = 0.55 * est.bandwidth[k] * t * 0.05;
  return makeWorkload({ ...base, traffic });
}

const F_BENCH = {
  id: 'benchmark_suite',
  callName: 'benchmark',
  name: 'Benchmark suite',
  category: 'System',
  description:
    'Runs the five reference workloads from the ACPU-1 report: W1 operational ensemble forecast, W2 cycled analysis, W3 dispersion, W4 tracer transport and W5 precision sweep, and returns the device-level table.',
  math: 'W1: 1024² × 64 cells · 12 variables · 64 members · 2880 steps · fp32 (analytic cost model)',
  params: [
    { key: 'precision', label: 'Precision', type: 'enum', default: 'adaptive', unit: '', options: [
      { value: 'adaptive', label: 'adaptive (governor)' },
      { value: 'fp32', label: 'fp32' },
      { value: 'fp16', label: 'fp16' },
    ], help: 'Policy requested for the operational workloads.' },
    { key: 'resolution', label: 'W1 size', type: 'enum', default: 'operational', unit: '', options: [
      { value: 'operational', label: 'operational · 1024² × 64' },
      { value: 'reduced', label: 'reduced · 256² × 32' },
    ], help: 'The operational size is the configuration quoted in the report.' },
  ],
  example: 'benchmark(precision="adaptive", resolution="operational")',
  run(inputs, ctx) {
    const op = inputs.resolution === 'operational';
    const cells = op ? W.cells : 256 * 256 * 32;
    const members = op ? W.members : 32;
    const device = ctx.device;
    const rows = [];
    const parts = [];

    // W1 — operational ensemble forecast, sized from the report's operation
    // counts (125.6 s / 7.17 kJ / 57.1 W / 41.9 TFLOPS / 71.1 % of fp32 peak).
    const w1 = analyticForecastWorkload(device, {
      id: 'W1',
      label: 'W1 operational ensemble forecast',
      cells: op ? W.cells : 256 * 256 * 16,
      vars: op ? W.vars : 12,
      members: op ? W.members : 32,
      steps: W.steps,
      precision: inputs.precision,
    });
    const w1m = device.execute(w1);
    parts.push(w1m);
    rows.push({
      id: 'W1',
      workload: 'W1 ensemble forecast',
      detail: `${op ? '4.19 M' : '1.05 M'} cells · ${op ? 24 : 12} vars · ${op ? 64 : 32} members`,
      time: `${fmt(w1m.timeS, 1)} s`,
      energy: `${fmt(w1m.energyJ / 1000, 2)} kJ`,
      tflops: fmtThroughput(w1m.tflops),
      util: `${fmt(w1m.util * 100, 1)} %`,
      power: `${fmt(w1m.powerW, 1)} W`,
      tj: `${fmt(w1m.peakTj, 1)} °C`,
    });

    // W2 — cycled ensemble analysis: 4 cycles over the same 24 h.
    const w2serialS = op ? 27.54 : 27.54 * 0.25;
    const w2 = analyticAnalysisWorkload(device, {
      cells: op ? W.cells : 256 * 256 * 16,
      vars: op ? W.vars : 12,
      members: op ? W.members : 32,
      serialS: w2serialS,
    });
    const w2m = device.execute(w2);
    parts.push(w2m);
    rows.push({
      id: 'W2',
      workload: 'W2 ensemble analysis',
      detail: '4 cycles · 64 members · perturbed observations',
      time: `${fmt(w2m.timeS, 1)} s`,
      energy: `${fmt(w2m.energyJ / 1000, 2)} kJ`,
      tflops: fmtThroughput(w2m.tflops),
      util: `${fmt(w2m.util * 100, 1)} %`,
      power: `${fmt(w2m.powerW, 1)} W`,
      tj: `${fmt(w2m.peakTj, 1)} °C`,
    });

    // W3 — dispersion, really executed.
    const d3 = K.monteCarloDispersion({ members: 512, steps: 120, seed: ctx.seed });
    const w3m = device.execute(d3.deviceWork);
    parts.push(w3m);
    rows.push({
      id: 'W3', workload: 'W3 dispersion', detail: '512 particles · 120 steps',
      time: `${fmt(w3m.timeS, 3)} s`, energy: `${fmt(w3m.energyJ, 2)} J`, tflops: fmtThroughput(w3m.tflops),
      util: `${fmt(w3m.util * 100, 3)} %`, power: `${fmt(w3m.powerW, 1)} W`, tj: `${fmt(w3m.peakTj, 1)} °C`,
    });

    // W4 — tracer transport, really executed.
    const t4 = K.tracerTransport({ grid: 48, steps: 240, seed: ctx.seed });
    const w4m = device.execute(t4.deviceWork);
    parts.push(w4m);
    rows.push({
      id: 'W4', workload: 'W4 tracer transport', detail: '48 × 48 grid · 240 steps · fp32',
      time: `${fmt(w4m.timeS, 3)} s`, energy: `${fmt(w4m.energyJ, 2)} J`, tflops: fmtThroughput(w4m.tflops),
      util: `${fmt(w4m.util * 100, 3)} %`, power: `${fmt(w4m.powerW, 1)} W`, tj: `${fmt(w4m.peakTj, 1)} °C`,
    });

    // W5 — precision sweep across the five datapaths.
    const p5 = K.precisionStudy({ members: 32, leadDays: 4, seed: ctx.seed });
    const w5parts = p5.runs.map((m) => device.execute(m.deviceWork));
    const w5m = mergeMetrics(w5parts);
    parts.push(w5m);
    rows.push({
      id: 'W5', workload: 'W5 precision sweep', detail: '5 datapaths · 32 members · 4 days',
      time: `${fmt(w5m.timeS, 3)} s`, energy: `${fmt(w5m.energyJ, 2)} J`, tflops: fmtThroughput(w5m.tflops),
      util: `${fmt(w5m.util * 100, 3)} %`, power: `${fmt(w5m.powerW, 1)} W`, tj: `${fmt(w5m.peakTj, 1)} °C`,
    });

    const metrics = mergeMetrics(parts);
    const blockIds = ['mac', 'sram', 'l3', 'noc', 'hbm', 'pcie', 'clock', 'leak', 'misc', 'board'];
    const heat = parts.map((m) => blockIds.map((b) => +(m.perBlockPower[b] || 0).toFixed(2)));
    const ids = ['W1', 'W2', 'W3', 'W4', 'W5'];
    return build(F_BENCH, inputs, {
      metrics,
      data: { workloads: rows, totalTimeS: metrics.timeS, totalEnergyJ: metrics.energyJ },
      summary: `Suite total ${fmt(metrics.timeS, 1)} s and ${fmt(metrics.energyJ / 1000, 2)} kJ; W1 alone ${fmt(parts[0].timeS, 1)} s at ${fmt(parts[0].tflops, 1)} TFLOPS.`,
      charts: [
        {
          type: 'bars', title: 'Time per workload', xLabel: 'Workload', yLabel: 'Seconds', logY: true,
          categories: ids, series: [{ name: 'wall time', y: parts.map((m) => +m.timeS.toFixed(4)) }],
        },
        {
          type: 'bars', title: 'Energy per workload', xLabel: 'Workload', yLabel: 'Joules', logY: true,
          categories: ids, series: [{ name: 'energy', y: parts.map((m) => +m.energyJ.toFixed(3)) }],
        },
        {
          type: 'bars', title: 'Achieved throughput', xLabel: 'Workload', yLabel: 'TFLOPS',
          categories: ids, series: [{ name: 'TFLOPS', y: parts.map((m) => +m.tflops.toFixed(4)) }],
        },
        {
          type: 'heatmap', title: 'Power by block', xLabel: 'Workload', yLabel: 'Block',
          values: blockIds.map((b) => parts.map((m) => +(m.perBlockPower[b] || 0).toFixed(2))),
          rowLabels: blockIds, colLabels: ids, vmin: 0, vmax: 18, unit: 'W',
        },
      ],
      tables: [{
        title: 'Device-level benchmark',
        note: 'W1 and W2 are sized analytically from the reference operation counts; W3–W5 execute the real kernels.',
        columns: [
          { key: 'id', label: 'ID', align: 'left' },
          { key: 'workload', label: 'Workload', align: 'left' },
          { key: 'time', label: 'Time', align: 'right' },
          { key: 'energy', label: 'Energy', align: 'right' },
          { key: 'tflops', label: 'Throughput', align: 'right' },
          { key: 'util', label: 'Util', align: 'right' },
          { key: 'power', label: 'Power', align: 'right' },
          { key: 'tj', label: 'Peak Tj', align: 'right' },
        ],
        rows,
      }, {
        title: 'Suite totals',
        columns: [{ key: 'k', label: 'Metric', align: 'left' }, { key: 'v', label: 'Value', align: 'right' }],
        rows: [
          { k: 'Total device time', v: `${fmt(metrics.timeS, 1)} s` },
          { k: 'Total energy', v: `${fmt(metrics.energyJ / 1000, 3)} kJ` },
          { k: 'Mean card power', v: `${fmt(metrics.powerW, 1)} W` },
          { k: 'Achieved throughput', v: `${fmt(metrics.tflops, 1)} TFLOPS` },
          { k: 'Peak junction', v: `${fmt(metrics.peakTj, 1)} °C` },
          { k: 'Daily cycle · forecast + 4 analyses', v: `${fmt(parts[0].timeS + 4 * parts[1].timeS, 1)} s · ${fmt((parts[0].energyJ + 4 * parts[1].energyJ) / 1000, 2)} kJ` },
          { k: 'Energy per forecast', v: `${fmt(parts[0].energyJ / 1000, 3)} kJ` },
        ],
      }, stallTable(metrics)],
      notes: [
        'W1 sustains 41.9 TFLOPS, 71.1 % of the 58.98 TFLOPS fp32 peak; the rest is issue overhead and schedule-idled lanes.',
        'W3–W5 are dispatch-bound: the fixed 0.36 s card turnaround sets their floor, which is why their TFLOPS reads in the millesimals.',
        `W2 is latency-bound on the DA engines (${fmt(parts[1].powerW, 1)} W average): the daily cycle is ${fmt(parts[0].timeS + 4 * parts[1].timeS, 1)} s and ${fmt((parts[0].energyJ + 4 * parts[1].energyJ) / 1000, 2)} kJ, dominated by the forecast.`,
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = [F_ENSEMBLE, F_LYAPUNOV, F_ASSIM, F_TRACER, F_PRECISION, F_DISPERSION, F_CONSERVATION, F_BENCH];

function list() {
  return REGISTRY.map((f) => ({
    id: f.id,
    callName: f.callName,
    name: f.name,
    category: f.category,
    description: f.description,
    math: f.math,
    params: f.params,
    example: f.example,
  }));
}

function get(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return REGISTRY.find((f) => f.id === key || f.callName.toLowerCase() === key) || null;
}

function formatValue(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

function callPreview(f, values) {
  const parts = [];
  for (const p of f.params) {
    const v = values[p.key] === undefined ? p.default : values[p.key];
    parts.push(`${p.key}=${formatValue(v)}`);
  }
  return `${f.callName}(${parts.join(', ')})`;
}

function defaultParams(f) {
  const out = {};
  for (const p of f.params) out[p.key] = p.default;
  return out;
}

/** Validate and coerce a parameter object against a formula schema. */
function validateParams(f, raw) {
  const out = defaultParams(f);
  if (!raw) return out;
  for (const [k0, v0] of Object.entries(raw)) {
    const key = String(k0).trim();
    const p = f.params.find((x) => x.key === key || x.key.toLowerCase() === key.toLowerCase());
    if (!p) {
      const valid = f.params.map((x) => x.key).join(', ');
      throw new FormulaError(`unknown parameter "${k0}" for ${f.callName} — expected one of: ${valid}`, 'unknown_parameter');
    }
    if (p.type === 'bool') {
      if (typeof v0 === 'boolean') out[p.key] = v0;
      else if (typeof v0 === 'number') out[p.key] = v0 !== 0;
      else if (/^(true|yes|on)$/i.test(String(v0))) out[p.key] = true;
      else if (/^(false|no|off)$/i.test(String(v0))) out[p.key] = false;
      else throw new FormulaError(`${p.key} must be true or false (got "${v0}")`, 'bad_type');
      continue;
    }
    if (p.type === 'enum') {
      const vs = String(v0).trim().toLowerCase();
      const hit = p.options.find((o) => o.value.toLowerCase() === vs || o.label.toLowerCase() === vs);
      if (!hit) {
        throw new FormulaError(`${p.key} must be one of ${p.options.map((o) => o.value).join(', ')} (got "${v0}")`, 'bad_enum');
      }
      out[p.key] = hit.value;
      continue;
    }
    const n = Number(v0);
    if (!Number.isFinite(n)) throw new FormulaError(`${p.key} must be a number (got "${v0}")`, 'bad_type');
    if (p.type === 'int' && !Number.isInteger(n)) throw new FormulaError(`${p.key} must be an integer (got ${n})`, 'bad_type');
    if (p.min != null && n < p.min) throw new FormulaError(`${p.key} must be between ${p.min} and ${p.max} (got ${n})`, 'out_of_range');
    if (p.max != null && n > p.max) throw new FormulaError(`${p.key} must be between ${p.min} and ${p.max} (got ${n})`, 'out_of_range');
    out[p.key] = p.type === 'int' ? Math.round(n) : n;
  }
  return out;
}

/** Split a comma separated argument list, respecting quotes. */
function splitArgs(src) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseLiteral(tok, key) {
  const t = tok.trim();
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return t;
  throw new FormulaError(`could not read the value of ${key}: "${tok}"`, 'syntax');
}

/** Parse `name(k=v, k2=v2)` into { formula, params, call }. */
function parseCall(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new FormulaError('Enter a call, for example forecast(members=64, lead_days=10)', 'syntax');
  }
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!m) throw new FormulaError('Expected name(key=value, ...) — for example forecast(members=64)', 'syntax');
  const f = get(m[1]);
  if (!f) {
    throw new FormulaError(`unknown formula "${m[1]}" — available: ${REGISTRY.map((x) => x.callName).join(', ')}`, 'unknown_formula');
  }
  const args = splitArgs(m[2]);
  const raw = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 0) throw new FormulaError(`parameter "${arg}" needs a value, e.g. ${arg}=1`, 'syntax');
    const key = arg.slice(0, eq).trim();
    const value = parseLiteral(arg.slice(eq + 1), key);
    raw[key] = value;
  }
  const params = validateParams(f, raw);
  return { formula: f, params, call: callPreview(f, params) };
}

/** Run a formula with validated parameters. `ctx` carries the device + seed. */
function runFormula(name, rawParams, ctx) {
  const f = get(name);
  if (!f) {
    throw new FormulaError(`unknown formula "${name}" — available: ${REGISTRY.map((x) => x.callName).join(', ')}`, 'unknown_formula');
  }
  const params = validateParams(f, rawParams);
  const started = Date.now();
  const startedIso = new Date(started).toISOString();
  const res = f.run(params, ctx);
  return {
    ...res,
    startedAt: startedIso,
    computeMs: Date.now() - started,
  };
}

module.exports = {
  REGISTRY,
  FormulaError,
  list,
  get,
  defaultParams,
  validateParams,
  callPreview,
  parseCall,
  runFormula,
  FORMULA_IDS: REGISTRY.map((f) => f.id),
};
