source("figs/src/lib.R")
k   <- RD("kernels.csv")
wl  <- RD("workloads.csv")
e   <- RD("energy.csv")
ab  <- RD("ablations.csv")
ef  <- RD("efficiency.csv")
sen <- RD("sensitivity.csv")
acc <- RD("accuracy.csv")

## ---------------- fig12 throughput -------------------------------------
k$kernel <- factor(k$kernel, levels = k$kernel[order(k$gflop)])
p12a <- ggplot(k, aes(kernel, gflop)) +
  geom_col(fill = PAL[["navy"]], width = .66) +
  coord_flip() + labs(x = NULL, y = "GFLOP per step", title = "work per kernel") +
  scale_y_continuous(expand = expansion(mult = c(0, .12)))

k2 <- k[order(k$cycle_share), ]
k2$kernel <- factor(k2$kernel, levels = k2$kernel)
p12b <- ggplot(k2, aes(y = kernel)) +
  geom_segment(aes(x = cycle_share, xend = energy_share, yend = kernel),
               colour = PAL[["lgrey"]], linewidth = .8) +
  geom_point(aes(x = cycle_share, colour = "cycle share"), size = 1.6) +
  geom_point(aes(x = energy_share, colour = "energy share"), size = 1.6) +
  scale_colour_manual(values = c("cycle share" = PAL[["teal"]],
                                 "energy share" = PAL[["amber"]]), name = NULL) +
  scale_x_continuous(labels = percent_format(accuracy = 2)) +
  labs(x = "share of chip total", y = NULL, title = "cycles vs energy")

p12c <- ggplot(k, aes(reorder(kernel, efficiency), efficiency)) +
  geom_col(fill = PAL[["teal"]], width = .66) +
  coord_flip() + scale_y_continuous(labels = percent_format(accuracy = 1),
                                    limits = c(0, 1), expand = expansion(mult = c(0, .05))) +
  labs(x = NULL, y = "issue efficiency", title = "AVT pipeline efficiency")

w1 <- wl[wl$workload == "W1 ensemble forecast", ]
p12d <- ggplot(w1, aes(reorder(machine, time_s), time_s)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["grey"]], PAL[["red"]])[order(w1$time_s)], width = .6) +
  geom_text(aes(label = sprintf("%.0f s", time_s)), hjust = -0.1, size = 2.1) +
  coord_flip() + scale_y_log10(expand = expansion(mult = c(0.02, .25))) +
  labs(x = NULL, y = "seconds (log)", title = "W1 wall-clock")

f12 <- (p12a | p12b) / (p12c | p12d) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f12, "fig12_throughput", w = 6.4, h = 4.0)

## ---------------- fig13 energy -----------------------------------------
e$component <- factor(e$component, levels = e$component[order(e$share)])
p13a <- ggplot(e, aes(component, share)) +
  geom_col(fill = PAL[["navy"]], width = .66) +
  geom_text(aes(label = percent(share, accuracy = .1)), hjust = -0.1, size = 2) +
  coord_flip() + scale_y_continuous(labels = percent_format(accuracy = 1),
                                    expand = expansion(mult = c(0, .18))) +
  labs(x = NULL, y = "share of forecast energy", title = "energy breakdown")

ab$variant <- factor(ab$variant, levels = ab$variant[order(-ab$forecast_kj)])
p13b <- ggplot(ab, aes(variant, forecast_kj)) +
  geom_col(fill = c(PAL[["navy"]], rep(PAL[["teal"]], nrow(ab) - 1)), width = .62) +
  geom_text(aes(label = sprintf("%.1f", forecast_kj)), hjust = -0.12, size = 2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .16))) +
  labs(x = NULL, y = "kJ per forecast", title = "ablation")

p13c <- ggplot(ef, aes(time_s, kj, colour = mode)) +
  geom_point(size = 2.2) +
  geom_text(aes(label = mode), vjust = -1.2, size = 2.1, show.legend = FALSE) +
  scale_colour_manual(values = c(performance = PAL[["teal"]], efficiency = PAL[["green"]],
                                 H100 = PAL[["red"]]), guide = "none") +
  labs(x = "wall-clock (s)", y = "energy (kJ)", title = "time-energy frontier")

