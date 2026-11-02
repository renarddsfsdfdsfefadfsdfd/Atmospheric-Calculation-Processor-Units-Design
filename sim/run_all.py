"""Run every ACPU-1 pre-silicon experiment and emit the report's data products.

Outputs (all under results/):
    results.json          full structured results (used by the checker)
    numbers.tex           LaTeX macros quoted in the report
    summary.md            human-readable digest
    *.csv                 figure inputs for the R plotting scripts

Usage:  python3 sim/run_all.py
"""

from __future__ import annotations

import csv
import json
import os
import time

import numpy as np

import machine as M
import numerics as N

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "results")
os.makedirs(OUT, exist_ok=True)


def write_csv(name, rows, fields):
    with open(os.path.join(OUT, name), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def pct(x, nd=1):
    return f"{100 * x:.{nd}f}"


def main():
    t0 = time.time()
    R = {}

    # ------------------------------------------------------------------
    # 1. Reference chip results
    # ------------------------------------------------------------------
    st = M.simulate_step()
    fc = M.simulate_forecast()
    da = M.simulate_da()
    gf = M.gpu_forecast()
    gda = M.gpu_da()
    gda32 = M.gpu_da(tensor_cores=False)
    a100 = M.gpu_a100_forecast()
    disp = M.simulate_dispersion()
    tracer = M.simulate_tracer()

    day_a = fc.energy_j + 4 * da.energy_j
    day_g = gf.energy_j + 4 * gda.energy_j
    day_ta = fc.time_s + 4 * da.time_s
    day_tg = gf.time_s + 4 * gda.time_s

    # idealised GPU: 100% of FP32 peak, 350 W board power
    ideal_t = (M.TOTAL_FLOPS_PER_CELL * M.CELLS * M.MEMBERS * M.STEPS
               / (M.GPU["fp32_tflops"] * 1e12))
    ideal_e = ideal_t * 350.0 + 4 * gda.energy_j
    R["baseline"] = dict(
        step_ms=st["time_s"] * 1e3, util=st["util"], eff_micro=st["eff_micro"],
        sustained_tflops=st["achieved_tflops"], power_w=st["power_w"],
        step_energy_j=st["energy_j"], hbm_gb_per_step=st["hbm_gb"],
        hbm_fraction=st["energy"]["hbm"] / st["energy_j"],
        compute_fraction=st["energy"]["compute"] / st["energy_j"],
        forecast=dict(time_s=fc.time_s, energy_j=fc.energy_j, power_w=fc.power_w,
                      tflops=fc.achieved_tflops, hbm_gb=fc.hbm_gb),
        da=dict(time_s=da.time_s, energy_j=da.energy_j, power_w=da.power_w,
                tflops=da.achieved_tflops),
        gpu=dict(time_s=gf.time_s, energy_j=gf.energy_j, power_w=gf.power_w,
                 tflops=gf.achieved_tflops, hbm_gb=gf.hbm_gb),
        gpu_da=dict(time_s=gda.time_s, energy_j=gda.energy_j, power_w=gda.power_w,
                    tflops=gda.achieved_tflops),
        gpu_da_fp32=dict(time_s=gda32.time_s, energy_j=gda32.energy_j, power_w=gda32.power_w),
        a100=dict(time_s=a100.time_s, energy_j=a100.energy_j, power_w=a100.power_w),
        day=dict(acpu_time_s=day_ta, acpu_energy_j=day_a,
                 gpu_time_s=day_tg, gpu_energy_j=day_g,
                 ratio=day_g / day_a, time_ratio=day_tg / day_ta),
        forecast_ratio=gf.energy_j / fc.energy_j,
        da_ratio=gda.energy_j / da.energy_j,
        ideal_gpu=dict(time_s=ideal_t, energy_j=ideal_e,
                       ratio=ideal_e / day_a),
        dispersion=dict(time_s=disp.time_s, energy_j=disp.energy_j,
                        tflops=disp.achieved_tflops),
        tracer=dict(time_s=tracer.time_s, energy_j=tracer.energy_j,
                    tflops=tracer.achieved_tflops),
        t_resource=st["t_resource"],
    )

    # ------------------------------------------------------------------
    # 2. Ablation study
    # ------------------------------------------------------------------
    ablations = []
    variants = [
        ("full design", {}),
        ("adaptive precision off", dict(use_precision=False)),
        ("halo fabric off", dict(use_halo_fabric=False)),
        ("grid-point lanes", dict(lanes_are_members=False)),
        ("halo + precision off", dict(use_precision=False, use_halo_fabric=False)),
        ("all features off", dict(use_precision=False, use_halo_fabric=False,
                                  lanes_are_members=False)),
    ]
    for name, kw in variants:
        s = M.simulate_step(**kw)
        f = M.simulate_forecast(**kw)
        ablations.append(dict(variant=name, step_ms=s["time_s"] * 1e3,
                              forecast_time_s=f.time_s, forecast_kj=f.energy_j / 1000,
                              power_w=s["power_w"], util=s["util"],
                              tflops=s["achieved_tflops"]))
    write_csv("ablations.csv", ablations, list(ablations[0].keys()))
    R["ablations"] = ablations
    eff_fc = M.simulate_forecast(use_ntv=True)
    eff_da = M.simulate_da(use_ntv=True)
    write_csv("efficiency.csv", [
        dict(mode="performance", time_s=fc.time_s, kj=fc.energy_j / 1000, power_w=fc.power_w),
        dict(mode="efficiency", time_s=eff_fc.time_s, kj=eff_fc.energy_j / 1000,
             power_w=eff_fc.power_w),
        dict(mode="H100", time_s=gf.time_s, kj=gf.energy_j / 1000, power_w=gf.power_w),
    ], ["mode", "time_s", "kj", "power_w"])
    R["efficiency_mode"] = dict(
        forecast_time_s=eff_fc.time_s, forecast_kj=eff_fc.energy_j / 1000,
        forecast_w=eff_fc.power_w, da_time_s=eff_da.time_s,
        da_kj=eff_da.energy_j / 1000,
        day_time_s=eff_fc.time_s + 4 * eff_da.time_s,
        day_kj=(eff_fc.energy_j + 4 * eff_da.energy_j) / 1000,
        day_ratio=(gf.energy_j + 4 * gda.energy_j) / (eff_fc.energy_j + 4 * eff_da.energy_j))

    # attributed factors (energy of the full design vs each disabled design)
    full = ablations[0]["forecast_kj"]
    R["attribution"] = [
        dict(feature=v["variant"], energy_kj=v["forecast_kj"],
             savings_x=v["forecast_kj"] / full)
        for v in ablations[1:]
    ]

    # ------------------------------------------------------------------
    # 3. Sensitivity / Monte-Carlo
    # ------------------------------------------------------------------
    rng = np.random.default_rng(42)
    samples = []
    for i in range(300):
        gpu_eff = float(np.clip(rng.normal(0.30, 0.09), 0.15, 0.60))
        gpu_pw = float(np.clip(rng.normal(1.0, 0.12), 0.7, 1.3))
        hbm_pj = float(np.clip(rng.normal(16.0, 3.0), 9.0, 24.0))
        clock = float(np.clip(rng.normal(1.8, 0.08), 1.55, 2.05))
        cover = float(np.clip(rng.normal(0.58, 0.12), 0.30, 0.80))
        g = M.gpu_forecast(stencil_eff=gpu_eff, power_scale=gpu_pw)
        gd = M.gpu_da(power_scale=gpu_pw)
        s = M.simulate_step(fp16_coverage=cover, clock_ghz=clock)
        f = M.simulate_forecast(fp16_coverage=cover, clock_ghz=clock)
        d = M.simulate_da(clock_ghz=clock)
        # HBM energy perturbation: scale the memory term of both designs
        ea = (f.energy_j + 4 * d.energy_j)
        eg = (g.energy_j + 4 * gd.energy_j)
        mem_frac_a = f.energy_j * (s["energy"]["hbm"] / s["energy_j"]) / f.energy_j
        ea *= (1 - mem_frac_a) + mem_frac_a * hbm_pj / 16.0
        mem_frac_g = 0.25
        eg *= (1 - mem_frac_g) + mem_frac_g * hbm_pj / 16.0
        samples.append(dict(gpu_eff=gpu_eff, gpu_power_scale=gpu_pw, hbm_pj=hbm_pj,
                            clock_ghz=clock, fp16_coverage=cover,
                            acpu_kj=ea / 1000, gpu_kj=eg / 1000, ratio=eg / ea))
    ratios = np.array([s["ratio"] for s in samples])
    write_csv("sensitivity.csv", samples, list(samples[0].keys()))
    R["sensitivity"] = dict(median=float(np.median(ratios)),
                            p05=float(np.percentile(ratios, 5)),
                            p95=float(np.percentile(ratios, 95)),
                            samples=samples)

    # ------------------------------------------------------------------
    # 4. Thermal
    # ------------------------------------------------------------------
    trace = [6.0] * 400 + [65.0] * 3600 + [6.0] * 1200
    th = M.thermal_transient(trace, dt=0.05)
    R["thermal"] = dict(steady_65w=M.thermal_steady_state(65.0),
                        steady_43w=M.thermal_steady_state(43.4),
                        peak=float(max(th["Tj"])), ambient=M.SPEC["thermal"]["t_ambient_c"])
    write_csv("thermal.csv",
              [dict(t=t, Tj=tj, Th=thh, Tb=tb, P=p) for t, tj, thh, tb, p in
               zip(th["t"], th["Tj"], th["Th"], th["Tb"], th["P"])],
              ["t", "Tj", "Th", "Tb", "P"])

    # ------------------------------------------------------------------
    # 5. Corners / yield / cost / reliability
    # ------------------------------------------------------------------
    fmax = M.corner_analysis()
    R["corners"] = dict(median_ghz=float(np.median(fmax) / 1e9),
                        p05_ghz=float(np.percentile(fmax, 5) / 1e9),
                        p95_ghz=float(np.percentile(fmax, 95) / 1e9),
                        yield_1p8=float(np.mean(fmax > 1.8e9)),
                        yield_2p0=float(np.mean(fmax > 2.0e9)),
                        yield_1p6=float(np.mean(fmax > 1.6e9)))
    hist, edges = np.histogram(fmax / 1e9, bins=40)
    write_csv("corners.csv",
              [dict(fmax=(edges[i] + edges[i + 1]) / 2, count=int(hist[i]))
               for i in range(len(hist))], ["fmax", "count"])

    areas = np.linspace(40, 700, 40)
    yields = [M.murphy_yield(a) for a in areas]
    write_csv("yield.csv", [dict(area=a, yield_=y) for a, y in zip(areas, yields)],
              ["area", "yield_"])
    cost = M.cost_model()
    write_csv("cost.csv", [
        dict(item="compute die", usd=cost["die_cost"]),
        dict(item="L3 dies (2)", usd=2 * M.SPEC["yield_cost"]["l3_die_cost_usd"]),
        dict(item="HBM3E (2 stacks)", usd=2 * M.SPEC["yield_cost"]["hbm_stack_cost_usd"]),
        dict(item="interposer + assembly", usd=M.SPEC["yield_cost"]["interposer_cost_usd"]),
        dict(item="test + burn-in", usd=M.SPEC["yield_cost"]["assembly_test_cost_usd"]),
        dict(item="PCB + cooling", usd=M.SPEC["yield_cost"]["board_cost_usd"]),
    ], ["item", "usd"])
    R["cost"] = cost
    R["yield"] = dict(area=M.SPEC["die"]["compute_mm2"],
                      yield_=M.murphy_yield(M.SPEC["die"]["compute_mm2"]),
                      gross_dies=cost["gross_dies"], good_dies=cost["good_dies"])

    # FIT / ECC
    sram_mb = M.SPEC["memory"]["l3_total_mb"] + M.SPEC["memory"]["l2_total_mb"] + \
        M.SPEC["compute"]["tiles_total"] * M.SPEC["compute"]["tile_sram_kb"] / 1024
    bits = sram_mb * 8 * 1024 * 1024
    ser_bit = 2e-3          # FIT/bit at ground level, 3 nm SRAM
    fit_corr = bits * ser_bit
    fit_uncorr = fit_corr * 1e-4
    R["reliability"] = dict(sram_mb=sram_mb, bits=bits, ser_fit_per_bit=ser_bit,
                            correctable_fit=fit_corr, uncorrectable_fit=fit_uncorr,
                            scrubs_per_day=fit_corr / 1e9 * 24)

    # ------------------------------------------------------------------
    # 6. NoC / roofline / memory hierarchy
    # ------------------------------------------------------------------
    write_csv("resources.csv",
              [dict(resource=k, time_s=v) for k, v in st["t_resource"].items()]
              + [dict(resource="compute", time_s=st["t_compute"])],
              ["resource", "time_s"])
    write_csv("step_budget.csv", [
        dict(what="flops", value=st["flops"]),
        dict(what="ideal_cycles", value=st["ideal_cycles"]),
        dict(what="time_s", value=st["time_s"]),
        dict(what="energy_j", value=st["energy_j"]),
        dict(what="power_w", value=st["power_w"]),
        dict(what="util", value=st["util"]),
        dict(what="eff_micro", value=st["eff_micro"]),
        dict(what="hbm_gb", value=st["hbm_gb"]),
        dict(what="sram_gb", value=st["sram_gb"]),
    ], ["what", "value"])
    R["noc"] = M.noc_model()
    roof = M.roofline_points(st)
    write_csv("roofline.csv", [dict(kernel=p["kernel"], ai_gpu=p["ai_gpu"],
                                    ai_acpu=p["ai_acpu"], flops=p["flops"],
                                    gpu_tflops=p["gpu_tflops"], acpu_tflops=p["acpu_tflops"])
                               for p in roof],
              ["kernel", "ai_gpu", "ai_acpu", "flops", "gpu_tflops", "acpu_tflops"])
    R["roofline"] = roof

    # ------------------------------------------------------------------
    # 7. Per-kernel tables
    # ------------------------------------------------------------------
    ker = []
    tot_cycles = sum(k["cycles"] for k in fc.per_kernel)
    tot_energy = sum(k["energy"] for k in fc.per_kernel)
    for k in fc.per_kernel:
        ker.append(dict(kernel=k["kernel"], name=k["name"], phase=k["phase"],
                        flops=k["flops"], gflop=k["flops"] / 1e9,
                        cycles=k["cycles"], cycle_share=k["cycles"] / tot_cycles,
                        efficiency=k["efficiency"],
                        energy_j=k["energy"], energy_share=k["energy"] / tot_energy,
                        sram_gb=k["sram_bytes"] / 1e9))
    write_csv("kernels.csv", ker, list(ker[0].keys()))
    R["kernels"] = ker
    R["kernel_totals"] = dict(flops=sum(k["flops"] for k in ker),
                              cycles=tot_cycles,
                              energy_j=tot_energy,
                              flops_per_cell=M.TOTAL_FLOPS_PER_CELL,
                              sfu_per_cell=M.TOTAL_SFU_PER_CELL,
                              sram_bytes_per_cell=M.TOTAL_SRAM_BYTES)

    # ------------------------------------------------------------------
    # 8. Energy breakdown and workload comparison
    # ------------------------------------------------------------------
    eb = fc.energy_breakdown
    total = sum(eb.values())
    write_csv("energy.csv",
              [dict(component=k, joule=v, share=v / total) for k, v in eb.items()],
              ["component", "joule", "share"])
    R["energy_breakdown"] = {k: v / total for k, v in eb.items()}

    wl = []
    for label, res, mach in [("W1 ensemble forecast", fc, "ACPU"),
                             ("W1 ensemble forecast", gf, "H100"),
                             ("W2 ensemble analysis", da, "ACPU"),
                             ("W2 ensemble analysis", gda, "H100"),
                             ("W1 ensemble forecast", a100, "A100"),
                             ("W3 stochastic dispersion", disp, "ACPU"),
                             ("W4 tracer transport", tracer, "ACPU")]:
        if label == "W1 ensemble forecast":
            fl = M.TOTAL_FLOPS_PER_CELL * M.CELLS * M.MEMBERS * M.STEPS
        elif label == "W2 ensemble analysis":
            fl = M.TOTAL_FLOPS_PER_CELL * M.CELLS * M.MEMBERS * M.STEPS * M.DA_FLOPS_FRACTION
        elif label == "W3 stochastic dispersion":
            fl = 1024 * 262144 * 3000 * 120
        else:
            fl = M.CELLS * 8 * 1080 * 300
        wl.append(dict(workload=label, machine=mach, time_s=res.time_s,
                       energy_kj=res.energy_j / 1000, power_w=res.power_w,
                       tflops=res.achieved_tflops, util=res.util, flops=fl,
                       pj_per_flop=res.energy_j / fl * 1e12))
    write_csv("workloads.csv", wl, ["workload", "machine", "time_s", "energy_kj",
                                    "power_w", "tflops", "util", "flops", "pj_per_flop"])
    R["workloads"] = wl

    # ------------------------------------------------------------------
    # 9. Numerical accuracy experiments
    # ------------------------------------------------------------------
    modes = ["fp64", "fp32", "fp16", "bf16", "fp8", "adaptive"]
    acc = {}
    rows = []
    for m in modes:
        r = N.run_l96_experiment(m, n_seeds=4, forecasts=6, leads=60)
        acc[m] = {k: v for k, v in r.items() if k != "rmse_std"}
        for lead, rmse, spread in zip(r["leads"], r["rmse"], r["spread"]):
            rows.append(dict(mode=m, lead=lead, lead_hours=lead * 4 * 0.01 * 5 * 24,
                             rmse=rmse, spread=spread))
    write_csv("accuracy.csv", rows, ["mode", "lead", "lead_hours", "rmse", "spread"])
    R["accuracy"] = acc

    # precision-governor operating curve
    policy = []
    for thr in (0.05, 0.10, 0.20, 0.30, 0.50, 0.80):
        r = N.run_l96_experiment("adaptive", n_seeds=3, forecasts=4, leads=60,
                                 spread_thresh=thr)
        policy.append(dict(threshold=thr, fp16_fraction=r["fp16_fraction"],
                           energy_weight=r["energy_weight"],
                           rmse_day5=r["rmse"][25], rmse_day10=r["rmse"][50],
                           analysis_rmse=r["analysis_rmse"]))
    write_csv("policy.csv", policy, ["threshold", "fp16_fraction", "energy_weight",
                                     "rmse_day5", "rmse_day10", "analysis_rmse"])
    R["policy"] = policy

    # spectrum / doubling / conservation / kahan
    spec = N.lyapunov_spectrum()
    write_csv("spectrum.csv", [dict(index=i, exponent=float(e)) for i, e in enumerate(spec)],
              ["index", "exponent"])
    R["spectrum"] = dict(top=float(spec[0]), top_per_day=float(spec[0] / N.DAYS_PER_UNIT),
                         mean=float(spec.mean()),
                         n_positive=int((spec > 0).sum()),
                         exponents=[float(x) for x in spec])

    dbl = N.error_doubling_time()
    R["doubling"] = dict(tau_days=dbl["tau_days"], tau_units=dbl["tau_units"])
    write_csv("doubling.csv", [dict(t=i * 0.01, error=e) for i, e in enumerate(dbl["growth"])],
              ["t", "error"])

    drift = []
    for fmt in ("fp64", "fp32"):
        d = N.advection_1d(fmt=fmt, nsteps=1200)
        R[f"drift_{fmt}"] = d["final"]
        for i, v in enumerate(d["drift"]):
            drift.append(dict(step=i, drift=v, fmt=fmt))
    write_csv("drift.csv", drift, ["step", "drift", "fmt"])
    R["kahan"] = N.kahan_study()
    write_csv("kahan.csv", [dict(metric=k, value=v) for k, v in R["kahan"].items()],
              ["metric", "value"])

    # ------------------------------------------------------------------
    # 10. LaTeX number macros
    # ------------------------------------------------------------------
    macros = {
        "PeakFP": f"{M.SPEC['compute']['peak_tflops_fp32']:.1f}",
        "PeakFPsixteen": f"{M.SPEC['compute']['peak_tflops_fp16']:.1f}",
        "SustainedTF": f"{st['achieved_tflops']:.1f}",
        "UtilFP": pct(st["util"]),
        "StepMs": f"{st['time_s']*1e3:.1f}",
        "ForecastMin": f"{fc.time_s/60:.2f}",
        "ForecastKJ": f"{fc.energy_j/1000:.2f}",
        "ForecastW": f"{fc.power_w:.1f}",
        "GpuMin": f"{gf.time_s/60:.2f}",
        "GpuKJ": f"{gf.energy_j/1000:.1f}",
        "GpuW": f"{gf.power_w:.0f}",
        "RatioForecast": f"{R['baseline']['forecast_ratio']:.1f}",
        "DaS": f"{da.time_s:.1f}",
        "DaKJ": f"{da.energy_j/1000:.2f}",
        "GpuDaS": f"{gda.time_s:.1f}",
        "GpuDaKJ": f"{gda.energy_j/1000:.2f}",
        "RatioDa": f"{R['baseline']['da_ratio']:.1f}",
        "DayTimeA": f"{day_ta:.0f}",
        "DayTimeG": f"{day_tg:.0f}",
        "DayKJA": f"{day_a/1000:.2f}",
        "DayKJG": f"{day_g/1000:.1f}",
        "RatioDay": f"{R['baseline']['day']['ratio']:.1f}",
        "RatioDayLo": f"{R['sensitivity']['p05']:.1f}",
        "RatioDayHi": f"{R['sensitivity']['p95']:.1f}",
        "RatioIdeal": f"{R['baseline']['ideal_gpu']['ratio']:.1f}",
        "HbmShare": pct(st["energy"]["hbm"] / st["energy_j"], 0),
        "ComputeShare": pct(st["energy"]["compute"] / st["energy_j"], 0),
        "StaticShare": pct(st["energy"]["static"] / st["energy_j"], 0),
        "TjSteady": f"{R['thermal']['steady_65w']:.1f}",
        "TjPeak": f"{R['thermal']['peak']:.1f}",
        "YieldDie": pct(R["yield"]["yield_"], 1),
        "DieCost": f"{cost['die_cost']:.0f}",
        "PackageCost": f"{cost['package_cost']:.0f}",
        "CardCost": f"{cost['card_cost']:.0f}",
        "FmaxMed": f"{R['corners']['median_ghz']:.2f}",
        "YieldClock": pct(R["corners"]["yield_1p8"], 1),
        "LyapTop": f"{R['spectrum']['top_per_day']:.2f}",
        "Doubling": f"{R['doubling']['tau_days']:.2f}",
        "AnalRMSE": f"{acc['fp64']['analysis_rmse']:.2f}",
        "RMSEdayFive": f"{acc['fp64']['rmse'][25]:.2f}",
        "RMSEfpSixteen": f"{acc['fp16']['rmse'][25]:.2f}",
        "FpSixteenFrac": pct(acc["adaptive"]["fp16_fraction"], 0),
        "EccFit": f"{R['reliability']['correctable_fit']/1e6:.1f}",
    }
    lines = ["% auto-generated by sim/run_all.py -- do not edit"]
    for k, v in macros.items():
        lines.append(f"\\newcommand{{\\AC{k}}}{{{v}}}")
    with open(os.path.join(OUT, "numbers.tex"), "w") as fh:
        fh.write("\n".join(lines) + "\n")

    R["macros"] = macros
    with open(os.path.join(OUT, "results.json"), "w") as fh:
        json.dump(R, fh, indent=1, default=float)

    # ------------------------------------------------------------------
    # 11. Digest
    # ------------------------------------------------------------------
    with open(os.path.join(OUT, "summary.md"), "w") as fh:
        fh.write("# ACPU-1 model digest\n\n")
        fh.write(f"- sustained {st['achieved_tflops']:.1f} TFLOPS, "
                 f"util {pct(st['util'])} of FP32 peak, {st['power_w']:.1f} W per step\n")
        fh.write(f"- 24 h / 64-member forecast: {fc.time_s:.0f} s, "
                 f"{fc.energy_j/1000:.2f} kJ, {fc.power_w:.1f} W\n")
        fh.write(f"- H100 same workload: {gf.time_s:.0f} s, {gf.energy_j/1000:.1f} kJ, "
                 f"{gf.power_w:.0f} W\n")
        fh.write(f"- forecast energy ratio {R['baseline']['forecast_ratio']:.1f}x\n")
        fh.write(f"- forecast+4 analyses: ACPU {day_ta:.0f} s / {day_a/1000:.2f} kJ vs "
                 f"H100 {day_tg:.0f} s / {day_g/1000:.1f} kJ "
                 f"({R['baseline']['day']['ratio']:.1f}x)\n")
        fh.write(f"- sensitivity ratio p05/median/p95: {R['sensitivity']['p05']:.1f} / "
                 f"{R['sensitivity']['median']:.1f} / {R['sensitivity']['p95']:.1f}\n")
        fh.write(f"- analysis RMSE fp64 {acc['fp64']['analysis_rmse']:.3f}, "
                 f"fp16 {acc['fp16']['analysis_rmse']:.3f}, "
                 f"fp8 {acc['fp8']['analysis_rmse']:.3f}\n")
        fh.write(f"- Lyapunov top {R['spectrum']['top_per_day']:.2f} /day, "
                 f"error doubling {R['doubling']['tau_days']:.2f} days\n")
        fh.write(f"- die yield {pct(R['yield']['yield_'])} on {M.SPEC['die']['compute_mm2']} mm2, "
                 f"die ${cost['die_cost']:.0f}, card BOM ${cost['card_cost']:.0f}\n")

    print(open(os.path.join(OUT, "summary.md")).read())
    print(f"done in {time.time()-t0:.1f}s -> {OUT}")


if __name__ == "__main__":
    main()
