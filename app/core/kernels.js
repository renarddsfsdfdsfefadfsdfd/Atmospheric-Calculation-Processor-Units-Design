'use strict';
/*
 * core/kernels.js — the numerics that actually run behind the panel.
 *
 * Everything here is plain JavaScript with no dependencies: no chart library,
 * no matrix package, and no random draw from the clock. Every routine is a real
 * integrator or estimator, and randomness comes from a seeded PRNG so a run is
 * reproducible.
 *
 * Conventions:
 *   - Lorenz-96: N = 40, F = 8. One model time unit is scaled to 3 forecast
 *     days, so the measured leading exponent (~2.2 / model unit) becomes
 *     ~0.73 /day: an error-doubling time of about 0.95 days, the right order for
 *     synoptic-scale error growth.
 *   - RK4, dt = 0.005 model units = 200 steps per model unit.
 *   - "Precision" is emulated by rounding the state to the target format after
 *     each step, which is what a precision-scaled datapath does to its
 *     accumulators. fp32 uses Math.fround; fp16/bf16/fp8 truncate mantissa bits
 *     of the float32 representation (round-to-nearest, ties ignored).
 */

const { makeWorkload, mulberry32, hashStr } = require('./device');

const STEPS_PER_MODEL_UNIT = 200; // dt = 0.005
const DAY_SCALE = 3.0; // forecast days per model time unit
const L96 = Object.freeze({ N: 40, F: 8, dt: 0.005, stepsPerDay: STEPS_PER_MODEL_UNIT / DAY_SCALE, dayScale: DAY_SCALE });

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function lorenz96Init(N, F, rng, jitter) {
  const x = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    x[i] = F + 1.7 * Math.sin((2 * Math.PI * i) / N) + 0.9 * Math.cos((4 * Math.PI * i) / N) + jitter * gaussian(rng);
  }
  return x;
}

/**
 * Draw an initial state that is actually on the Lorenz-96 attractor.
 * The raw synthetic field sits near x = F, whereas the F = 8 attractor lives
 * near x = 2.3; starting cold would produce a large spin-up transient that
 * dominates (and inflates) every ensemble statistic. Integrating one trajectory
 * for a few thousand steps removes it.
 */
function attractorState(N, F, rng, spinupSteps) {
  const steps = spinupSteps == null ? 3000 : spinupSteps;
  const x = lorenz96Init(N, F, rng, 1.0);
  const scratch = {
    k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N),
    k4: new Float64Array(N), tmp: new Float64Array(N),
  };
  for (let s = 0; s < steps; s += 1) lorenz96Rk4(x, L96.dt, F, scratch, false);
  return x;
}

/** d x_i / dt = (x_{i+1} - x_{i-2}) x_{i-1} - x_i + F */
function lorenz96Deriv(x, F, out, N) {
  for (let i = 0; i < N; i += 1) {
    const im2 = i >= 2 ? x[i - 2] : x[N - 2 + i];
    const im1 = i >= 1 ? x[i - 1] : x[N - 1];
    const ip1 = i + 1 < N ? x[i + 1] : x[i + 1 - N];
    out[i] = (ip1 - im2) * im1 - x[i] + F;
  }
}

/** In-place RK4 step for one state vector. */
function lorenz96Rk4(x, dt, F, scratch, kahan) {
  const N = x.length;
  const { k1, k2, k3, k4, tmp } = scratch;
  lorenz96Deriv(x, F, k1, N);
  for (let i = 0; i < N; i += 1) tmp[i] = x[i] + 0.5 * dt * k1[i];
  lorenz96Deriv(tmp, F, k2, N);
  for (let i = 0; i < N; i += 1) tmp[i] = x[i] + 0.5 * dt * k2[i];
  lorenz96Deriv(tmp, F, k3, N);
  for (let i = 0; i < N; i += 1) tmp[i] = x[i] + dt * k3[i];
  lorenz96Deriv(tmp, F, k4, N);
  if (kahan) {
    for (let i = 0; i < N; i += 1) {
      // Neumaier compensated combination of the four weighted stage derivatives.
      const t1 = (dt / 6) * k1[i];
      const t2 = (dt / 3) * k2[i];
      const t3 = (dt / 3) * k3[i];
      const t4 = (dt / 6) * k4[i];
      let sum = t1;
      let comp = 0;
      let s = sum + t2;
      comp += Math.abs(sum) >= Math.abs(t2) ? sum - s + t2 : t2 - s + sum;
      sum = s;
      s = sum + t3;
      comp += Math.abs(sum) >= Math.abs(t3) ? sum - s + t3 : t3 - s + sum;
      sum = s;
      s = sum + t4;
      comp += Math.abs(sum) >= Math.abs(t4) ? sum - s + t4 : t4 - s + sum;
      x[i] += s + comp;
    }
  } else {
    for (let i = 0; i < N; i += 1) x[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return x;
}

// ---------------------------------------------------------------------------
// Precision emulation
// ---------------------------------------------------------------------------

const _fbuf = new Float32Array(1);
const _ubuf = new Uint32Array(_fbuf.buffer);

const QFMT = {
  fp16: { drop: 13, max: 65504, min: 5.9604644775390625e-8 },
  bf16: { drop: 16, max: 3.3895313892515355e38, min: 1.1754943508222875e-38 },
  fp8: { drop: 20, max: 448, min: 0.001953125 }, // E4M3
};

/** Round one float64 to a low-precision format (deterministic). */
function quantizeOne(v, fmt) {
  if (fmt === 'fp32') return Math.fround(v);
  const cfg = QFMT[fmt];
  if (!cfg) return v;
  if (!Number.isFinite(v) || v === 0) return v;
  const neg = v < 0;
  const a = neg ? -v : v;
  if (a > cfg.max) return neg ? -cfg.max : cfg.max;
  if (a < cfg.min) return neg ? -cfg.min : cfg.min;
  _fbuf[0] = a;
  let m = (_ubuf[0] + (1 << (cfg.drop - 1))) >>> 0;
  m = (m & ((0xffffffff << cfg.drop) >>> 0)) >>> 0;
  if (m > 0x7f800000) m = 0x7f800000;
  _ubuf[0] = m;
  const r = _fbuf[0];
  return neg ? -r : r;
}

/** Round a packed state array to the given format, in place. */
function quantizeState(x, fmt) {
  if (fmt === 'fp64' || !fmt) return x;
  if (fmt === 'fp32') {
    for (let i = 0; i < x.length; i += 1) x[i] = Math.fround(x[i]);
    return x;
  }
  const cfg = QFMT[fmt];
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (v === 0) continue;
    const a = v < 0 ? -v : v;
    if (a > cfg.max) x[i] = v < 0 ? -cfg.max : cfg.max;
    else if (a < cfg.min) x[i] = v < 0 ? -cfg.min : cfg.min;
    else x[i] = quantizeOne(v, fmt);
  }
  return x;
}

/** The hardware governor: drop to fp16 once ensemble spread exceeds threshold. */
function adaptiveMode(spread, threshold = 1.5) {
  return spread > threshold ? 'fp16' : 'fp32';
}

/** Neumaier compensated summation. */
function kahanSum(arr) {
  let sum = 0;
  let comp = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    const s = sum + v;
    comp += Math.abs(sum) >= Math.abs(v) ? sum - s + v : v - s + sum;
    sum = s;
  }
  return sum + comp;
}