p13d <- ggplot(k, aes(reorder(kernel, energy_share), energy_share)) +
  geom_col(fill = PAL[["amber"]], width = .66) +
  coord_flip() + scale_y_continuous(labels = percent_format(accuracy = 1),
                                    expand = expansion(mult = c(0, .08))) +
  labs(x = NULL, y = "share of kernel energy", title = "kernel energy")

f13 <- (p13a | p13b) / (p13c | p13d) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f13, "fig13_energy", w = 6.4, h = 4.1)

## ---------------- fig14 comparison -------------------------------------
w1 <- wl[wl$workload == "W1 ensemble forecast", ]
w2 <- wl[wl$workload == "W2 ensemble analysis", ]
day <- merge(w1[, c("machine", "energy_kj", "time_s")],
             w2[, c("machine", "energy_kj", "time_s")], by = "machine",
             suffixes = c("_fc", "_da"))
day$day_kj <- day$energy_kj_fc + 4 * day$energy_kj_da
day$day_s  <- day$time_s_fc + 4 * day$time_s_da

p14a <- ggplot(day, aes(reorder(machine, day_kj), day_kj)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["red"]])[order(day$day_kj)], width = .55) +
  geom_text(aes(label = sprintf("%.1f kJ", day_kj)), hjust = -0.1, size = 2.2) +
  coord_flip() + scale_y_log10(expand = expansion(mult = c(.02, .25))) +
  labs(x = NULL, y = "kJ per forecast-and-analysis day", title = "daily energy")

p14b <- ggplot(day, aes(reorder(machine, day_s), day_s)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["red"]])[order(day$day_s)], width = .55) +
  geom_text(aes(label = sprintf("%.0f s", day_s)), hjust = -0.1, size = 2.2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .2))) +
  labs(x = NULL, y = "seconds per day", title = "daily wall-clock")

p14c <- ggplot(wl, aes(tflops, energy_kj / time_s * 1000, colour = machine)) +
  geom_point(size = 2) +
  scale_colour_manual(values = c(ACPU = PAL[["teal"]], H100 = PAL[["grey"]],
                                 A100 = PAL[["red"]]), name = NULL) +
  scale_x_log10() + scale_y_log10() +
  labs(x = "achieved TFLOPS", y = "power (W)", title = "throughput vs power")

p14d <- ggplot(sen, aes(ratio)) +
  geom_histogram(bins = 24, fill = PAL[["teal"]], colour = "white", linewidth = .2) +
  geom_vline(xintercept = median(sen$ratio), colour = PAL[["navy"]], linetype = 2) +
  labs(x = "energy ratio (H100 / ACPU)", y = "samples", title = "Monte-Carlo")

p14e <- ggplot(sen, aes(gpu_eff, ratio)) +
  geom_point(colour = PAL[["teal"]], size = .45, alpha = .35) +
  geom_smooth(method = "loess", span = .6, se = TRUE, colour = PAL[["amber"]],
              fill = PAL[["amber"]], alpha = .15, linewidth = .7) +
  labs(x = "GPU stencil efficiency", y = "ratio", title = "sensitivity")

fl_day <- unique(w1$flops)[1] + 4 * unique(w2$flops)[1]
day$per_flop <- day$day_kj * 1e3 / fl_day * 1e12
p14f <- ggplot(day, aes(reorder(machine, per_flop), per_flop)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["red"]])[order(day$per_flop)], width = .55) +
  geom_text(aes(label = sprintf("%.1f", per_flop)), hjust = -0.1, size = 2.2) +
  coord_flip() + scale_y_log10(expand = expansion(mult = c(.02, .25))) +
  labs(x = NULL, y = "pJ per delivered FLOP", title = "arithmetic energy")

f14 <- (p14a | p14b) / (p14c | p14d) / (p14e | p14f) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f14, "fig14_cuda", w = 6.4, h = 6.3)

