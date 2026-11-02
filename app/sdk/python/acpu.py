"""acpu.py - dependency-free Python client for the ACPU Studio device service.

The ACPU-1 "Tempest" is a virtual accelerator that lives inside the ACPU Studio
desktop app. The app exposes it on the loopback interface (127.0.0.1:9771 by
default); this module is a thin, standard-library-only client for that HTTP API.

    from sdk.python.acpu import ACPUDevice
    dev = ACPUDevice()
    print(dev.status()["device"])          # ACPU-1 Tempest
    run = dev.forecast(members=64, lead_days=10)
    print(run["summary"], run["metrics"]["energyJ"])

Every method returns the same dict the console renders: formula, call, params,
metrics, summary, charts, tables, notes and a compact `data` payload.

If ACPU Studio is not running the constructor raises ACPUServiceError with an
explanation instead of a bare connection error.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request

__all__ = [
    "ACPUDevice",
    "ACPUServiceError",
    "forecast",
    "lyapunov",
    "assimilate",
    "transport",
    "dispersion",
    "benchmark",
    "status",
    "DEFAULT_HOST",
    "DEFAULT_PORTS",
]

__version__ = "1.0.0"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORTS = tuple(range(9771, 9781))

_NOT_RUNNING = (
    "ACPU Studio is not running (no device service answered on "
    "127.0.0.1:{first}-{last}). Start the app and make sure "
    "Settings -> Local device service is enabled, then retry."
)


class ACPUServiceError(RuntimeError):
    """Raised when the ACPU device service cannot be reached or refuses a run."""

    def __init__(self, message, code="service_unavailable"):
        super().__init__(message)
        self.code = code


class ACPUDevice:
    """Client for one ACPU-1 virtual device."""

    def __init__(self, host=DEFAULT_HOST, port=None, ports=DEFAULT_PORTS, timeout=120.0):
        self.host = host
        self.timeout = timeout
        self.base_url = None
        self.port = None
        self._ports = (port,) if port else tuple(ports)

    # -- transport ---------------------------------------------------------

    def _http(self, method, path, payload=None):
        url = self._ensure_url() + path
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else None
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = {"error": body or err.reason}
            raise ACPUServiceError(parsed.get("error", str(err)), parsed.get("code", "http_error"))
        except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
            raise ACPUServiceError(
                _NOT_RUNNING.format(first=self._ports[0], last=self._ports[-1])
                + " (last error: %s)" % (getattr(err, "reason", err),)
            )

    def _ensure_url(self):
        if self.base_url:
            return self.base_url
        for port in self._ports:
            base = "http://%s:%d" % (self.host, port)
            try:
                with urllib.request.urlopen(base + "/health", timeout=0.4) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                if body.get("status") == "ok":
                    self.base_url = base
                    self.port = port
                    return base
            except Exception:  # noqa: BLE001 - probing must never raise
                continue
        raise ACPUServiceError(_NOT_RUNNING.format(first=self._ports[0], last=self._ports[-1]))

    # -- API ---------------------------------------------------------------

    def health(self):
        """GET /health - service identity and uptime."""
        return self._http("GET", "/health")

    def status(self):
        """Chip identity, live state, counters and the service block."""
        dev = self._http("GET", "/v1/device")
        return {
            "device": "%s %s" % (dev["chip"]["name"], dev["chip"]["codename"]),
            "tiles": dev["chip"]["tiles"],
            "clusters": dev["chip"]["clusters"],
            "clockGHz": dev["state"]["clockGHz"],
            "powerW": dev["state"]["powerW"],
            "junctionC": dev["state"]["junctionC"],
            "runs": dev["counters"]["runs"],
            "energyJ": dev["counters"]["energyJ"],
            "service": dev.get("service"),
            "raw": dev,
        }

    def formulas(self):
        """The formula registry with parameter schemas."""
        return self._http("GET", "/v1/formulas")["formulas"]

    def telemetry(self):
        """Latest 10 Hz telemetry frame."""
        return self._http("GET", "/v1/telemetry")

    def runs(self):
        """Run history summaries."""
        return self._http("GET", "/v1/runs")["runs"]

    def run_by_id(self, run_id):
        return self._http("GET", "/v1/runs/%s" % run_id)

    def run(self, formula, **params):
        """Dispatch a formula by registry id or call name."""
        body = self._http("POST", "/v1/run", {"formula": formula, "params": params})
        return body.get("result", body)

    def call(self, text):
        """Dispatch with the console grammar: ``assimilate(members=64, cycles=12)``."""
        body = self._http("POST", "/v1/run", {"call": text})
        return body.get("result", body)

    # -- typed helpers -----------------------------------------------------

    def forecast(self, members=64, lead_days=10, precision="adaptive", kahan=False, model="l96"):
        """Lorenz-96 ensemble forecast. Returns member error, spread and RMSE."""
        return self.run("ensemble_forecast", members=members, lead_days=lead_days,
                        precision=precision, kahan=kahan, model=model)

    def lyapunov(self, leads=12, days=15):
        """Leading finite-time Lyapunov exponents and the Kaplan-Yorke dimension."""
        return self.run("lyapunov_spectrum", leads=leads, days=days)

    def assimilate(self, members=64, cycles=12, obs_frac=0.5, inflation=1.06, obs_error=0.5):
        """Cycled ensemble Kalman filter analysis."""
        return self.run("data_assimilation", members=members, cycles=cycles,
                        obs_frac=obs_frac, inflation=inflation, obs_error=obs_error)

    def transport(self, grid=48, steps=240, shear=1.0, diffusivity=0.01):
        """Semi-Lagrangian tracer transport of a point source."""
        return self.run("tracer_transport", grid=grid, steps=steps,
                        shear=shear, diffusivity=diffusivity)

    def dispersion(self, members=512, steps=120, turbulence=0.045, shear=0.6):
        """Monte-Carlo dispersion with percentile bands and a density map."""
        return self.run("dispersion_montecarlo", members=members, steps=steps,
                        turbulence=turbulence, shear=shear)

    def precision_study(self, members=32, lead_days=6):
        """Sweep fp32 / fp16 / bf16 / fp8 / adaptive."""
        return self.run("precision_study", members=members, lead_days=lead_days)

    def conservation_audit(self, grid=48, steps=2000):
        """Mass drift of the advection scheme in fp64, fp32 and compensated fp32."""
        return self.run("conservation_audit", grid=grid, steps=steps)

    def benchmark(self, precision="adaptive", resolution="operational"):
        """W1-W5 device-level benchmark table."""
        return self.run("benchmark_suite", precision=precision, resolution=resolution)


# ---------------------------------------------------------------------------
# Module level convenience API (one implicit device on the default ports)
# ---------------------------------------------------------------------------

_default = None


def _device():
    global _default
    if _default is None:
        _default = ACPUDevice()
    return _default


def status():
    """Status of the implicit default device."""
    return _device().status()


def forecast(**kwargs):
    return _device().forecast(**kwargs)


def lyapunov(**kwargs):
    return _device().lyapunov(**kwargs)


def assimilate(**kwargs):
    return _device().assimilate(**kwargs)


def transport(**kwargs):
    return _device().transport(**kwargs)


def dispersion(**kwargs):
    return _device().dispersion(**kwargs)


def benchmark(**kwargs):
    return _device().benchmark(**kwargs)