// ---------------------------------------------------------------------------
// Tile / cluster mapping helpers
// ---------------------------------------------------------------------------

function clusterWeightsFor(members) {
  const w = new Array(8).fill(0.03);
  for (let c = 0; c < 8; c += 1) {
    const used = Math.max(0, Math.min(members, (c + 1) * 8) - c * 8);
    w[c] = used > 0 ? 0.55 + 0.45 * (used / 8) : 0.03;
  }
  return w;
}

function tileWeightsFor(members) {
  const t = new Array(64).fill(0.02);
  for (let i = 0; i < 64; i += 1) t[i] = i < members ? 0.7 + 0.3 * (1 - i / 64) : 0.02;
  return t;
}

// ---------------------------------------------------------------------------
// Ensemble forecast
// ---------------------------------------------------------------------------

/**
 * Member-by-member Lorenz-96 ensemble forecast.
 * With <= 64 members each member is pinned to one AVT of the chip.
 */
function ensembleForecast(opts = {}) {
  const members = Math.round(opts.members == null ? 64 : opts.members);
  const leadDays = opts.leadDays == null ? 10 : opts.leadDays;
  const precision = opts.precision || 'adaptive';
  const useKahan = !!opts.kahan;
  const seed = opts.seed == null ? 20261102 : opts.seed;
  const N = L96.N;
  const F = L96.F;
  const dt = L96.dt;
  const steps = Math.max(20, Math.round((leadDays * STEPS_PER_MODEL_UNIT) / DAY_SCALE));
  const rng = mulberry32((seed ^ hashStr(`ens:${members}:${leadDays}`)) >>> 0);

  const truth = attractorState(N, F, mulberry32((seed * 7 + 11) >>> 0));
  const base = Float64Array.from(truth);
  const state = new Float64Array(members * N);
  for (let m = 0; m < members; m += 1) {
    for (let i = 0; i < N; i += 1) state[m * N + i] = base[i] + 0.12 * gaussian(rng);
  }

  const scratch = { k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N), k4: new Float64Array(N), tmp: new Float64Array(N) };
  const truthScratch = { k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N), k4: new Float64Array(N), tmp: new Float64Array(N) };

  const sampleEvery = Math.max(1, Math.floor(steps / 60));
  const times = [];
  const meanSeries = [];
  const spreadSeries = [];
  const rmseSeries = [];
  const spreadScalar = [];
  const memberTracks = [[], [], [], []];
  const modeSwitches = { count: 0, last: precision === 'adaptive' ? 'fp32' : precision };
  const perMemberError = new Float64Array(members);
  let quantOps = 0;
  let fmtUsed = precision;

  const mean = new Float64Array(N);
  const variance = new Float64Array(N);

  const collect = (step) => {
    mean.fill(0);
    for (let m = 0; m < members; m += 1) {
      const off = m * N;
      for (let i = 0; i < N; i += 1) mean[i] += state[off + i];
    }
    for (let i = 0; i < N; i += 1) mean[i] /= members;
    variance.fill(0);
    for (let m = 0; m < members; m += 1) {
      const off = m * N;
      for (let i = 0; i < N; i += 1) {
        const d = state[off + i] - mean[i];
        variance[i] += d * d;
      }
    }
    for (let i = 0; i < N; i += 1) variance[i] = Math.sqrt(variance[i] / members);
    let se = 0;
    let err = 0;
    for (let i = 0; i < N; i += 1) {
      se += variance[i] * variance[i];
      const d = mean[i] - truth[i];
      err += d * d;
    }
    times.push(step * dt * DAY_SCALE);
    meanSeries.push(Array.from(mean));
    spreadSeries.push(Array.from(variance));
    rmseSeries.push(Math.sqrt(err / N));
    spreadScalar.push(Math.sqrt(se / N));
    for (let k = 0; k < 4; k += 1) memberTracks[k].push(k < members ? state[k * N] : 0);
    return Math.sqrt(se / N);
  };

  collect(0);
  for (let s = 1; s <= steps; s += 1) {
    for (let m = 0; m < members; m += 1) {
      const off = m * N;
      const view = state.subarray(off, off + N);
      lorenz96Rk4(view, dt, F, scratch, useKahan);
      if (precision === 'adaptive') {
        const fmt = adaptiveMode(spreadScalar[spreadScalar.length - 1]);
        if (fmt !== modeSwitches.last) {
          modeSwitches.count += 1;
          modeSwitches.last = fmt;
        }
        fmtUsed = fmt;
        quantizeState(view, fmt);
        quantOps += N;
      } else if (precision === 'fp32') {
        quantizeState(view, 'fp32');
        quantOps += N;
      } else if (precision !== 'fp64') {
        quantizeState(view, precision);
        quantOps += N;
      }
    }
    lorenz96Rk4(truth, dt, F, truthScratch, false);
    if (s % sampleEvery === 0 || s === steps) collect(s);
  }

  let finalRmse = 0;
  for (let m = 0; m < members; m += 1) {
    let e = 0;
    for (let i = 0; i < N; i += 1) {
      const d = state[m * N + i] - truth[i];
      e += d * d;
    }
    perMemberError[m] = Math.sqrt(e / N);
  }
  {
    let e2 = 0;
    for (let i = 0; i < N; i += 1) {
      const d = mean[i] - truth[i];
      e2 += d * d;
    }
    finalRmse = Math.sqrt(e2 / N);
  }

  const derivOps = 4 * N * 6 + 3 * N * 2 + N * 5;
  const flops = members * steps * derivOps + quantOps * 12;
  const deviceWork = makeWorkload({
    id: `ensemble:${members}:${leadDays}:${precision}`,
    label: `L96 ensemble · ${members} members · ${leadDays} d`,
    kind: 'forecast',
    ops: {
      fp32: precision === 'fp8' ? 0 : precision === 'fp32' || precision === 'fp64' ? flops : flops * 0.55,
      fp16: precision === 'fp8' ? 0 : precision === 'fp32' || precision === 'fp64' ? 0 : flops * 0.45,
      fp8: precision === 'fp8' ? flops : 0,
      sfu: members * steps * 12,
    },
    traffic: {
      sram: members * steps * N * 8 * 24,
      l2: members * steps * N * 8 * 3,
      l3: members * steps * N * 8 * 0.8,
      hbm: members * steps * N * 8 * 0.06,
      noc: members * steps * N * 8 * 1.2,
    },
    steps,
    stages: 4,
    clusterWeights: clusterWeightsFor(members),
    tileWeights: tileWeightsFor(members),
    laneOccupancy: N / 256,
    precision,
  });

  return {
    kind: 'ensemble_forecast',
    members,
    leadDays,
    steps,
    dt,
    dayScale: DAY_SCALE,
    precision,
    precisionUsed: fmtUsed,
    kahan: useKahan,
    times,
    mean: meanSeries,
    spread: spreadSeries,
    rmse: rmseSeries,
    spreadRms: spreadScalar,
    truth: Array.from(truth),
    meanFinal: Array.from(mean),
    spreadFinal: Array.from(variance),
    memberError: Array.from(perMemberError),
    memberTracks,
    finalRmse,
    modeSwitches,
    deviceWork,
    numerics: { flops, derivs: members * steps * 4, quantOps },
  };
}

