'use strict';
/*
 * core/device.js — deterministic virtual ACPU-1 "Tempest".
 *
 * This is a *device model*, not a toy random-number generator. Every number it
 * reports is derived from an explicit cost model over the workload descriptor
 * that a kernel hands it (operation counts, bytes moved, serial steps), using
 * the constants transcribed from acpu/spec/acpu1.json revision 1.0:
 *
 *   compute  8 clusters x 8 AVTs (Atmospheric Vector Tiles) = 64 tiles,
 *            256 lanes/tile, 1.80 GHz nominal (2.10 GHz boost),
 *            1 fp32 FMA / 2 fp16 FMA / 4 fp8 MAC per lane per cycle
 *            => 58.98 TFLOPS fp32, 117.96 TFLOPS fp16, 235.93 TOPS fp8
 *   memory   24 MB L2 (9.6 TB/s), 128 MB L3 (8.0 TB/s),
 *            48 GB HBM3E at 2.4 TB/s, 35.2 TB/s aggregate tile SRAM,
 *            16 Tb/s NoC
 *   power    65 W TDP, 57 W typical, 6 W idle, 78 W peak,
 *            per-block budget 18/7/5/4.5/8/3/2.5/4/3 W
 *   thermal  junction RC: Cj 1.9 J/K, theta_jc 0.18 K/W,
 *            heatsink 62 J/K, theta_hs 0.28 K/W, theta_amb 0.19 K/W,
 *            Tj,max 95 C, Tcase 62 C, Tamb 35 C
 *
 * Two calibration anchors from the spec are enforced by the model:
 *   W1 operational ensemble forecast (24 h, 64 members) ~ 126 s, ~ 7.2 kJ, ~ 57 W
 *   64-member Lorenz-96 10-day ensemble: turnaround-bound, sub-second
 *
 * The model is deliberately deterministic: a run's telemetry is a pure
 * function of (device seed, workload signature). Same run twice => same trace.
 */

