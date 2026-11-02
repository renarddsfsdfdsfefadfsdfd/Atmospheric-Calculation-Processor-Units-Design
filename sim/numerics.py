"""ACPU-1 numerical experiments.

Real computations behind the report's accuracy claims:

  * Lorenz-96 ensemble forecasting in float64 / float32 / float16 /
    adaptive precision, with a stochastic EnKF analysis cycle.
  * Finite-time Lyapunov spectrum from the tangent-linear model.
  * Error-doubling time from twin trajectories.
  * Conservative tracer transport and mass-budget audit.
  * Kahan-compensated accumulation study.

All experiments are deterministic given their seeds, so every number in the
report can be regenerated with `python3 sim/run_all.py`.
"""

from __future__ import annotations

import numpy as np

F_L96 = 8.0
N_L96 = 40
DAYS_PER_UNIT = 5.0   # 1 Lorenz-96 time unit ~ 5 days (F = 8)

# energy per floating-point op, relative to fp32 FMA (from spec energy table)
REL_ENERGY = {"fp64": 2.10, "fp32": 1.00, "fp16": 0.571, "bf16": 0.62, "fp8": 0.333}


def l96_rhs(x, F=F_L96):
    return (np.roll(x, -1, axis=0) - np.roll(x, 2, axis=0)) * np.roll(x, 1, axis=0) - x + F


def rk4_step(x, dt, F=F_L96):
    k1 = l96_rhs(x, F)
    k2 = l96_rhs(x + 0.5 * dt * k1, F)
    k3 = l96_rhs(x + 0.5 * dt * k2, F)
    k4 = l96_rhs(x + dt * k3, F)
    return x + dt / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4)


# --------------------------------------------------------------------------
# precision emulation
# --------------------------------------------------------------------------

def quantize(a, fmt):
    if fmt == "fp64":
        return np.asarray(a, dtype=np.float64)
    if fmt == "fp32":
        return np.asarray(a, dtype=np.float32).astype(np.float64)
    if fmt == "fp16":
        return np.asarray(a, dtype=np.float16).astype(np.float64)
    if fmt == "fp8":
        x = np.asarray(a, dtype=np.float64)
        sign = np.where(x < 0, -1.0, 1.0)
        ax = np.abs(x)
        out = np.zeros_like(x)
        nz = ax > 1e-30
        e = np.clip(np.floor(np.log2(np.maximum(ax, 1e-30))), -6, 8)
        base = 2.0 ** e
        m = np.round((ax / base - 1.0) * 8.0) / 8.0
        val = base * (1.0 + m)
        val = np.where(m >= 1.0, base * 2.0, val)
        out[nz] = sign[nz] * val[nz]
        return out
    if fmt == "bf16":
        x = np.asarray(a, dtype=np.float32)
        u = x.view(np.uint32).copy()
        u = (u + 0x8000) & 0xFFFF0000
        return u.view(np.float32).astype(np.float64)
    raise ValueError(fmt)


def rk4_batch(X, dt, fmt="fp64", mask=None, F=F_L96):
    """RK4 for an ensemble X (n_vars, n_members), optional per-variable
    precision mask (True -> fp16)."""
    def q(a):
        if fmt != "adaptive":
            return quantize(a, fmt)
        out = quantize(a, "fp32")
        if mask is not None and mask.any():
            out[mask] = quantize(a[mask], "fp16")
        return out

    k1 = q(l96_rhs(X, F))
    k2 = q(l96_rhs(q(X + q(0.5 * dt * k1)), F))
    k3 = q(l96_rhs(q(X + q(0.5 * dt * k2)), F))
    k4 = q(l96_rhs(q(X + q(dt * k3)), F))
    return q(X + q(dt / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4)))


# --------------------------------------------------------------------------
# Lyapunov spectrum / doubling time
# --------------------------------------------------------------------------

def tangent_step(x, dt, F=F_L96, eps=1e-7):
    base = rk4_step(x, dt, F)
    J = np.empty((x.size, x.size))
    for j in range(x.size):
        xp = x.copy()
        xp[j] += eps
        J[:, j] = (rk4_step(xp, dt, F) - base) / eps
    return J