// ---------------------------------------------------------------------------
// Lyapunov spectrum (tangent-linear + Gram-Schmidt QR)
// ---------------------------------------------------------------------------

/** (J(x) v)_i using the closed form of the Lorenz-96 Jacobian. */
function jacVec(x, v, out, N) {
  for (let i = 0; i < N; i += 1) {
    const im2 = i >= 2 ? i - 2 : N - 2 + i;
    const im1 = i >= 1 ? i - 1 : N - 1;
    const ip1 = i + 1 < N ? i + 1 : i + 1 - N;
    out[i] = (x[ip1] - x[im2]) * v[im1] + x[im1] * (v[ip1] - v[im2]) - v[i];
  }
}

function ftleSpectrum(opts = {}) {
  const leads = Math.round(opts.leads == null ? 12 : opts.leads);
  const days = opts.days == null ? 15 : opts.days;
  const seed = opts.seed == null ? 20261102 : opts.seed;
  const N = L96.N;
  const F = L96.F;
  const dt = L96.dt;
  const steps = Math.max(120, Math.round((days * STEPS_PER_MODEL_UNIT) / DAY_SCALE));
  const rng = mulberry32((seed ^ hashStr(`ftle:${leads}:${days}`)) >>> 0);

  const x = attractorState(N, F, rng);
  const Q = new Float64Array(leads * N);
  for (let k = 0; k < leads; k += 1) {
    let norm = 0;
    for (let i = 0; i < N; i += 1) {
      const v = gaussian(rng);
      Q[k * N + i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < N; i += 1) Q[k * N + i] /= norm;
  }

  const sums = new Float64Array(leads);
  const growth = [];
  const sampleEvery = Math.max(1, Math.floor(steps / 40));
  const st = {
    xa: new Float64Array(N), xb: new Float64Array(N), xc: new Float64Array(N), xn: new Float64Array(N),
    k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N), k4: new Float64Array(N),
    jv: new Float64Array(N), va: new Float64Array(N), vb: new Float64Array(N), vc: new Float64Array(N), vn: new Float64Array(N),
  };

  const snapshot = (step) => {
    const tDays = Math.max(1e-9, step * dt * DAY_SCALE);
    growth.push(Array.from(sums, (v) => v / tDays));
  };

  for (let s = 1; s <= steps; s += 1) {
    const { xa, xb, xc, xn, k1, k2, k3, k4, jv, va, vb, vc, vn } = st;
    lorenz96Deriv(x, F, k1, N);
    for (let i = 0; i < N; i += 1) xa[i] = x[i] + 0.5 * dt * k1[i];
    lorenz96Deriv(xa, F, k2, N);
    for (let i = 0; i < N; i += 1) xb[i] = x[i] + 0.5 * dt * k2[i];
    lorenz96Deriv(xb, F, k3, N);
    for (let i = 0; i < N; i += 1) xc[i] = x[i] + dt * k3[i];
    lorenz96Deriv(xc, F, k4, N);
    for (let i = 0; i < N; i += 1) xn[i] = x[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);

    // Tangent-linear RK4: V' = V + dt/6 (K1 + 2K2 + 2K3 + K4). Each K is
    // consumed immediately, so one scratch vector per stage is enough.
    for (let k = 0; k < leads; k += 1) {
      const off = k * N;
      const v = Q.subarray(off, off + N);
      jacVec(x, v, jv, N);
      for (let i = 0; i < N; i += 1) { va[i] = v[i] + 0.5 * dt * jv[i]; vn[i] = (dt / 6) * jv[i]; }
      jacVec(xa, va, jv, N);
      for (let i = 0; i < N; i += 1) { vb[i] = v[i] + 0.5 * dt * jv[i]; vn[i] += (dt / 3) * jv[i]; }
      jacVec(xb, vb, jv, N);
      for (let i = 0; i < N; i += 1) { vc[i] = v[i] + dt * jv[i]; vn[i] += (dt / 3) * jv[i]; }
      jacVec(xc, vc, jv, N);
      for (let i = 0; i < N; i += 1) v[i] = v[i] + vn[i] + (dt / 6) * jv[i];
    }
    x.set(xn);

    // Modified Gram-Schmidt, accumulating the log growth of each direction.
    for (let k = 0; k < leads; k += 1) {
      for (let j = 0; j < k; j += 1) {
        let proj = 0;
        for (let i = 0; i < N; i += 1) proj += Q[k * N + i] * Q[j * N + i];
        for (let i = 0; i < N; i += 1) Q[k * N + i] -= proj * Q[j * N + i];
      }
      let norm = 0;
      for (let i = 0; i < N; i += 1) norm += Q[k * N + i] * Q[k * N + i];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-300)) norm = 1e-300;
      for (let i = 0; i < N; i += 1) Q[k * N + i] /= norm;
      sums[k] += Math.log(norm);
    }
    if (s % sampleEvery === 0) snapshot(s);
  }

  const T = steps * dt * DAY_SCALE; // forecast days
  const exps = Array.from(sums, (v) => v / T);
  const sorted = Float64Array.from(exps).sort().reverse();
  let cumulative = 0;
  let ky = 0;
  for (let k = 0; k < sorted.length; k += 1) {
    if (cumulative + sorted[k] > 0) { cumulative += sorted[k]; ky += 1; } else break;
  }
  let kyFrac = 0;
  if (ky > 0 && ky < sorted.length && sorted[ky] !== 0) kyFrac = cumulative / Math.abs(sorted[ky]);

  const flops = steps * (4 * N * 6 + leads * N * 12 + leads * leads * N * 0.5);
  const deviceWork = makeWorkload({
    id: `ftle:${leads}:${days}`,
    label: `FTLE spectrum · ${leads} exponents · ${days} d`,
    kind: 'chaos',
    ops: { fp32: flops * 0.7, fp16: flops * 0.3, sfu: steps * leads * 40 },
    traffic: { sram: steps * leads * N * 8 * 20, l2: steps * leads * N * 8 * 2, l3: steps * leads * N * 8 * 0.4, hbm: steps * N * 8 * 0.05, noc: steps * leads * N * 8 * 0.6 },
    steps,
    stages: 4,
    clusterWeights: [0.92, 0.08, 0.04, 0.04, 0.03, 0.03, 0.03, 0.03],
    tileWeights: new Array(64).fill(0.03),
    laneOccupancy: (leads * N) / 16384,
    precision: 'fp32',
  });

  return {
    kind: 'lyapunov_spectrum',
    leads,
    days,
    steps,
    T,
    spectrum: exps,
    spectrumSorted: Array.from(sorted),
    growth,
    growthSampleEvery: sampleEvery,
    stepDays: dt * DAY_SCALE,
    kaplanYorke: ky + kyFrac,
    sum: exps.reduce((a, b) => a + b, 0),
    doublingDays: exps[0] > 0 ? Math.LN2 / exps[0] : Infinity,
    deviceWork,
    numerics: { flops },
  };
}