const SPEC = Object.freeze({
  chip: {
    name: 'ACPU-1',
    codename: 'Tempest',
    fullName: 'Atmospheric Calculation Processor Unit',
    revision: '1.0',
    class: 'domain-specific atmospheric chaos accelerator',
    interface: 'PCIe 6.0 x16 (CXL 3.0 capable)',
    process: 'N3G nanosheet GAA',
    transistorsG: 28.4,
    dieMm2: 287.6,
    l3Dies: 2,
  },
  compute: {
    clusters: 8,
    tilesPerCluster: 8,
    tiles: 64,
    lanesPerTile: 256,
    lanes: 16384,
    clockGHz: 1.8,
    boostGHz: 2.1,
    ntvGHz: 1.05,
    fmaPerLaneCycle: { fp32: 1, fp16: 2, fp8: 4 },
    sfuPerLane: 0.25,
    peakTflopsFp32: 58.98,
    peakTflopsFp16: 117.96,
    peakTopsFp8: 235.93,
    tileSramKb: 256,
    tileSramBwGbps: 550,
    haloPorts: 6,
    timeLevels: 3,
    maxLiveMembers: 256,
  },
  memory: {
    l2Mb: 24,
    l2PerClusterMb: 3,
    l2Tbs: 9.6,
    l3Mb: 128,
    l3Tbs: 8.0,
    hbmGb: 48,
    hbmTbs: 2.4,
    nocTbs: 16.0,
    sramTbs: 64 * 550e9 / 1e12, // 35.2 TB/s aggregate tile SRAM
  },
  power: {
    tdpW: 65,
    typicalW: 57,
    idleW: 6,
    peakW: 78,
    ntvTdpW: 34,
    // spec budget table (sums to 55 W silicon)
    blocks: [
      { id: 'mac', label: 'MAC arrays', w: 18.0 },
      { id: 'sram', label: 'SRAM + L2', w: 7.0 },
      { id: 'l3', label: 'L3 dies', w: 5.0 },
      { id: 'noc', label: 'NoC', w: 4.5 },
      { id: 'hbm', label: 'HBM PHY', w: 8.0 },
      { id: 'pcie', label: 'PCIe / IO', w: 3.0 },
      { id: 'clock', label: 'Clock + PLL', w: 2.5 },
      { id: 'leak', label: 'Leakage', w: 4.0 },
      { id: 'misc', label: 'Misc / monitors', w: 3.0 },
    ],
    // Fans + board + interposer losses, measured at the card edge.
    boardIdleW: 1.75,
    boardLoadW: 3.4,
    // Idle distribution across the silicon, normalised to the 6 W card idle
    // figure. Blocks rise from these floors to their budgets under load.
    idleBlocks: { mac: 0.35, sram: 0.28, l3: 0.22, noc: 0.18, hbm: 0.26, pcie: 0.30, clock: 1.10, misc: 0.30 },
    energyPj: {
      fp32Fma: 0.42,
      fp16Fma: 0.24,
      fp8Mac: 0.14,
      sfu: 1.1,
      sramWord: 0.3,
      l2Word: 0.55,
      l3Byte: 0.4,
      hbmByte: 16.0,
      nocByte: 0.12,
    },
  },
  thermal: {
    tjMaxC: 95,
    tcaseC: 62,
    tAmbientC: 35,
    thetaJc: 0.18,
    thetaHs: 0.28,
    thetaAmb: 0.19,
    cJ: 1.9,
    cHs: 62,
    cBoard: 180,
    leakCoeffPerK: 0.012,
    // Temperature at which the 4 W leakage budget is quoted.
    leakRefC: 60,
  },
  clockDomains: [
    { name: 'AVT core', ghz: 1.8, vdd: 0.75 },
    { name: 'AVT boost', ghz: 2.1, vdd: 0.85 },
    { name: 'L2 / cluster', ghz: 1.8, vdd: 0.75 },
    { name: 'L3 die 0', ghz: 1.8, vdd: 0.7 },
    { name: 'L3 die 1', ghz: 1.8, vdd: 0.7 },
    { name: 'HBM PHY', ghz: 1.2, vdd: 0.85 },
    { name: 'NoC', ghz: 1.6, vdd: 0.7 },
    { name: 'PCIe / CXL', ghz: 0.9, vdd: 0.8 },
    { name: 'NTV / monitor', ghz: 1.05, vdd: 0.55 },
  ],
});

/** Fixed per-run card turnaround: queue insert, context restore, telemetry
 *  drain and the post-run conservation sweep. Dominates sub-millisecond jobs. */
const DISPATCH_OVERHEAD_S = 0.36;

/** mulberry32 — small, fast, deterministic 32-bit PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string, used to key the telemetry PRNG. */
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * A workload descriptor. Kernels fill this in from real operation counts.
 * Every field is optional except `ops`; missing values are treated as zero.
 */
function makeWorkload(base) {
  const ops = base.ops || {};
  const traffic = base.traffic || {};
  return {
    id: base.id || 'workload',
    label: base.label || 'unnamed workload',
    kind: base.kind || 'compute',
    ops: {
      fp32: ops.fp32 || 0,
      fp16: ops.fp16 || 0,
      fp8: ops.fp8 || 0,
      sfu: ops.sfu || 0,
    },
    // Useful (algorithmic) FLOPs, when the issued op count carries overhead
    // such as halo exchange, address generation and predication.
    useful: base.useful || 0,
    traffic: {
      sram: traffic.sram || 0,
      l2: traffic.l2 || 0,
      l3: traffic.l3 || 0,
      hbm: traffic.hbm || 0,
      noc: traffic.noc || 0,
      pcie: traffic.pcie || 0,
    },
    steps: base.steps || 1,
    stages: base.stages || 1,
    // Per-block activity declared by the kernel when it knows its own mix
    // (0 = idle floor, 1 = block budget). null => derive from the traffic.
    activity: base.activity || null,
    // Issue overhead beyond the useful FLOPs: address generation, halo
    // exchange, predicate masks and lanes idled by the schedule.
    overhead: base.overhead == null ? 0 : base.overhead,
    serialLatencyCycles: base.serialLatencyCycles || 0,
    clusterWeights: base.clusterWeights || new Array(8).fill(1),
    tileWeights: base.tileWeights || new Array(64).fill(1),
    laneOccupancy: base.laneOccupancy == null ? 1 : base.laneOccupancy,
    precision: base.precision || 'fp32',
    // DVFS point. 1.80 GHz / 0.75 V nominal; 1.05 GHz / 0.55 V is the NTV point
    // the governor selects for latency-bound work.
    clockGHz: base.clockGHz || SPEC.compute.clockGHz,
    meta: base.meta || {},
  };
}