def lyapunov_spectrum(n_steps=3000, dt=0.01, seed=7, n_exp=12):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=N_L96) + F_L96
    for _ in range(1500):
        x = rk4_step(x, dt)
    Q = np.eye(N_L96)[:, :n_exp]
    acc = np.zeros(n_exp)
    for _ in range(n_steps):
        x = rk4_step(x, dt)
        Q = tangent_step(x, dt) @ Q
        Q, R = np.linalg.qr(Q)
        acc += np.log(np.maximum(np.abs(np.diag(R)), 1e-300))
    return np.sort(acc / (n_steps * dt))[::-1]


def error_doubling_time(dt=0.01, seed=3, n_steps=4000):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=N_L96) + F_L96
    for _ in range(1000):
        x = rk4_step(x, dt)
    y = x + 1e-6 * rng.normal(size=N_L96)
    d = np.empty(n_steps)
    for i in range(n_steps):
        x = rk4_step(x, dt)
        y = rk4_step(y, dt)
        d[i] = np.linalg.norm(y - x)
    # exponential growth region: from 10x initial error to 10% of saturation
    lo = np.argmax(d > 10 * d[0])
    hi = np.argmax(d > 0.1 * np.median(d[-200:]))
    t = (hi - lo) * dt
    tau_units = float(t / np.log2(np.maximum(d[hi] / d[lo], 1.01)))
    return dict(tau_units=tau_units, tau_days=tau_units * DAYS_PER_UNIT,
                growth=d.tolist(), lo=int(lo), hi=int(hi))


# --------------------------------------------------------------------------
# EnKF
# --------------------------------------------------------------------------

def enkf(X, y_obs, H, R_var, rng, inflate=1.10):
    k, m = X.shape[1], H.shape[0]
    Xm = X - X.mean(axis=1, keepdims=True)
    Y = H @ Xm
    P_yy = Y @ Y.T / (k - 1) + R_var * np.eye(m)
    P_xy = Xm @ Y.T / (k - 1)
    K = np.linalg.solve(P_yy, P_xy.T).T
    y_pert = y_obs[:, None] + rng.normal(0.0, np.sqrt(R_var), size=(m, k))
    Xa = X + K @ (y_pert - H @ X)
    Xm = Xa.mean(axis=1, keepdims=True)
    return Xm + inflate * (Xa - Xm)


def run_l96_experiment(fmt="fp64", n_members=32, n_obs=20, n_seeds=4,
                       spinup=200, forecasts=6, leads=100, obs_every=4,
                       dt=0.01, obs_sigma=0.5, spread_thresh=0.30,
                       seed0=100, between=12):
    """Cycled analysis + independent ensemble forecasts.

    The analysis cycle (obs every `obs_every` steps) is spun up first; then
    `forecasts` independent ensemble forecasts are launched, each verified
    against the truth trajectory at every lead time.  No assimilation is
    performed during a forecast, which is how operational skill is measured.
    """
    rmse = np.zeros((n_seeds, leads))
    spread = np.zeros((n_seeds, leads))
    analysed = np.zeros(n_seeds)
    fp16_frac, energy_w = [], []

    for s in range(n_seeds):
        rng = np.random.default_rng(seed0 + s)
        truth = rng.normal(size=N_L96) + F_L96
        for _ in range(2000):
            truth = rk4_step(truth, dt)
        X = truth[:, None] + rng.normal(0.0, 0.6, size=(N_L96, n_members))
        obs_idx = np.sort(rng.choice(N_L96, n_obs, replace=False))
        H = np.zeros((n_obs, N_L96))
        H[np.arange(n_obs), obs_idx] = 1.0

        def step_many(Xin, mask=None):
            for _ in range(obs_every):
                Xin = rk4_batch(Xin, dt, fmt, mask)
            return Xin

        def analyse(Xin):
            y = truth[obs_idx] + rng.normal(0.0, obs_sigma, n_obs)
            return enkf(Xin, y, H, obs_sigma ** 2, rng)

        # --- analysis spin-up -------------------------------------------
        for _ in range(spinup):
            for _ in range(obs_every):
                truth = rk4_step(truth, dt)
            X = analyse(step_many(X))
            analysed[s] += (float(np.sqrt(np.mean((X.mean(axis=1) - truth) ** 2))) -
                            analysed[s]) / 1.0 if False else 0.0

        # measure analysis skill over 20 cycles
        aerr = []
        for _ in range(20):
            for _ in range(obs_every):
                truth = rk4_step(truth, dt)
            X = analyse(step_many(X))
            aerr.append(float(np.sqrt(np.mean((X.mean(axis=1) - truth) ** 2))))
        analysed[s] = float(np.mean(aerr))

        # --- independent forecasts --------------------------------------
        for k in range(forecasts):
            Xa, ta = X.copy(), truth.copy()
            Xf, tf = Xa.copy(), ta.copy()
            for L in range(leads):
                if fmt == "adaptive":
                    sp = Xf.std(axis=1, ddof=1)
                    mask = sp > spread_thresh
                    fp16_frac.append(float(mask.mean()))
                    energy_w.append(float(np.mean(np.where(mask, 0.571, 1.0))))
                else:
                    mask = None
                Xf = step_many(Xf, mask)
                for _ in range(obs_every):
                    tf = rk4_step(tf, dt)
                r = float(np.sqrt(np.mean((Xf.mean(axis=1) - tf) ** 2)))
                sp = float(np.sqrt(np.mean(Xf.var(axis=1, ddof=1))))
                rmse[s, L] += (r - rmse[s, L]) / (k + 1)
                spread[s, L] += (sp - spread[s, L]) / (k + 1)
            # walk the analysis cycle forward for the next forecast
            X, truth = Xa, ta
            for _ in range(between):
                for _ in range(obs_every):
                    truth = rk4_step(truth, dt)
                X = analyse(step_many(X))

    return dict(fmt=fmt, leads=list(range(leads)),
                rmse=np.mean(rmse, axis=0).tolist(),
                rmse_std=np.std(rmse, axis=0).tolist(),
                spread=np.mean(spread, axis=0).tolist(),
                analysis_rmse=float(np.mean(analysed)),
                fp16_fraction=float(np.mean(fp16_frac)) if fp16_frac else 0.0,
                energy_weight=float(np.mean(energy_w)) if energy_w else 1.0)