// ---------------------------------------------------------------------------
// EnKF data assimilation
// ---------------------------------------------------------------------------

/** Solve A x = b for a small dense system (Gaussian elimination with pivoting). */
function solveDense(A, b, n) {
  const M = A.map((row) => Float64Array.from(row));
  const y = Float64Array.from(b);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; const tb = y[c]; y[c] = y[piv]; y[piv] = tb; }
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r += 1) {
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k += 1) M[r][k] -= f * M[c][k];
      y[r] -= f * y[c];
    }
  }
  const out = new Float64Array(n);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = y[r];
    for (let k = r + 1; k < n; k += 1) s -= M[r][k] * out[k];
    out[r] = s / (M[r][r] || 1e-12);
  }
  return out;
}

function enkfAssimilation(opts = {}) {
  const members = Math.round(opts.members == null ? 32 : opts.members);
  const cycles = Math.round(opts.cycles == null ? 12 : opts.cycles);
  const obsFrac = opts.obsFrac == null ? 0.5 : opts.obsFrac;
  const inflation = opts.inflation == null ? 1.06 : opts.inflation;
  const obsError = opts.obsError == null ? 0.5 : opts.obsError;
  const seed = opts.seed == null ? 20261102 : opts.seed;
  const N = L96.N;
  const F = L96.F;
  const dt = L96.dt;
  const stepsPerCycle = 40; // 0.2 forecast days between analyses
  const nobs = Math.max(4, Math.round(N * obsFrac));
  const obsIdx = [];
  for (let k = 0; k < nobs; k += 1) obsIdx.push(Math.round((k * N) / nobs) % N);
  const rng = mulberry32((seed ^ hashStr(`enkf:${members}:${cycles}:${obsFrac}`)) >>> 0);

  const truth = attractorState(N, F, mulberry32((seed * 31 + 3) >>> 0));
  const ens = new Float64Array(members * N);
  for (let m = 0; m < members; m += 1) {
    for (let i = 0; i < N; i += 1) ens[m * N + i] = truth[i] + 0.5 * gaussian(rng);
  }
  const scratch = { k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N), k4: new Float64Array(N), tmp: new Float64Array(N) };
  const truthScratch = { k1: new Float64Array(N), k2: new Float64Array(N), k3: new Float64Array(N), k4: new Float64Array(N), tmp: new Float64Array(N) };

  const forecastRmse = [];
  const analysisRmse = [];
  const spreadSeries = [];
  const innovationMean = [];
  const innovationStd = [];
  const cycleDays = [];
  const ensembleMean = new Float64Array(N);
  const anom = new Float64Array(members * N);
  let innovationAbs = 0;
  let innovationCount = 0;

  for (let c = 0; c < cycles; c += 1) {
    for (let s = 0; s < stepsPerCycle; s += 1) {
      for (let m = 0; m < members; m += 1) {
        const off = m * N;
        lorenz96Rk4(ens.subarray(off, off + N), dt, F, scratch, false);
      }
      lorenz96Rk4(truth, dt, F, truthScratch, false);
    }
    ensembleMean.fill(0);
    for (let m = 0; m < members; m += 1) for (let i = 0; i < N; i += 1) ensembleMean[i] += ens[m * N + i] / members;
    let ferr = 0;
    for (let i = 0; i < N; i += 1) ferr += (ensembleMean[i] - truth[i]) ** 2;
    forecastRmse.push(Math.sqrt(ferr / N));
    for (let m = 0; m < members; m += 1) for (let i = 0; i < N; i += 1) anom[m * N + i] = ens[m * N + i] - ensembleMean[i];
    let spr = 0;
    for (let i = 0; i < N; i += 1) {
      let v = 0;
      for (let m = 0; m < members; m += 1) v += anom[m * N + i] ** 2;
      spr += v / (members - 1);
    }
    spreadSeries.push(Math.sqrt(spr / N));
    cycleDays.push((c + 1) * stepsPerCycle * dt * DAY_SCALE);

    const obs = new Float64Array(nobs);
    for (let k = 0; k < nobs; k += 1) obs[k] = truth[obsIdx[k]] + obsError * gaussian(rng);

    // Observation-space covariance H P H^T + R
    const A = [];
    for (let a = 0; a < nobs; a += 1) {
      const row = new Array(nobs).fill(0);
      for (let b = 0; b < nobs; b += 1) {
        let s = 0;
        for (let m = 0; m < members; m += 1) s += anom[m * N + obsIdx[a]] * anom[m * N + obsIdx[b]];
        row[b] = s / (members - 1) + (a === b ? obsError * obsError : 0);
      }
      A.push(row);
    }
    const innov = new Float64Array(nobs);
    for (let k = 0; k < nobs; k += 1) innov[k] = obs[k] - ensembleMean[obsIdx[k]];
    let im = 0;
    let iabs = 0;
    for (let k = 0; k < nobs; k += 1) { im += innov[k]; iabs += Math.abs(innov[k]); }
    im /= nobs;
    let iv = 0;
    for (let k = 0; k < nobs; k += 1) iv += (innov[k] - im) ** 2;
    innovationMean.push(im);
    innovationStd.push(Math.sqrt(iv / (nobs - 1)));
    innovationAbs += iabs;
    innovationCount += nobs;

    const Kgain = new Float64Array(N * nobs);
    for (let i = 0; i < N; i += 1) {
      for (let k = 0; k < nobs; k += 1) {
        let s = 0;
        for (let m = 0; m < members; m += 1) s += anom[m * N + i] * anom[m * N + obsIdx[k]];
        Kgain[i * nobs + k] = s / (members - 1);
      }
    }
    // Stochastic EnKF: x_a^m = x_f^m + K (y + eps^m - H x_f^m), K = P H^T R~^-1.
    // Kgain already holds P H^T, so each member's residual is whitened by a
    // solve against R~ = H P H^T + R before it is mapped to state space.
    const infl = Math.sqrt(inflation);
    const pert = new Float64Array(nobs);
    const resid = new Float64Array(nobs);
    for (let m = 0; m < members; m += 1) {
      for (let k = 0; k < nobs; k += 1) pert[k] = obsError * gaussian(rng);
      for (let k = 0; k < nobs; k += 1) resid[k] = innov[k] + pert[k] - infl * anom[m * N + obsIdx[k]];
      const z = solveDense(A, resid, nobs);
      for (let i = 0; i < N; i += 1) {
        let acc = 0;
        for (let k = 0; k < nobs; k += 1) acc += Kgain[i * nobs + k] * z[k];
        ens[m * N + i] = ensembleMean[i] + infl * anom[m * N + i] + acc;
      }
    }
    ensembleMean.fill(0);
    for (let m = 0; m < members; m += 1) for (let i = 0; i < N; i += 1) ensembleMean[i] += ens[m * N + i] / members;
    let aerr = 0;
    for (let i = 0; i < N; i += 1) aerr += (ensembleMean[i] - truth[i]) ** 2;
    analysisRmse.push(Math.sqrt(aerr / N));
  }

  const flops = cycles * members * stepsPerCycle * (4 * N * 6 + 3 * N * 2 + N * 5)
    + cycles * (members * nobs * N * 6 + nobs * nobs * nobs * 2 + members * N * nobs * 2);
  const deviceWork = makeWorkload({
    id: `enkf:${members}:${cycles}`,
    label: `Cycled EnKF · ${members} members · ${cycles} cycles`,
    kind: 'assimilation',
    ops: { fp32: flops * 0.6, fp16: flops * 0.4, sfu: cycles * nobs * N * 0.5 },
    traffic: { sram: cycles * members * N * 8 * 40, l2: cycles * members * N * 8 * 4, l3: cycles * nobs * N * 8 * 2, hbm: cycles * nobs * 8 * 2, noc: cycles * members * nobs * 8 * 1.5 },
    steps: cycles * stepsPerCycle,
    stages: 4,
    clusterWeights: clusterWeightsFor(members),
    tileWeights: tileWeightsFor(members),
    laneOccupancy: 0.35,
    precision: 'fp32',
  });

  return {
    kind: 'data_assimilation',
    members,
    cycles,
    obsFrac,
    nobs,
    inflation,
    obsError,
    cycleDays,
    forecastRmse,
    analysisRmse,
    spread: spreadSeries,
    innovationMean,
    innovationStd,
    innovationAbsMean: innovationAbs / Math.max(1, innovationCount),
    meanForecastRmse: forecastRmse.reduce((a, b) => a + b, 0) / forecastRmse.length,
    meanAnalysisRmse: analysisRmse.reduce((a, b) => a + b, 0) / analysisRmse.length,
    deviceWork,
    numerics: { flops },
  };
}

