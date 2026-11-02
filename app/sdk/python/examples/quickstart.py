#!/usr/bin/env python3
"""ACPU Studio quickstart - drives the virtual ACPU-1 from Python.

Run this while ACPU Studio is open (Settings -> Local device service on):

    python3 sdk/python/examples/quickstart.py

No third-party packages are required.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

from sdk.python.acpu import ACPUDevice, ACPUServiceError  # noqa: E402


def main():
    dev = ACPUDevice()
    try:
        st = dev.status()
    except ACPUServiceError as err:
        print("could not reach the ACPU device: %s" % err)
        return 1

    print("=" * 72)
    print("ACPU Studio quickstart")
    print("=" * 72)
    print("device      %s" % st["device"])
    print("service     %s" % (st["service"] or {}).get("url", "unknown"))
    print("tiles       %d tiles / %d clusters" % (st["tiles"], st["clusters"]))
    print("live        %.2f GHz · %.1f W · %.1f °C" % (st["clockGHz"], st["powerW"], st["junctionC"]))
    print("counters    %d runs · %.1f J" % (st["runs"], st["energyJ"]))

    print("\n-- ensemble forecast (64 members, 10 days) " + "-" * 25)
    run = dev.forecast(members=64, lead_days=10, precision="adaptive")
    print(run["summary"])
    m = run["metrics"]
    print("  time %.2f s · energy %.2f J · power %.1f W · %.1f TFLOPS · peak Tj %.1f °C"
          % (m["timeS"], m["energyJ"], m["powerW"], m["tflops"], m["peakTj"]))
    print("  precision used: %s" % run["data"]["precisionUsed"])

    print("\n-- cycled EnKF analysis (64 members, 12 cycles) " + "-" * 21)
    asy = dev.assimilate(members=64, cycles=12)
    print(asy["summary"])

    print("\n-- Lyapunov spectrum (12 exponents) " + "-" * 33)
    lyap = dev.lyapunov(leads=12, days=15)
    print(lyap["summary"])

    print("\n-- dispersion (512 particles) " + "-" * 38)
    disp = dev.dispersion(members=512, steps=120)
    print(disp["summary"])

    print("\n-- device benchmark (W1-W5) " + "-" * 41)
    bench = dev.benchmark()
    table = bench["tables"][0]
    print("%-4s %-26s %9s %9s %8s %8s %7s" % ("id", "workload", "time", "energy", "TFLOPS", "power", "Tj"))
    for row in table["rows"]:
        print("%-4s %-26s %9s %9s %8s %8s %7s" % (
            row["id"], row["workload"], row["time"], row["energy"],
            row["tflops"], row["power"], row["tj"]))
    totals = bench["tables"][1]["rows"]
    for entry in totals:
        print("  %-38s %s" % (entry["k"], entry["v"]))
    print("\nOK - every call went through the virtual ACPU-1 device model.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