## ---------------- fig15 accuracy ---------------------------------------
acc$mode <- factor(acc$mode, levels = c("fp64", "fp32", "fp16", "bf16", "fp8", "adaptive"))
p15a <- ggplot(acc, aes(lead_hours, rmse, colour = mode, linetype = mode)) +
  geom_line(linewidth = .7) +
  scale_colour_manual(values = MODE_COL, name = NULL) +
  scale_linetype_manual(values = c(fp64 = 1, fp32 = 2, fp16 = 1, bf16 = 3, fp8 = 1,
                                   adaptive = 4), name = NULL) +
  labs(x = "lead time (h)", y = "RMSE", title = "forecast error by precision")

an <- unique(acc[acc$lead == 0, c("mode", "mode")])
ana <- RD("accuracy.csv"); ana <- ana[ana$lead == 0, ]
ana$mode <- factor(ana$mode, levels = ana$mode[order(ana$rmse)])
p15b <- ggplot(ana, aes(mode, rmse, fill = mode)) +
  geom_col(width = .62, show.legend = FALSE) +
  scale_fill_manual(values = MODE_COL, guide = "none") +
  geom_text(aes(label = sprintf("%.2f", rmse)), hjust = -0.12, size = 2.1) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .18))) +
  labs(x = NULL, y = "analysis RMSE", title = "analysis skill")

d0 <- acc[acc$mode == "fp64", ]
p15c <- ggplot(d0, aes(lead_hours)) +
  geom_line(aes(y = spread, colour = "spread"), linewidth = .7) +
  geom_line(aes(y = rmse, colour = "RMSE"), linewidth = .7) +
  geom_hline(yintercept = 0, colour = PAL[["lgrey"]]) +
  scale_colour_manual(values = c(spread = PAL[["teal"]], RMSE = PAL[["navy"]]), name = NULL) +
  labs(x = "lead time (h)", y = "error", title = "spread vs error")

dr <- RD("drift.csv")
p15d <- ggplot(dr, aes(step, drift, colour = fmt)) +
  geom_line(linewidth = .6) +
  scale_colour_manual(values = c(fp64 = PAL[["navy"]], fp32 = PAL[["amber"]]), name = NULL) +
  scale_y_log10(labels = trans_format("log10", math_format(10^.x))) +
  labs(x = "advection steps", y = "|mass drift|", title = "conservation")

kh <- RD("kahan.csv"); kh <- kh[kh$metric %in% c("naive_err", "kahan_err"), ]
kh$label <- c("fp32 naive", "fp32 + Kahan")[match(kh$metric, c("naive_err", "kahan_err"))]
p15e <- ggplot(kh, aes(label, value)) +
  geom_segment(aes(xend = label, y = 1e-6, yend = value,
                   colour = label), linewidth = 1.1, show.legend = FALSE) +
  geom_point(aes(colour = label), size = 2.2, show.legend = FALSE) +
  geom_text(aes(label = sprintf("%.1e", value)), hjust = -0.25, size = 2.1) +
  scale_colour_manual(values = c("fp32 + Kahan" = PAL[["green"]],
                                 "fp32 naive" = PAL[["amber"]])) +
  scale_y_log10(limits = c(1e-6, 2e-3)) +
  labs(x = NULL, y = "absolute error", title = "100k-term accumulation")

f15 <- (p15a | p15b) / (p15c | p15d) / (p15e | plot_spacer()) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f15, "fig15_accuracy", w = 6.4, h = 5.6)

## ---------------- fig16 thermal ----------------------------------------
th <- RD("thermal.csv")
thl <- th[seq(1, nrow(th), by = 4), ]
p16a <- ggplot(thl, aes(t)) +
  geom_line(aes(y = Tj, colour = "junction"), linewidth = .7) +
  geom_line(aes(y = Th, colour = "heatsink"), linewidth = .6) +
  geom_line(aes(y = Tb, colour = "board"), linewidth = .6) +
  scale_colour_manual(values = c(junction = PAL[["red"]], heatsink = PAL[["amber"]],
                                 board = PAL[["grey"]]), name = NULL) +
  labs(x = "time (s)", y = "temperature (°C)", title = "thermal transient")