// ---------------------------------------------------------------------------
// 2-D tracer advection / diffusion
// ---------------------------------------------------------------------------

function tracerTransport(opts = {}) {
  const n = Math.round(opts.grid == null ? 48 : opts.grid);
  const steps = Math.round(opts.steps == null ? 240 : opts.steps);
  const shear = opts.shear == null ? 1.0 : opts.shear;
  const diff = opts.diffusivity == null ? 0.01 : opts.diffusivity;
  const emissions = opts.emission == null ? 1.0 : opts.emission;
  const dt = 0.05;
  const u0 = 1.1;
  const v0 = 0.18;
  const field = new Float64Array(n * n);
  const next = new Float64Array(n * n);
  const massSeries = [];
  const peakSeries = [];
  const centroidX = [];
  const centroidY = [];
  const times = [];
  const srcX = n * 0.3;
  const srcY = n * 0.5;
  let emitted = 0;

  const windU = (y) => u0 + shear * 1.2 * ((y - n / 2) / n) * 2;
  const windV = (x) => v0 * Math.sin((2 * Math.PI * x) / n) * 0.5;

  const bilinear = (arr, x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const g = (xx, yy) => {
      let xi = xx % n;
      let yi = yy % n;
      if (xi < 0) xi += n;
      if (yi < 0) yi += n;
      return arr[yi * n + xi];
    };
    const a = g(x0, y0);
    const b = g(x0 + 1, y0);
    const c = g(x0, y0 + 1);
    const d = g(x0 + 1, y0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  const stats = (arr) => {
    let mass = 0;
    let peak = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const v = arr[y * n + x];
        mass += v;
        if (v > peak) peak = v;
        sx += v * x;
        sy += v * y;
      }
    }
    return { mass, peak, cx: mass > 0 ? sx / mass : 0, cy: mass > 0 ? sy / mass : 0 };
  };

  const inject = (t) => {
    const ramp = t < 20 ? 0.35 + (0.65 * t) / 20 : 1;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const d2 = (x - srcX) ** 2 + (y - srcY) ** 2;
        if (d2 > 9) continue;
        const add = emissions * 0.9 * ramp * Math.exp(-d2 / 1.6);
        field[y * n + x] += add;
        emitted += add;
      }
    }
  };

  inject(0);
  const s0 = stats(field);
  const mass0 = s0.mass;
  massSeries.push(s0.mass);
  peakSeries.push(s0.peak);
  centroidX.push(s0.cx);
  centroidY.push(s0.cy);
  times.push(0);

  for (let s = 1; s <= steps; s += 1) {
    for (let y = 0; y < n; y += 1) {
      const uy = windU(y);
      for (let x = 0; x < n; x += 1) {
        const vy = windV(x);
        next[y * n + x] = bilinear(field, x - uy * dt, y - vy * dt);
      }
    }
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const c = next[y * n + x];
        const l = next[y * n + ((x + n - 1) % n)];
        const r = next[y * n + ((x + 1) % n)];
        const u = next[((y + n - 1) % n) * n + x];
        const d = next[((y + 1) % n) * n + x];
        field[y * n + x] = c + diff * dt * (l + r + u + d - 4 * c);
      }
    }
    inject(s);
    if (s % Math.max(1, Math.floor(steps / 60)) === 0 || s === steps) {
      const st = stats(field);
      massSeries.push(st.mass);
      peakSeries.push(st.peak);
      centroidX.push(st.cx);
      centroidY.push(st.cy);
      times.push(s * dt * DAY_SCALE);
    }
  }

  const final = stats(field);
  const grid = [];
  for (let y = 0; y < n; y += 1) grid.push(Array.from(field.subarray(y * n, y * n + n)));

  const flops = steps * n * n * 32;
  const deviceWork = makeWorkload({
    id: `tracer:${n}:${steps}`,
    label: `Tracer transport · ${n}x${n} · ${steps} steps`,
    kind: 'transport',
    ops: { fp32: flops, fp16: 0, sfu: steps * n * n * 0.5 },
    traffic: { sram: steps * n * n * 8 * 10, l2: steps * n * n * 8 * 3.2, l3: steps * n * n * 8 * 0.5, hbm: steps * n * n * 8 * 0.08, noc: steps * n * n * 8 * 1.4 },
    steps,
    stages: 2,
    clusterWeights: [0.55, 0.5, 0.45, 0.45, 0.4, 0.4, 0.35, 0.3],
    tileWeights: new Array(64).fill(0.3),
    laneOccupancy: 0.45,
    precision: 'fp32',
  });

  return {
    kind: 'tracer_transport',
    n,
    steps,
    shear,
    diffusivity: diff,
    grid,
    mass: massSeries,
    peak: peakSeries,
    centroidX,
    centroidY,
    times,
    mass0,
    emitted,
    massBalance: emitted > 0 ? (final.mass - emitted) / emitted : 0,
    peakFinal: final.peak,
    source: { x: srcX, y: srcY },
    deviceWork,
    numerics: { flops },
  };
}