class VirtualACPUD1 {
  constructor(opts = {}) {
    this.seed = opts.seed == null ? 0x7e3a1d : opts.seed >>> 0;
    this.ambientC = SPEC.thermal.tAmbientC;
    this.junctionC = 41.2;
    this.heatsinkC = 38.4;
    this.clockGHz = SPEC.compute.clockGHz;
    this.vdd = 0.75;
    this.powerW = SPEC.power.idleW;
    this.tilesActive = 64;
    this.clusterUtil = new Array(8).fill(0.03);
    this.tileUtil = new Array(64).fill(0.03);
    this.blockPower = Object.fromEntries(SPEC.power.blocks.map((b) => [b.id, 0]));
    this.counters = {
      runs: 0,
      cycles: 0,
      energyJ: 0,
      flops: 0,
      dispatchOverheadS: 0,
      blockEnergyJ: Object.fromEntries(SPEC.power.blocks.map((b) => [b.id, 0])),
    };
    this.lastRun = null;
    this.eventLog = [];
    this.startedAt = Date.now();
    this._log('device', 'ACPU-1 Tempest enumerated on PCIe 0000:41:00.0 · 64/64 AVTs online');
  }

  _log(kind, text) {
    this.eventLog.push({ t: Date.now(), kind, text });
    if (this.eventLog.length > 200) this.eventLog.shift();
  }

  /** Static device descriptor + live state, for the renderer / HTTP service. */
  info() {
    return {
      chip: { ...SPEC.chip, ...SPEC.compute },
      memory: { ...SPEC.memory },
      power: { ...SPEC.power },
      thermal: { ...SPEC.thermal },
      clockDomains: SPEC.clockDomains,
      revision: '1.0',
      state: this.snapshot(),
      counters: {
        runs: this.counters.runs,
        cycles: this.counters.cycles,
        energyJ: round(this.counters.energyJ, 2),
        flops: this.counters.flops,
      },
      eventLog: this.eventLog.slice(-40),
    };
  }

  /** One live telemetry frame (what the top bar and Device view read). */
  snapshot() {
    return {
      ts: Date.now(),
      clockGHz: round(this.clockGHz, 2),
      powerW: round(this.powerW, 2),
      junctionC: round(this.junctionC, 2),
      heatsinkC: round(this.heatsinkC, 2),
      tilesActive: this.tilesActive,
      clusterUtil: this.clusterUtil.map((v) => round(v, 4)),
      tileUtil: this.tileUtil.map((v) => round(v, 4)),
      blockPower: Object.fromEntries(Object.entries(this.blockPower).map(([k, v]) => [k, round(v, 3)])),
      energyJ: round(this.counters.energyJ, 2),
      cycles: this.counters.cycles,
      memUtil: this._memUtil(),
      running: false,
    };
  }

