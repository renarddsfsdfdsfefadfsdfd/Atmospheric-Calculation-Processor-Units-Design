# ACPU-1 model digest

- sustained 41.9 TFLOPS, util 71.1 of FP32 peak, 57.1 W per step
- 24 h / 64-member forecast: 126 s, 7.17 kJ, 57.1 W
- H100 same workload: 278 s, 73.0 kJ, 263 W
- forecast energy ratio 10.2x
- forecast+4 analyses: ACPU 237 s / 8.54 kJ vs H100 293 s / 79.0 kJ (9.3x)
- sensitivity ratio p05/median/p95: 7.3 / 9.4 / 12.3
- analysis RMSE fp64 0.221, fp16 0.223, fp8 2.767
- Lyapunov top 0.34 /day, error doubling 2.49 days
- die yield 77.6 on 287.6 mm2, die $148, card BOM $464