// ---------------------------------------------------------------------------
// Precision study
// ---------------------------------------------------------------------------

function horizonOf(times, rmse, target) {
  for (let i = 0; i < rmse.length; i += 1) if (rmse[i] >= target) return times[i];
  return times[times.length - 1];
}

function precisionStudy(opts = {}) {
  const members = Math.round(opts.members == null ? 32 : opts.members);
  const leadDays = opts.leadDays == null ? 6 : opts.leadDays;
  const modes = ['fp32', 'fp16', 'bf16', 'fp8', 'adaptive'];
  const runs = [];
  for (const mode of modes) {
    const r = ensembleForecast({ members, leadDays, precision: mode, kahan: false, seed: 20261102 });
    runs.push({
      mode,
      label: mode,
      rmse: r.finalRmse,
      rmseSeries: r.rmse,
      spreadSeries: r.spreadRms,
      times: r.times,
      horizon: horizonOf(r.times, r.rmse, 1.0),
      modeSwitches: r.modeSwitches.count,
      flops: r.numerics.flops,
      deviceWork: r.deviceWork,
    });
  }
  return { kind: 'precision_study', members, leadDays, modes, runs };
}

// ---------------------------------------------------------------------------
// Monte-Carlo dispersion
// ---------------------------------------------------------------------------