  _memUtil() {
    const blk = this.blockPower;
    const maxW = Object.fromEntries(SPEC.power.blocks.map((b) => [b.id, b.w]));
    return {
      l2: round(clamp((blk.sram || 0) / maxW.sram, 0, 1), 3),
      l3: round(clamp((blk.l3 || 0) / maxW.l3, 0, 1), 3),
      hbm: round(clamp((blk.hbm || 0) / maxW.hbm, 0, 1), 3),
      noc: round(clamp((blk.noc || 0) / maxW.noc, 0, 1), 3),
    };
  }

  /** Junction leakage power, referenced to Tj,max (4 W at 95 C). */
  _leakW(tempC) {
    return clamp(4 * (1 + SPEC.thermal.leakCoeffPerK * (tempC - SPEC.thermal.leakRefC)), 0.25, 6.5);
  }

  /** Live idle distribution: block floors, temperature-corrected leakage, board. */
  _idleBlocks() {
    const out = { ...SPEC.power.idleBlocks };
    out.leak = this._leakW(this.junctionC);
    out.board = SPEC.power.boardIdleW;
    return out;
  }

  /** Idle thermal drift, called ~10 Hz by the host when nothing is running. */
  tick(dtS) {
    const idle = this._idleBlocks();
    for (const b of SPEC.power.blocks) this.blockPower[b.id] = idle[b.id];
    this.blockPower.board = idle.board;
    this.powerW = Object.values(idle).reduce((a, b) => a + b, 0);
    this._thermalStep(dtS, this.powerW);
    this.clockGHz = 1.8;
    for (let i = 0; i < 8; i += 1) this.clusterUtil[i] = 0.03 + (i % 3) * 0.004;
    for (let i = 0; i < 64; i += 1) this.tileUtil[i] = 0.02 + ((i * 7) % 5) * 0.004;
  }

  /** Two-node RC thermal network integrated with a small fixed substep. */
  _thermalStep(dtS, powerW) {
    const t = SPEC.thermal;
    const sub = 0.05;
    let remaining = Math.max(0, Math.min(dtS, 400));
    let tj = this.junctionC;
    let th = this.heatsinkC;
    while (remaining > 1e-9) {
      const h = Math.min(sub, remaining);
      const q1 = (tj - th) / t.thetaJc;
      const q2 = (th - this.ambientC) / (t.thetaHs + t.thetaAmb);
      tj += ((powerW - q1) / t.cJ) * h;
      th += ((q1 - q2) / t.cHs) * h;
      remaining -= h;
    }
    this.junctionC = clamp(tj, this.ambientC - 2, t.tjMaxC);
    this.heatsinkC = clamp(th, this.ambientC - 2, t.tjMaxC);
    return this.junctionC;
  }

  /**
   * Side-effect-free cost estimate: how long would this workload take?
   * Used by the analytic benchmark models (W1/W2) to size their memory
   * traffic before dispatching, and by the UI to preview a run.
   */
  estimate(workload) {
    const w = makeWorkload(workload);
    const mhz = w.clockGHz * 1e9;
    const lanes = SPEC.compute.tiles * SPEC.compute.lanesPerTile;
    const fmaCycles =
      w.ops.fp32 / (lanes * 2) + w.ops.fp16 / (lanes * 4) + w.ops.fp8 / (lanes * 4);
    const sfuCycles = w.ops.sfu / (lanes * 0.25);
    const issueCycles = Math.max(1, fmaCycles + sfuCycles);
    const bw = {
      sram: SPEC.memory.sramTbs * 1e12, l2: SPEC.memory.l2Tbs * 1e12, l3: SPEC.memory.l3Tbs * 1e12,
      hbm: SPEC.memory.hbmTbs * 1e12, noc: SPEC.memory.nocTbs * 1e12, pcie: 12.5e9,
    };
    const memTime = {};
    for (const k of ['sram', 'l2', 'l3', 'hbm', 'noc', 'pcie']) memTime[k] = w.traffic[k] / bw[k];
    const memMax = Object.entries(memTime).reduce((a, e) => (e[1] > a[1] ? e : a), ['none', 0]);
    const serialS = (w.serialLatencyCycles + w.steps * w.stages * 120) / mhz;
    const depStall = clamp((w.steps * w.stages * 26) / Math.max(issueCycles, 1), 0, 0.22);
    const syncStall = clamp((w.steps * w.stages * 9) / Math.max(issueCycles, 1), 0, 0.05);
    const sfuStall = clamp((sfuCycles / Math.max(issueCycles, 1)) * 0.4, 0, 0.08);
    const partialStall = clamp(1 - w.laneOccupancy, 0, 0.9) * 0.06;
    const computeS = (issueCycles / mhz) * (1 + depStall + syncStall + sfuStall + partialStall + w.overhead) + serialS;
    const coreS = Math.max(computeS, memMax[1]);
    return {
      computeS, memS: memMax[1], coreS, timeS: DISPATCH_OVERHEAD_S + coreS,
      issueCycles, bandwidth: bw, memLimit: memMax[0],
      bottleneck: memMax[1] > computeS ? `memory: ${memMax[0]}` : 'compute: MAC issue',
      peakTflops: SPEC.compute.peakTflopsFp32,
      usefulUtil: clamp((w.ops.fp32 + w.ops.fp16 + w.ops.fp8) / (SPEC.compute.peakTflopsFp32 * 1e12 * (DISPATCH_OVERHEAD_S + coreS)), 0, 1),
    };
  }

