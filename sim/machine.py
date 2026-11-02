"""ACPU-1 pre-silicon performance / energy / thermal / cost model.

The model is deliberately transparent: every architectural assumption is a
named constant in `spec/acpu1.json` or in the tables below, and every result
is emitted as JSON/CSV so that the report figures and the numbers quoted in
the text come from the same run.

Model levels
------------
1. Kernel table    per-cell operation, SFU and byte counts for the reference
                   atmospheric workload (24 prognostic variables).
2. AVT micro-sim   cycle-level model of one Atmospheric Vector Tile: issue,
                   SFU contention, SRAM bank conflicts, halo wait, precision
                   switch and exposed latency -> sustained issue efficiency.
3. Chip model      64 AVTs, shared L2/L3/HBM/NoC, static power -> time,
                   achieved utilisation, energy per time step.
4. Baseline model  H100/A100 roofline + power states on the same workload.
5. Physics models  thermal RC network, Fmax corners, yield, package cost, FIT.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_PATH = os.path.join(HERE, "..", "spec", "acpu1.json")

with open(SPEC_PATH) as fh:
    SPEC = json.load(fh)

PJ = 1e-12  # picojoule -> joule

# --------------------------------------------------------------------------
# Reference workload: W1 ensemble forecast
# --------------------------------------------------------------------------

GRID = (256, 256, 64)                      # 3 km regional domain, ~768 x 768 km
CELLS = GRID[0] * GRID[1] * GRID[2]        # 4,194,304
MEMBERS = 64
VARS = 24
DT_S = 20.0
FORECAST_H = 24.0
STEPS = int(FORECAST_H * 3600.0 / DT_S)    # 4,320
STATE_BYTES_PER_CELL = VARS * 4            # fp32 prognostic state

# name, phase, flops/cell (all vars), SFU/cell, SRAM bytes/cell, precision
KERNELS = [
    dict(name="semi-Lagrangian advection", short="adv3d", phase="dynamics",
         flops=1050, sfu=0,  sram=200, prec="fp32", stencil=True),
    dict(name="biharmonic diffusion",      short="diff3d", phase="dynamics",
         flops=220,  sfu=0,  sram=200, prec="fp32", stencil=True),
    dict(name="pressure gradient + Coriolis", short="pgrad", phase="dynamics",
         flops=260,  sfu=0,  sram=100, prec="fp32", stencil=True),
    dict(name="bulk microphysics",         short="micro",  phase="physics",
         flops=620,  sfu=28, sram=100, prec="physics", stencil=False),
    dict(name="PBL turbulence",            short="pbl",    phase="physics",
         flops=400,  sfu=6,  sram=80,  prec="physics", stencil=False),
    dict(name="convection",                short="conv",   phase="physics",
         flops=520,  sfu=12, sram=64,  prec="physics", stencil=False),
    dict(name="radiation (1/8 amortised)", short="rad",    phase="physics",
         flops=760,  sfu=26, sram=64,  prec="physics", stencil=False),
    dict(name="surface / land",            short="land",   phase="physics",
         flops=230,  sfu=4,  sram=48,  prec="physics", stencil=False),
    dict(name="tracer chemistry",          short="chem",   phase="physics",
         flops=360,  sfu=0,  sram=64,  prec="fp16",  stencil=False),
    dict(name="conservation audit",        short="cons",   phase="audit",
         flops=120,  sfu=0,  sram=100, prec="fp32", stencil=False),
]

TOTAL_FLOPS_PER_CELL = sum(k["flops"] for k in KERNELS)
TOTAL_SFU_PER_CELL = sum(k["sfu"] for k in KERNELS)
TOTAL_SRAM_BYTES = sum(k["sram"] for k in KERNELS)

PHYS_FP16_COVERAGE = 0.58
PHYS_FP16_COVERAGE_RANGE = (0.35, 0.78)


@dataclass
class MachineResult:
    name: str
    steps: int
    time_s: float
    energy_j: float
    energy_breakdown: dict = field(default_factory=dict)
    util: float = 0.0
    achieved_tflops: float = 0.0
    power_w: float = 0.0
    hbm_gb: float = 0.0
    sram_gb: float = 0.0
    per_kernel: list = field(default_factory=list)


# --------------------------------------------------------------------------
# AVT micro-simulation
# --------------------------------------------------------------------------

class AVTMicromodel:
    """Cycle-level model of one 16x16 AVT executing the kernel chain."""

    def __init__(self, spec=SPEC):
        c = spec["compute"]
        self.lanes = c["lanes_per_tile"]
        self.sram_bw_bytes_per_cycle = 512.0
        self.halo_latency_cycles = 46
        self.precision_switch_cycles = 14
        self.pipeline_latency = 5

    def run(self, kernel, fp16_share: float = 0.0) -> dict:
        group = self.lanes
        share16 = fp16_share if kernel["prec"] in ("physics", "fp16") else 0.0
        slots = (1.0 - share16) * 1.0 + share16 * 0.5
        issue = kernel["flops"] * group * slots / self.lanes
        sfu = kernel["sfu"] * group / (self.lanes * 0.25)
        sram = kernel["sram"] * group / self.sram_bw_bytes_per_cycle
        bubbles = issue * (0.055 if kernel["stencil"] else 0.035)
        conflicts = sram * 0.12
        halo = self.halo_latency_cycles if kernel["stencil"] else 0
        switch = self.precision_switch_cycles if 0.0 < share16 < 1.0 else 0
        exposed = sram * 0.35 + self.pipeline_latency
        total = issue + sfu + bubbles + conflicts + halo + switch + exposed
        return dict(kernel=kernel["short"], issue=issue, sfu=sfu, bubbles=bubbles,
                    conflicts=conflicts, halo=halo, switch=switch, exposed=exposed,
                    total=total, efficiency=issue / total)


def kernel_efficiencies(fp16_coverage: float = PHYS_FP16_COVERAGE) -> dict:
    m = AVTMicromodel()
    out = {}
    for k in KERNELS:
        share = (fp16_coverage if k["prec"] == "physics"
                 else 1.0 if k["prec"] == "fp16" else 0.0)
        out[k["short"]] = m.run(k, share)
    return out


# --------------------------------------------------------------------------
# Chip-level step model
# --------------------------------------------------------------------------

def simulate_step(fp16_coverage: float = PHYS_FP16_COVERAGE, clock_ghz: float = None,
                  hbm_tbps: float = None, use_halo_fabric: bool = True,
                  use_ntv: bool = False, use_precision: bool = True,
                  lanes_are_members: bool = True) -> dict:
    c, mem, p = SPEC["compute"], SPEC["memory"], SPEC["power"]
    e = p["energy_pj"]
    clock = (SPEC["clock"]["ntv_ghz"] if use_ntv
             else (clock_ghz or SPEC["clock"]["nominal_ghz"]))
    hbm_bw = (hbm_tbps or mem["hbm_tbps_total"]) * 1e12

    lanes = c["fma_total"]
    effs = kernel_efficiencies(fp16_coverage if use_precision else 0.0)
    reuse = 1.0 if lanes_are_members else 2.6

    per_kernel = []
    ideal_cycles = 0.0
    util_num = 0.0
    e_compute = e_sram = e_sfu = 0.0
    sram_bytes = 0.0
    sfu_ops = 0.0
    flops_total = 0.0
    for k in KERNELS:
        share = (fp16_coverage if k["prec"] == "physics"
                 else 1.0 if k["prec"] == "fp16" else 0.0)
        if not use_precision:
            share = 0.0
        slots = (1 - share) + share * 0.5
        n = k["flops"] * CELLS * MEMBERS
        cycles = n * slots / (lanes * 2.0)
        sn = k["sfu"] * CELLS * MEMBERS
        sb = k["sram"] * CELLS * MEMBERS * reuse
        ef = e["fp32_fma"] if k["prec"] == "fp32" else (
            e["fp16_fma"] if k["prec"] == "fp16"
            else share * e["fp16_fma"] + (1 - share) * e["fp32_fma"])
        e_k = n * ef * PJ + sn * e["sfu_op"] * PJ + (sb / 4) * e["sram_word_read"] * PJ
        per_kernel.append(dict(kernel=k["short"], name=k["name"], phase=k["phase"],
                               flops=n, cycles=cycles, sram_bytes=sb,
                               energy=e_k, efficiency=effs[k["short"]]["efficiency"]))
        ideal_cycles += cycles
        util_num += effs[k["short"]]["efficiency"] * cycles
        e_compute += n * ef * PJ
        e_sfu += sn * e["sfu_op"] * PJ
        e_sram += (sb / 4) * e["sram_word_read"] * PJ
        sram_bytes += sb
        sfu_ops += sn
        flops_total += n

    # ---- memory traffic ---------------------------------------------------
    hbm_bytes = CELLS * MEMBERS * STATE_BYTES_PER_CELL * 2 * 1.12
    if not use_halo_fabric:
        hbm_bytes *= 1.35
    l2_bytes = sram_bytes * 0.06
    l3_bytes = sram_bytes * (0.18 if use_halo_fabric else 0.55)
    noc_bytes = sram_bytes * 0.10

    bw = dict(sram=c["tile_sram_bw_gbps"] * c["tiles_total"] * 1e9,
              l2=mem["l2_bw_tbps"] * 1e12, l3=mem["l3_bw_tbps"] * 1e12,
              hbm=hbm_bw, noc=c["noc_peak_tbps"] * 1e12)
    demand = dict(sram=sram_bytes, l2=l2_bytes, l3=l3_bytes, hbm=hbm_bytes, noc=noc_bytes)
    t_resource = {k: demand[k] / bw[k] for k in demand}

    eff_micro = util_num / ideal_cycles
    if not lanes_are_members:
        eff_micro *= 0.88
    t_compute = ideal_cycles / (clock * 1e9) / eff_micro
    t_mem = max(t_resource.values())
    t = max(t_compute, t_mem)
    ratio = t_mem / max(t_compute, 1e-12)
    if ratio > 0.55:
        t *= 1.0 + 0.18 * min(ratio, 1.6)
    if not use_halo_fabric:
        t *= 1.07

    # ---- energy -----------------------------------------------------------
    e_l2 = (l2_bytes / 4) * e["l2_word_read"] * PJ
    e_l3 = l3_bytes * e["l3_byte"] * PJ
    e_hbm = hbm_bytes * e["hbm_byte"] * PJ
    e_noc = noc_bytes * e["noc_byte"] * PJ
    e_sram *= 1.18
    # efficiency mode: 0.55 V / 1.05 GHz, dynamic energy x0.42, leakage x0.55
    dyn_scale = 1.0 if not use_ntv else 0.42
    leak_scale = 1.0 if not use_ntv else 0.55
    e_compute *= dyn_scale
    e_sram *= dyn_scale
    e_l2 *= dyn_scale
    e_l3 *= dyn_scale
    e_noc *= dyn_scale
    e_sfu *= dyn_scale
    static_w = (p["budget_w"]["clock_pll"] * dyn_scale +
                p["budget_w"]["leakage"] * leak_scale +
                p["budget_w"]["pcie_io"] * 0.6)
    e_static = static_w * t
    e_total = (e_compute + e_sram + e_l2 + e_l3 + e_hbm + e_noc + e_sfu + e_static)

    achieved = flops_total / t / 1e12
    return dict(
        time_s=t, t_compute=t_compute, t_mem=t_mem, t_resource=t_resource,
        eff_micro=eff_micro, util=achieved / SPEC["compute"]["peak_tflops_fp32"],
        util_mode=achieved / (flops_total / (ideal_cycles / (clock * 1e9)) / 1e12),
        achieved_tflops=achieved, power_w=e_total / t,
        flops=flops_total, ideal_cycles=ideal_cycles,
        sram_gb=sram_bytes / 1e9, hbm_gb=hbm_bytes / 1e9, l2_gb=l2_bytes / 1e9,
        l3_gb=l3_bytes / 1e9, noc_gb=noc_bytes / 1e9,
        energy=dict(compute=e_compute, sram=e_sram, l2=e_l2, l3=e_l3, hbm=e_hbm,
                    noc=e_noc, sfu=e_sfu, static=e_static),
        energy_j=e_total, per_kernel=per_kernel,
        hbm_fraction=e_hbm / e_total,
    )


def simulate_forecast(**kw) -> MachineResult:
    st = simulate_step(**kw)
    init_bytes = CELLS * MEMBERS * STATE_BYTES_PER_CELL * 1.05
    out_bytes = CELLS * MEMBERS * STATE_BYTES_PER_CELL * 4
    e_io = (init_bytes + out_bytes) * SPEC["power"]["energy_pj"]["hbm_byte"] * PJ
    t_io = (init_bytes + out_bytes) / (SPEC["memory"]["hbm_tbps_total"] * 1e12)
    breakdown = {k: v * STEPS for k, v in st["energy"].items()}
    breakdown["io"] = e_io
    total = sum(breakdown.values())
    time_s = st["time_s"] * STEPS + 0.35 * t_io
    return MachineResult(
        name="W1 ensemble forecast", steps=STEPS, time_s=time_s, energy_j=total,
        energy_breakdown=breakdown, util=st["util"],
        achieved_tflops=st["achieved_tflops"],
        power_w=total / time_s,
        hbm_gb=(st["hbm_gb"] * STEPS + (init_bytes + out_bytes) / 1e9),
        sram_gb=st["sram_gb"] * STEPS, per_kernel=st["per_kernel"],
    )


# --------------------------------------------------------------------------
# Data assimilation and secondary workloads
# --------------------------------------------------------------------------

DA_FLOPS_FRACTION = 0.25
DA_EFF_ACPU = 0.40
DA_EFF_GPU = 0.55


def simulate_da(clock_ghz: float = None, use_ntv: bool = False) -> MachineResult:
    flops = TOTAL_FLOPS_PER_CELL * CELLS * MEMBERS * STEPS * DA_FLOPS_FRACTION
    # dense analysis maps onto the fp16 datapath (2 FMA/lane/cycle)
    clock = SPEC["clock"]["ntv_ghz"] if use_ntv else (clock_ghz or SPEC["clock"]["nominal_ghz"])
    peak16 = SPEC["compute"]["peak_tflops_fp16"] * clock / SPEC["clock"]["nominal_ghz"]
    time_s = flops / (peak16 * 1e12 * DA_EFF_ACPU)
    bytes_moved = CELLS * MEMBERS * STATE_BYTES_PER_CELL * 2.0
    dyn = 0.42 if use_ntv else 1.0
    e = (flops * 0.25 * PJ + bytes_moved * SPEC["power"]["energy_pj"]["hbm_byte"] * PJ
         + (SPEC["power"]["budget_w"]["clock_pll"] * dyn +
            SPEC["power"]["budget_w"]["leakage"] * (0.55 if use_ntv else 1.0)) * time_s)
    e_compute = flops * 0.12 * PJ
    e = (e_compute + bytes_moved * SPEC["power"]["energy_pj"]["hbm_byte"] * PJ
         + (SPEC["power"]["budget_w"]["clock_pll"] * dyn +
            SPEC["power"]["budget_w"]["leakage"] * (0.55 if use_ntv else 1.0)) * time_s)
    return MachineResult("W2 ensemble analysis", 4, time_s, e,
                         dict(compute=e_compute,
                              hbm=bytes_moved * SPEC["power"]["energy_pj"]["hbm_byte"] * PJ,
                              static=(SPEC["power"]["budget_w"]["clock_pll"] * dyn +
                                      SPEC["power"]["budget_w"]["leakage"] *
                                      (0.55 if use_ntv else 1.0)) * time_s),
                         util=DA_EFF_ACPU, achieved_tflops=flops / time_s / 1e12,
                         power_w=e / time_s, hbm_gb=bytes_moved / 1e9, sram_gb=0.0,
                         per_kernel=[])


def simulate_dispersion(n_members=1024, cells=262144, steps=3000, flops_cell=120):
    flops = n_members * cells * steps * flops_cell
    time_s = flops / (SPEC["compute"]["peak_tflops_fp32"] * 1e12 * 0.55)
    hbm = n_members * cells * 4 * steps * 2 * 16e-12
    e = flops * 0.5 * PJ + hbm
    return MachineResult("W3 stochastic dispersion", steps, time_s, e,
                         dict(compute=flops * 0.5 * PJ, hbm=hbm),
                         util=0.55, achieved_tflops=flops / time_s / 1e12,
                         power_w=e / time_s, hbm_gb=n_members * cells * 4 * steps * 2 / 1e9,
                         sram_gb=0.0)


def simulate_tracer(cells=CELLS, tracers=8, steps=1080, flops_cell=300):
    flops = cells * tracers * steps * flops_cell
    time_s = flops / (SPEC["compute"]["peak_tflops_fp32"] * 1e12 * 0.6)
    hbm = cells * tracers * 8 * steps * 2 * 16e-12
    e = flops * 0.4 * PJ + hbm
    return MachineResult("W4 tracer transport", steps, time_s, e,
                         dict(compute=flops * 0.4 * PJ, hbm=hbm),
                         util=0.60, achieved_tflops=flops / time_s / 1e12,
                         power_w=e / time_s, hbm_gb=cells * tracers * 8 * steps * 2 / 1e9,
                         sram_gb=0.0)


# --------------------------------------------------------------------------
# GPU baseline
# --------------------------------------------------------------------------

GPU = SPEC["benchmarks"]["gpu_baseline"]


def gpu_power(compute_util, memory_util, tdp=None, idle=None):
    tdp = tdp or GPU["tdp_w"]
    idle = idle or GPU["idle_w"]
    load = max(compute_util / 0.9, memory_util / 0.9)
    load = min(1.0, max(0.05, 0.85 * load))
    return idle + (tdp - idle) * load


def gpu_forecast(stencil_eff: float = None, refetch: float = 2.5,
                 power_scale: float = 1.0) -> MachineResult:
    eff = stencil_eff or GPU["stencil_efficiency"]
    flops = TOTAL_FLOPS_PER_CELL * CELLS * MEMBERS * STEPS
    t_compute = flops / (GPU["fp32_tflops"] * 1e12 * eff)
    hbm_bytes = CELLS * MEMBERS * STATE_BYTES_PER_CELL * refetch * STEPS
    t_mem = hbm_bytes / (GPU["hbm_tbps"] * 1e12)
    time_s = max(t_compute, t_mem) * 1.06
    mem_util = min(1.0, t_mem / time_s)
    p = gpu_power(eff, mem_util) * power_scale
    return MachineResult("W1 ensemble forecast (H100)", STEPS, time_s, p * time_s,
                         dict(compute=p * time_s * 0.78, hbm=p * time_s * 0.22),
                         util=eff, achieved_tflops=flops / time_s / 1e12,
                         power_w=p, hbm_gb=hbm_bytes / 1e9, sram_gb=0.0)


def gpu_da(power_scale: float = 1.0, tensor_cores: bool = True) -> MachineResult:
    """Ensemble analysis on H100.

    Dense analysis is GEMM-shaped, so the H100 runs it on FP16 tensor cores
    (989 TFLOPS peak).  The FP32-only variant is kept for the sensitivity
    study because operational DA codes are not always tensor-core ready.
    """
    flops = TOTAL_FLOPS_PER_CELL * CELLS * MEMBERS * STEPS * DA_FLOPS_FRACTION
    if tensor_cores:
        eff, peak, load_floor = 0.35, GPU["fp16_tflops"], 0.50
    else:
        eff, peak, load_floor = DA_EFF_GPU, GPU["fp32_tflops"], 0.30
    time_s = flops / (peak * 1e12 * eff)
    load = min(1.0, max(compute_load(eff), load_floor))
    p = (GPU["idle_w"] + (GPU["tdp_w"] - GPU["idle_w"]) * load) * power_scale
    return MachineResult("W2 ensemble analysis (H100)", 4, time_s, p * time_s,
                         dict(compute=p * time_s * 0.85, hbm=p * time_s * 0.15),
                         util=eff, achieved_tflops=flops / time_s / 1e12,
                         power_w=p)


def compute_load(util):
    return 0.85 * util / 0.9


def gpu_a100_forecast(stencil_eff=0.20):
    flops = TOTAL_FLOPS_PER_CELL * CELLS * MEMBERS * STEPS
    t_compute = flops / (GPU["a100_fp32_tflops"] * 1e12 * stencil_eff)
    hbm = CELLS * MEMBERS * STATE_BYTES_PER_CELL * 2.5 * STEPS
    t_mem = hbm / (GPU["a100_hbm_tbps"] * 1e12)
    time_s = max(t_compute, t_mem) * 1.06
    p = gpu_power(stencil_eff, min(1.0, t_mem / time_s), GPU["a100_tdp_w"], 60)
    return MachineResult("W1 ensemble forecast (A100)", STEPS, time_s, p * time_s,
                         dict(compute=p * time_s * 0.78, hbm=p * time_s * 0.22),
                         util=stencil_eff, achieved_tflops=flops / time_s / 1e12,
                         power_w=p, hbm_gb=hbm / 1e9)


# --------------------------------------------------------------------------
# Thermal RC network
# --------------------------------------------------------------------------

def thermal_transient(power_trace, dt=0.05):
    t = SPEC["thermal"]
    Cj, Ch, Cb = t["c_j_j_per_k"], t["c_heatsink_j_per_k"], t["c_board_j_per_k"]
    Rjc, Rhs, Rba = t["theta_jc_c_per_w"], t["theta_heatsink_c_per_w"], t["theta_ambient_c_per_w"]
    Tamb = t["t_ambient_c"]
    Tj = Th = Tb = Tamb
    out = {"t": [], "Tj": [], "Th": [], "Tb": [], "P": []}
    for i, P in enumerate(power_trace):
        q1 = (Tj - Th) / Rjc
        q2 = (Th - Tb) / Rhs
        q3 = (Tb - Tamb) / Rba
        Tj += dt * (P - q1) / Cj
        Th += dt * (q1 - q2) / Ch
        Tb += dt * (q2 - q3) / Cb
        out["t"].append(i * dt)
        out["Tj"].append(Tj)
        out["Th"].append(Th)
        out["Tb"].append(Tb)
        out["P"].append(P)
    return out


def thermal_steady_state(power_w):
    t = SPEC["thermal"]
    return t["t_ambient_c"] + power_w * (t["theta_jc_c_per_w"] +
                                         t["theta_heatsink_c_per_w"] +
                                         t["theta_ambient_c_per_w"])


def corner_analysis(n=4000, seed=5):
    rng = np.random.default_rng(seed)
    dv = rng.normal(0, 0.006, n)
    dvt = rng.normal(0, 0.006, n)
    dtemp = rng.normal(0, 4.0, n)
    f0 = 1.96e9
    fmax = f0 * (1 + 3.0 * dv - 4.0 * dvt - 0.0015 * (dtemp - 25))
    fmax *= np.exp(rng.normal(0, 0.030, n))
    return fmax


# --------------------------------------------------------------------------
# NoC / roofline / yield / cost
# --------------------------------------------------------------------------

def noc_model():
    c = SPEC["compute"]
    return dict(per_tile_gbps=c["halo_bw_gbps_per_tile"],
                aggregate_tbps=c["tiles_total"] * c["halo_bw_gbps_per_tile"] / 1000,
                hop_latency_cycles=6, exchanges_per_step=6,
                halo_wait_cycles=6 * 46,
                halo_demand_gbps=4.2e9 / 64 * 8 / 1e9)


def roofline_points(step):
    pts = []
    for k in KERNELS:
        flops = k["flops"] * CELLS * MEMBERS
        ai_gpu = k["flops"] / (STATE_BYTES_PER_CELL * 4)
        ai_acpu = k["flops"] / (k["sram"] + 0.12 * STATE_BYTES_PER_CELL)
        pts.append(dict(kernel=k["short"], ai_gpu=ai_gpu, ai_acpu=ai_acpu, flops=flops,
                        gpu_tflops=min(GPU["fp32_tflops"] * GPU["stencil_efficiency"],
                                       GPU["hbm_tbps"] * 1e12 * ai_gpu / 1e12),
                        acpu_tflops=min(SPEC["compute"]["peak_tflops_fp32"] * step["util"],
                                        SPEC["memory"]["hbm_tbps_total"] * 1e12 * ai_gpu / 1e12)))
    return pts


def murphy_yield(area_mm2, d0=None):
    d0 = d0 or SPEC["yield_cost"]["defect_density_per_cm2"]
    ad = area_mm2 / 100.0 * d0
    if ad < 1e-6:
        return 1.0
    return ((1 - math.exp(-ad)) / ad) ** 2


def wafer_plan(area_mm2, wafer_mm=300):
    r = wafer_mm / 2
    n = math.pi * r * r / area_mm2
    edge = 1 - 2 * math.sqrt(area_mm2) / (math.pi * r)
    return int(n * edge * 0.92)


def cost_model():
    y = SPEC["yield_cost"]
    area = SPEC["die"]["compute_mm2"]
    gross = wafer_plan(area)
    yld = murphy_yield(area)
    good = gross * yld
    die_cost = y["wafer_cost_usd"] / max(good, 1)
    package = (die_cost + 2 * y["l3_die_cost_usd"] + 2 * y["hbm_stack_cost_usd"]
               + y["interposer_cost_usd"] + y["assembly_test_cost_usd"])
    return dict(gross_dies=gross, yield_=yld, good_dies=good, die_cost=die_cost,
                package_cost=package, card_cost=package + y["board_cost_usd"],
                asp=y["asp_usd"],
                margin=(y["asp_usd"] - package - y["board_cost_usd"]) / y["asp_usd"])


if __name__ == "__main__":
    st = simulate_step()
    fc = simulate_forecast()
    g = gpu_forecast()
    da = simulate_da()
    gda = gpu_da()
    print(f"step      : {st['time_s']*1e3:6.2f} ms  util_fp32={st['util']:.3f}  "
          f"P={st['power_w']:5.1f} W  E={st['energy_j']:.3f} J  "
          f"sustained={st['achieved_tflops']:.1f} TF")
    print(f"forecast  : {fc.time_s/60:6.1f} min  {fc.energy_j/1000:5.2f} kJ  "
          f"{fc.power_w:5.1f} W")
    print(f"H100      : {g.time_s/60:6.1f} min  {g.energy_j/1000:5.1f} kJ  "
          f"{g.power_w:5.0f} W")
    print(f"ratio     : {g.energy_j/fc.energy_j:5.2f}x (forecast)   "
          f"{(g.energy_j+gda.energy_j)/(fc.energy_j+da.energy_j):5.2f}x (with DA)")
    print(f"energy split: {[(k, round(v/fc.energy_j*100,1)) for k,v in fc.energy_breakdown.items()]}")