# --------------------------------------------------------------------------
# Conservation / accumulation
# --------------------------------------------------------------------------

def advection_1d(nx=512, nsteps=1200, cfl=0.4, fmt="fp64", scheme="upwind", seed=3):
    x = np.linspace(0, 1, nx, endpoint=False)
    q = (np.exp(-((x - 0.25) ** 2) / (2 * 0.03 ** 2))
         + 0.7 * ((x > 0.55) & (x < 0.62)).astype(float))
    q = quantize(q / q.sum(), fmt)
    drift = np.empty(nsteps)
    for n in range(nsteps):
        if scheme == "upwind":
            qn = q - cfl * (q - np.roll(q, 1))
        else:
            qn = q - 0.5 * cfl * (np.roll(q, -1) - np.roll(q, 1))
        q = quantize(qn, fmt)
        drift[n] = abs(q.sum() - 1.0)
    return dict(fmt=fmt, scheme=scheme, drift=drift.tolist(),
                final=float(drift[-1]), peak=float(q.max()))


def kahan_study(n=100000, seed=11):
    rng = np.random.default_rng(seed)
    vals = rng.normal(0.0, 1.0, n).astype(np.float32)
    naive = np.float32(0.0)
    for v in vals:
        naive = np.float32(naive + v)
    s = np.float32(0.0)
    c = np.float32(0.0)
    for v in vals:
        y = np.float32(v - c)
        t = np.float32(s + y)
        c = np.float32((t - s) - y)
        s = t
    exact = float(np.sum(vals.astype(np.float64)))
    return dict(n=n, exact=exact, naive=float(naive), kahan=float(s),
                naive_err=abs(float(naive) - exact), kahan_err=abs(float(s) - exact))


if __name__ == "__main__":
    import time
    t0 = time.time()
    print("spectrum", np.round(lyapunov_spectrum(), 3)[:6])
    print("doubling", error_doubling_time()["tau_days"])
    for m in ("fp64", "fp32", "fp16", "bf16", "adaptive"):
        t = time.time()
        r = run_l96_experiment(m)
        print(m, "rmse@10", round(r["rmse"][-1], 3), "fp16frac",
              round(r["fp16_fraction"], 3), f"{time.time()-t:.1f}s")
    print("total", time.time() - t0)