function monteCarloDispersion(opts = {}) {
  const members = Math.round(opts.members == null ? 512 : opts.members);
  const steps = Math.round(opts.steps == null ? 120 : opts.steps);
  const turb = opts.turbulence == null ? 0.045 : opts.turbulence;
  const shear = opts.shear == null ? 0.6 : opts.shear;
  const seed = opts.seed == null ? 20261102 : opts.seed;
  const dt = 0.05;
  const rng = mulberry32((seed ^ hashStr(`mc:${members}:${steps}:${turb}`)) >>> 0);
  const x = new Float64Array(members);
  const y = new Float64Array(members);
  for (let m = 0; m < members; m += 1) {
    x[m] = 0.5 + 0.004 * gaussian(rng);
    y[m] = 0.5 + 0.004 * gaussian(rng);
  }
  const px = [5, 25, 50, 75, 95];
  const bands = px.map(() => []);
  const stdSeries = [];
  const meanX = [];
  const times = [];
  const sampleEvery = Math.max(1, Math.floor(steps / 40));
  const xs = new Float64Array(members);

  for (let s = 0; s <= steps; s += 1) {
    if (s > 0) {
      for (let m = 0; m < members; m += 1) {
        const u = shear * (y[m] - 0.5) + 0.05;
        x[m] += u * dt + turb * Math.sqrt(dt) * gaussian(rng);
        y[m] += turb * 0.6 * Math.sqrt(dt) * gaussian(rng);
      }
    }
    if (s % sampleEvery === 0 || s === steps) {
      for (let m = 0; m < members; m += 1) xs[m] = x[m];
      const sorted = Float64Array.from(xs).sort();
      for (let k = 0; k < px.length; k += 1) {
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((px[k] / 100) * (sorted.length - 1))));
        bands[k].push(sorted[idx]);
      }
      let mean = 0;
      for (let m = 0; m < members; m += 1) mean += x[m];
      mean /= members;
      let v = 0;
      for (let m = 0; m < members; m += 1) v += (x[m] - mean) ** 2;
      stdSeries.push(Math.sqrt(v / members));
      meanX.push(mean);
      times.push(s * dt * DAY_SCALE);
    }
  }

  // Probability density of the final particle cloud (32 x 32 bins).
  const H = 32;
  const density = new Float64Array(H * H);
  const xmin = 0.2;
  const xspan = 0.9;
  const ymin = 0.2;
  const yspan = 0.6;
  for (let m = 0; m < members; m += 1) {
    const gx = Math.min(H - 1, Math.max(0, Math.floor(((x[m] - xmin) / xspan) * H)));
    const gy = Math.min(H - 1, Math.max(0, Math.floor(((y[m] - ymin) / yspan) * H)));
    density[gy * H + gx] += 1;
  }
  let dmax = 0;
  for (let i = 0; i < density.length; i += 1) if (density[i] > dmax) dmax = density[i];

  const flops = steps * members * 22;
  const deviceWork = makeWorkload({
    id: `mc:${members}:${steps}`,
    label: `Monte-Carlo dispersion · ${members} particles`,
    kind: 'stochastic',
    ops: { fp32: flops * 0.5, fp16: flops * 0.5, sfu: steps * members * 3 },
    traffic: { sram: steps * members * 8 * 8, l2: steps * members * 8 * 1.2, l3: steps * members * 8 * 0.2, hbm: steps * members * 8 * 0.02, noc: steps * members * 8 * 0.5 },
    steps,
    stages: 1,
    clusterWeights: [0.62, 0.6, 0.55, 0.5, 0.5, 0.45, 0.4, 0.4],
    tileWeights: new Array(64).fill(0.42),
    laneOccupancy: 0.6,
    precision: 'mixed',
  });

  return {
    kind: 'dispersion_montecarlo',
    members,
    steps,
    turbulence: turb,
    shear,
    times,
    bands,
    percentiles: px,
    std: stdSeries,
    meanX,
    density,
    densityBounds: { xmin, xspan, ymin, yspan, n: H },
    densityMax: dmax,
    finalMean: meanX[meanX.length - 1],
    finalStd: stdSeries[stdSeries.length - 1],
    deviceWork,
    numerics: { flops },
  };
}