  /**
   * Cost model. Returns a full run report plus a telemetry timeline.
   * Deterministic in (this.seed, workload signature).
   */
  execute(workload) {
    const w = makeWorkload(workload);
    const clock = w.clockGHz;
    const mhz = clock * 1e9;
    const vScale = clock < 1.3 ? 0.55 / 0.75 : 1;
    const dynScale = (clock / SPEC.compute.clockGHz) * vScale * vScale;
    const leakScale = Math.pow(vScale, 1.5);
    const lanes = SPEC.compute.tiles * SPEC.compute.lanesPerTile; // 16384
    const lanesPerTile = SPEC.compute.lanesPerTile;
    const clusters = SPEC.compute.clusters;
    const tiles = SPEC.compute.tiles;

    const bw = {
      sram: SPEC.memory.sramTbs * 1e12,
      l2: SPEC.memory.l2Tbs * 1e12,
      l3: SPEC.memory.l3Tbs * 1e12,
      hbm: SPEC.memory.hbmTbs * 1e12,
      noc: SPEC.memory.nocTbs * 1e12,
      pcie: 12.5e9,
    };

    // ---- issue cycles -------------------------------------------------------
    const fmaCycles =
      w.ops.fp32 / (lanes * 2) + // 1 FMA / lane / cycle
      w.ops.fp16 / (lanes * 4) + // 2 FMA / lane / cycle
      w.ops.fp8 / (lanes * 4); //   4 MAC / lane / cycle
    const sfuCycles = w.ops.sfu / (lanes * 0.25);
    const issueCycles = Math.max(1, fmaCycles + sfuCycles);

    // ---- bandwidth bound ----------------------------------------------------
    const memTime = {};
    for (const k of ['sram', 'l2', 'l3', 'hbm', 'noc', 'pcie']) memTime[k] = w.traffic[k] / bw[k];
    const memMax = Object.entries(memTime).reduce((a, e) => (e[1] > a[1] ? e : a), ['none', 0]);

    // ---- stalls -------------------------------------------------------------
    // Serial dependency + tile-grid barriers + SFU issue + partial occupancy.
    const serialS = (w.serialLatencyCycles + w.steps * w.stages * 120) / mhz;
    const depStall = clamp((w.steps * w.stages * 26) / Math.max(issueCycles, 1), 0, 0.22);
    const syncStall = clamp((w.steps * w.stages * 9) / Math.max(issueCycles, 1), 0, 0.05);
    const sfuStall = clamp((sfuCycles / Math.max(issueCycles, 1)) * 0.4, 0, 0.08);
    const partialStall = clamp(1 - w.laneOccupancy, 0, 0.9) * 0.06;
    const computeS = (issueCycles / mhz) * (1 + depStall + syncStall + sfuStall + partialStall + w.overhead) + serialS;

    // ---- time ---------------------------------------------------------------
    const memS = memMax[1];
    const coreS = Math.max(computeS, memS);
    const timeS = DISPATCH_OVERHEAD_S + coreS;
    const bottleneck = memS > computeS
      ? `memory: ${memMax[0]}`
      : coreS > DISPATCH_OVERHEAD_S * 2 ? 'compute: MAC issue' : 'dispatch / turnaround';
    const stallFrac = { dependency: depStall, memory: 0, sync: syncStall, sfu: sfuStall, partial: partialStall };
    stallFrac.memory = memS > computeS ? clamp(memS / Math.max(coreS, 1e-9) - 0.7, 0.08, 0.6) : 0;

    const totalFlops = w.ops.fp32 + w.ops.fp16 + w.ops.fp8;
    const usefulFlops = w.useful > 0 ? w.useful : totalFlops;
    const peakFlops = SPEC.compute.peakTflopsFp32 * 1e12;
    const usefulUtil = clamp(usefulFlops / (peakFlops * timeS), 0, 1);
    const arrayUtil = clamp(issueCycles / (mhz * timeS), 0, 1);

    const cost = {
      timeS, computeS, memS, coreS, issueCycles, sfuCycles, memMax, memTime,
      stallFrac, bottleneck, depStall, syncStall, sfuStall, partialStall,
      totalFlops, usefulUtil, arrayUtil,
    };

    // ---- power --------------------------------------------------------------
    // Each block sits at its idle floor and rises toward its budget as the
    // workload presses on it. Activity is *issue* activity, not useful FLOPs:
    // a stalled array still toggles, so power tracks occupancy, not throughput.
    const press = (k) => clamp(w.traffic[k] / (bw[k] * timeS), 0, 1);
    const act = {
      mac: clamp(0.06 + 0.98 * Math.sqrt(usefulUtil), 0.05, 1),
      sram: clamp(0.04 + press('sram'), 0.04, 1),
      l3: clamp(0.04 + press('l3'), 0.04, 1),
      noc: clamp(0.04 + press('noc'), 0.04, 1),
      hbm: clamp(0.04 + press('hbm'), 0.04, 1),
      pcie: 1.0,
      clock: 1,
      misc: 1,
    };
    if (w.activity) {
      for (const [k, v] of Object.entries(w.activity)) {
        if (act[k] != null) act[k] = clamp(Number(v), 0, 1);
      }
    }

    // ---- telemetry timeline (virtual time) ----------------------------------
    const N = 200;
    const rng = mulberry32((this.seed ^ hashStr(w.id + '|' + w.precision + '|' + w.ops.fp32 + '|' + w.ops.fp16)) >>> 0);
    const phaseEdges = [0, 0.018, 0.036, 0.982, 1.0];
    const phaseNames = ['map', 'schedule', 'execute', 'reduce'];
    const samples = [];
    const blocks = SPEC.power.blocks;
    const energyByBlock = Object.fromEntries([...blocks.map((b) => b.id), 'board'].map((id) => [id, 0]));
    let eAccum = 0;
    let tj = this.junctionC;
    let th = this.heatsinkC;
    const dtS = timeS / N;
    const clusterTimeline = new Array(8).fill(0).map(() => new Array(N).fill(0));
    const tileAcc = new Array(64).fill(0);
    const utilBase = w.clusterWeights;
    const idleB = this._idleBlocks();
    let peakTj = tj;
    const phaseEnergy = { map: 0, schedule: 0, execute: 0, reduce: 0 };

    for (let s = 0; s < N; s += 1) {
      const u = N === 1 ? 1 : s / (N - 1);
      let phase = 3;
      for (let p = 0; p < 4; p += 1) if (u >= phaseEdges[p] && u < phaseEdges[p + 1]) phase = p;
      const isExec = phase === 2;
      const isTail = phase === 3;
      const lift = isExec ? 1 : isTail ? 0.5 : 0.72;
      const jitter = 0.96 + rng() * 0.08;
      const p = {};
      let sum = 0;
      for (const b of blocks) {
        let wb;
        if (b.id === 'leak') {
          wb = this._leakW(tj) * leakScale;
        } else if (b.id === 'clock' || b.id === 'misc') {
          wb = b.w * act[b.id] * (b.id === 'clock' ? Math.sqrt(clock / SPEC.compute.clockGHz) : dynScale * 0.5 + 0.5);
        } else {
          const a = clamp((act[b.id] || 0.5) * lift * jitter, 0, 1);
          // HBM and PCIe keep their own supply domains; core and cache scale.
          const ds = (b.id === 'hbm' || b.id === 'pcie') ? 1 : dynScale;
          wb = idleB[b.id] + (b.w - idleB[b.id]) * a * ds;
        }
        // DRAM refresh runs whenever the HBM stacks are powered, not only when
        // they are being read (spec: dram_refresh_w = 1.2).
        if (b.id === 'hbm') wb += 1.2;
        p[b.id] = wb;
        sum += wb;
      }
      // Fan speed follows the heat load, so board power tracks card power.
      const boardW = SPEC.power.boardIdleW
        + (SPEC.power.boardLoadW - SPEC.power.boardIdleW) * Math.pow(clamp(sum / 45, 0, 1), 0.7);
      const cardW = sum + boardW;
      eAccum += cardW * dtS;
      phaseEnergy[phaseNames[phase]] += cardW * dtS;
      for (const b of blocks) energyByBlock[b.id] += p[b.id] * dtS;
      energyByBlock.board += boardW * dtS;

      // thermal RC, one step per sample
      const q1 = (tj - th) / SPEC.thermal.thetaJc;
      const q2 = (th - this.ambientC) / (SPEC.thermal.thetaHs + SPEC.thermal.thetaAmb);
      tj += ((cardW - q1) / SPEC.thermal.cJ) * dtS;
      th += ((q1 - q2) / SPEC.thermal.cHs) * dtS;
      tj = clamp(tj, this.ambientC - 2, SPEC.thermal.tjMaxC);
      th = clamp(th, this.ambientC - 2, SPEC.thermal.tjMaxC);
      peakTj = Math.max(peakTj, tj);

      const cu = new Array(8);
      for (let c = 0; c < 8; c += 1) {
        const base = clamp(utilBase[c], 0, 1) * (isExec ? 0.93 : isTail ? 0.3 : 0.5);
        const v = clamp(base * (0.9 + rng() * 0.14), 0, 1);
        cu[c] = v;
        clusterTimeline[c][s] = round(v, 4);
        for (let t = 0; t < 8; t += 1) tileAcc[c * 8 + t] += v;
      }
      samples.push({
        t: round(u * timeS, 3),
        u: round(u, 4),
        phase: phaseNames[phase],
        powerW: round(cardW, 2),
        junctionC: round(tj, 2),
        clockGHz: round(clock, 2),
        util: round(clamp(isExec ? usefulUtil : usefulUtil * 0.45, 0, 1), 6),
        clusterUtil: cu,
        blockPower: Object.fromEntries(blocks.map((b) => [b.id, round(p[b.id], 3)])),
        memUtil: {
          l2: round(clamp((p.sram - idleB.sram) / 6.6, 0, 1), 3),
          l3: round(clamp((p.l3 - idleB.l3) / 4.78, 0, 1), 3),
          hbm: round(clamp((p.hbm - idleB.hbm) / 7.74, 0, 1), 3),
          noc: round(clamp((p.noc - idleB.noc) / 4.32, 0, 1), 3),
        },
      });
    }

    const avgPower = eAccum / timeS;
    const perBlockPower = {};
    for (const b of blocks) perBlockPower[b.id] = round(energyByBlock[b.id] / timeS, 3);
    perBlockPower.board = round(energyByBlock.board / timeS, 3);

    const cycles = Math.round(timeS * mhz);
    const stallCycles = {
      dependency: Math.round(issueCycles * depStall),
      memory: Math.round(issueCycles * stallFrac.memory),
      sync: Math.round(issueCycles * syncStall),
      sfu: Math.round(issueCycles * sfuStall),
      partial: Math.round(issueCycles * partialStall),
    };
    const stallTotal = Object.values(stallCycles).reduce((a, b) => a + b, 0);

    const metrics = {
      workload: w.id,
      label: w.label,
      timeS: round(cost.timeS, 4),
      energyJ: round(eAccum, 3),
      powerW: round(avgPower, 2),
      peakPowerW: round(Math.max(...samples.map((s) => s.powerW)), 2),
      tflops: round(usefulFlops / timeS / 1e12, 9),
      util: round(usefulUtil, 6),
      arrayUtil: round(arrayUtil, 4),
      laneOccupancy: round(w.laneOccupancy, 3),
      bottleneck,
      clockGHz: round(clock, 2),
      dvfs: clock < 1.3 ? 'ntv 1.05 GHz' : 'nominal 1.80 GHz',
      cycles,
      issueCycles: Math.round(issueCycles),
      stallCycles,
      stallTotal,
      stallBreakdown: {
        dependency: round(depStall, 4),
        memory: round(stallFrac.memory, 4),
        sync: round(syncStall, 4),
        sfu: round(sfuStall, 4),
        partial: round(partialStall, 4),
      },
      dispatchS: round(Math.min(DISPATCH_OVERHEAD_S, timeS), 4),
      peakTj: round(peakTj, 1),
      avgTj: round(samples.reduce((a, s) => a + s.junctionC, 0) / N, 1),
      perBlockPower,
      phaseEnergy: Object.fromEntries(Object.entries(phaseEnergy).map(([k, v]) => [k, round(v, 3)])),
      blockEnergyJ: Object.fromEntries(Object.entries(energyByBlock).map(([k, v]) => [k, round(v, 3)])),
      traffic: Object.fromEntries(Object.entries(w.traffic).map(([k, v]) => [k, Math.round(v)])),
      bwUtil: Object.fromEntries(Object.entries(memTime).map(([k, v]) => [k, round(clamp(v / timeS, 0, 1), 3)])),
      clusterTimeline,
      samples,
      tilesActive: 64,
      tileUtil: tileAcc.map((v) => round(clamp(v / N, 0, 1), 4)),
      usefulFlops,
      issuedFlops: totalFlops,
      precision: w.precision,
      meta: w.meta,
    };

    // ---- commit state -------------------------------------------------------
    this.counters.runs += 1;
    this.counters.cycles += cycles;
    this.counters.energyJ += eAccum;
    this.counters.flops += totalFlops;
    this.counters.dispatchOverheadS += metrics.dispatchS;
    for (const b of blocks) this.counters.blockEnergyJ[b.id] += energyByBlock[b.id];
    this.powerW = avgPower;
    this.clockGHz = clock;
    this.junctionC = samples[N - 1].junctionC;
    this.heatsinkC = th;
    for (let c = 0; c < 8; c += 1) this.clusterUtil[c] = clusterTimeline[c][N - 1];
    this.tileUtil = metrics.tileUtil;
    this.lastRun = metrics;
    this._log('run', `${w.label} · ${round(timeS, 3)} s · ${round(eAccum, 1)} J · ${round(avgPower, 1)} W · Tj ${round(peakTj, 1)} C`);
    return metrics;
  }
}

module.exports = {
  SPEC,
  DISPATCH_OVERHEAD_S,
  VirtualACPUD1,
  mulberry32,
  hashStr,
  makeWorkload,
  createDevice: (opts) => new VirtualACPUD1(opts),
};