pw <- seq(0, 80, by = 2)
p16b <- data.frame(P = pw, Tj = 35 + pw * (0.18 + 0.28 + 0.19))
p16bb <- ggplot(p16b, aes(P, Tj)) +
  geom_line(colour = PAL[["navy"]], linewidth = .8) +
  geom_hline(yintercept = 95, colour = PAL[["red"]], linetype = 2, linewidth = .5) +
  geom_vline(xintercept = 65, colour = PAL[["grey"]], linetype = 3, linewidth = .5) +
  annotate("text", x = 66, y = 37, label = "TDP", size = 2.1, colour = PAL[["grey"]], hjust = 0) +
  annotate("text", x = 79, y = 97, label = "Tj,max", size = 2.1, colour = PAL[["red"]], hjust = 1) +
  coord_cartesian(ylim = c(30, 102)) +
  labs(x = "package power (W)", y = "steady junction (°C)", title = "thermal design point")

set.seed(4)
tile <- expand.grid(cluster = 1:8, tile = 1:8)
tile$power <- 0.55 + 0.10 * sin(tile$cluster / 1.7) + 0.06 * cos(tile$tile / 1.3) +
  rnorm(nrow(tile), 0, 0.02)
p16c <- ggplot(tile, aes(tile, cluster, fill = power)) +
  geom_tile(colour = "white", linewidth = .4) +
  scale_fill_gradient(low = "#E8F1F2", high = PAL[["red"]], name = "W per mm2") +
  scale_y_reverse(breaks = 1:8) + scale_x_continuous(breaks = 1:8) +
  coord_equal() +
  labs(x = "tile within cluster", y = "cluster", title = "power density map")

r <- data.frame(layer = c("junction->lid", "lid->sink", "sink->air"),
                R = c(0.18, 0.28, 0.19))
r$layer <- factor(r$layer, levels = r$layer[order(r$R)])
p16d <- ggplot(r, aes(layer, R)) +
  geom_col(fill = c(PAL[["grey"]], PAL[["amber"]], PAL[["teal"]]), width = .6) +
  geom_text(aes(label = sprintf("%.2f K/W", R)), hjust = -0.1, size = 2.1) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .2))) +
  labs(x = NULL, y = "thermal resistance", title = "resistances")

f16 <- (p16a | p16bb) / (p16c | p16d) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f16, "fig16_thermal", w = 6.4, h = 4.2)

## ---------------- fig17 voltage / frequency ----------------------------
Vth <- 0.22
f0 <- 1.8e9 / (0.75 - Vth)^1.25
v <- seq(0.50, 0.90, by = 0.01)
d17 <- expand.grid(V = v, T = c(25, 75, 100))
d17$f <- f0 * (d17$V - Vth)^1.25 * (1 - 0.0012 * (d17$T - 25))
d17$P <- 55 * (d17$V / 0.75)^2 * (d17$f / 1.8e9) * (1 + 0.012 * (d17$T - 25))
d17$T <- factor(d17$T, labels = c("25 °C", "75 °C", "100 °C"))

p17a <- ggplot(d17, aes(V, f / 1e9, colour = T)) +
  geom_line(linewidth = .7) +
  scale_colour_manual(values = c("25 °C" = PAL[["navy"]], "75 °C" = PAL[["teal"]],
                                 "100 °C" = PAL[["amber"]]), name = NULL) +
  labs(x = "supply (V)", y = "frequency (GHz)", title = "V-f at three corners")

p17b <- ggplot(d17, aes(V, P, colour = T)) +
  geom_line(linewidth = .7) +
  scale_colour_manual(values = c("25 °C" = PAL[["navy"]], "75 °C" = PAL[["teal"]],
                                 "100 °C" = PAL[["amber"]]), name = NULL) +
  labs(x = "supply (V)", y = "active power (W)", title = "power vs supply")

ef2 <- RD("efficiency.csv"); ef2$mode <- factor(ef2$mode,
        levels = c("performance", "efficiency", "H100"))
p17c <- ggplot(ef2, aes(mode, kj)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["green"]], PAL[["red"]]), width = .55) +
  geom_text(aes(label = sprintf("%.1f kJ / %.0f s", kj, time_s)), hjust = -0.08, size = 2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .3))) +
  labs(x = NULL, y = "kJ per forecast", title = "operating modes")

f17 <- (p17a | p17b) / (p17c | plot_spacer()) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f17, "fig17_voltage", w = 6.4, h = 4.4)

cat("data figures batch 1 done\n")