// ---------------------------------------------------------------------------
// Conservation audit
// ---------------------------------------------------------------------------

function conservationAudit(opts = {}) {
  const n = Math.round(opts.grid == null ? 48 : opts.grid);
  const steps = Math.round(opts.steps == null ? 2000 : opts.steps);
  const modes = ['fp64', 'fp32', 'fp32+kahan'];
  const dt = 0.02;
  const u = 0.7;
  const results = [];

  for (const mode of modes) {
    // Double-buffered conservative (flux-form) upwind advection. Reading the
    // previous time level is what makes the scheme mass conserving in exact
    // arithmetic, so whatever drift appears is pure round-off — which is what
    // this audit measures.
    let cur = new Float64Array(n * n);
    let nxt = new Float64Array(n * n);
    const comp = new Float64Array(n * n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const dx = x - n / 2;
        const dy = y - n / 2;
        cur[y * n + x] = 1 + 0.8 * Math.exp(-(dx * dx + dy * dy) / 60);
      }
    }
    const drift = [];
    const sampleEvery = Math.max(1, Math.floor(steps / 60));
    const m0 = kahanSum(cur);
    for (let s = 1; s <= steps; s += 1) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const i = y * n + x;
          const left = cur[y * n + ((x + n - 1) % n)];
          const c = cur[i];
          const flux = u * dt * (c - left);
          let nv;
          if (mode === 'fp64') {
            nv = c - flux;
          } else if (mode === 'fp32') {
            nv = Math.fround(c - flux);
          } else {
            // fp32 increment, compensated running sum (state stays wide).
            const delta = Math.fround(-flux);
            const yv = delta - comp[i];
            const t = c + yv;
            comp[i] = t - c - yv;
            nv = t;
          }
          nxt[i] = nv;
        }
      }
      const swap = cur; cur = nxt; nxt = swap;
      if (s % sampleEvery === 0 || s === steps) drift.push((kahanSum(cur) - m0) / m0);
    }
    results.push({
      mode,
      drift,
      finalDrift: (kahanSum(cur) - m0) / m0,
      mass: kahanSum(cur),
      mass0: m0,
      steps,
      sampleEvery,
    });
  }

  const maxDrift = Math.max(...results.map((r) => Math.abs(r.finalDrift)));
  const flops = modes.length * steps * n * n * 8;
  const deviceWork = makeWorkload({
    id: `conservation:${n}:${steps}`,
    label: `Conservation audit · ${steps} steps · ${n}x${n}`,
    kind: 'audit',
    ops: { fp32: flops * 0.7, fp16: 0, sfu: 0 },
    traffic: { sram: steps * n * n * 8 * 12, l2: steps * n * n * 8 * 3, l3: steps * n * n * 8 * 0.2, hbm: steps * n * n * 8 * 0.04, noc: steps * n * n * 8 * 1.0 },
    steps: steps * modes.length,
    stages: 1,
    clusterWeights: [0.7, 0.65, 0.6, 0.6, 0.55, 0.5, 0.5, 0.45],
    tileWeights: new Array(64).fill(0.4),
    laneOccupancy: 0.5,
    precision: 'fp32',
  });

  return {
    kind: 'conservation_audit',
    n,
    steps,
    modes,
    results,
    maxDrift,
    deviceWork,
    numerics: { flops },
  };
}

module.exports = {
  L96,
  DAY_SCALE,
  gaussian,
  lorenz96Init,
  attractorState,
  lorenz96Deriv,
  lorenz96Rk4,
  quantizeOne,
  quantizeState,
  adaptiveMode,
  kahanSum,
  ensembleForecast,
  ftleSpectrum,
  enkfAssimilation,
  tracerTransport,
  precisionStudy,
  monteCarloDispersion,
  conservationAudit,
  clusterWeightsFor,
  tileWeightsFor,
};
