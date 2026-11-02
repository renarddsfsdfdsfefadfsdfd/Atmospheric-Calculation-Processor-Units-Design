source("figs/src/lib.R")
acc <- RD("accuracy.csv"); acc <- acc[acc$mode == "fp64", ]
sp  <- RD("spectrum.csv")
dbl <- RD("doubling.csv")
sen <- RD("sensitivity.csv")
wl  <- RD("workloads.csv"); wl1 <- wl[wl$workload == "W1 ensemble forecast", ]

p_a <- ggplot(acc, aes(lead_hours)) +
  geom_line(aes(y = spread, colour = "ensemble spread"), linewidth = .7, linetype = 2) +
  geom_line(aes(y = rmse, colour = "ensemble-mean RMSE"), linewidth = .85) +
  scale_colour_manual(values = c("ensemble spread" = PAL[["teal"]],
                                 "ensemble-mean RMSE" = PAL[["navy"]]), name = NULL) +
  labs(x = "lead time (h)", y = "error", title = "error growth") +
  coord_cartesian(ylim = c(0, 3.4))

p_b <- ggplot(sp, aes(index, exponent)) +
  geom_col(fill = PAL[["navy"]], width = .68) +
  scale_x_continuous(breaks = c(0, 3, 6, 9, 11)) +
  labs(x = "exponent index", y = expression(lambda~"(1/time unit)"),
       title = "Lyapunov spectrum")

p_c <- ggplot(dbl, aes(t * 5, error)) +
  geom_line(colour = PAL[["red"]], linewidth = .7) +
  scale_y_log10(labels = trans_format("log10", math_format(10^.x))) +
  annotate("segment", x = 0, xend = 9, y = 4e-6, yend = 4e-5, colour = PAL[["grey"]],
           linetype = 2, linewidth = .4) +
  annotate("text", x = 9.5, y = 5e-5, label = "doubling 2.5 d", hjust = 0, size = 2.2,
           colour = PAL[["grey"]]) +
  labs(x = "time (days)", y = "twin-trajectory distance", title = "error doubling")

p_d <- ggplot(wl1, aes(reorder(machine, pj_per_flop), pj_per_flop)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["grey"]], PAL[["red"]])[order(wl1$pj_per_flop)],
           width = .6) +
  geom_text(aes(label = sprintf("%.1f", pj_per_flop)), hjust = -0.15, size = 2.1) +
  coord_flip() + scale_y_log10(expand = expansion(mult = c(0.02, 0.22))) +
  labs(x = NULL, y = "pJ per delivered FLOP", title = "arithmetic energy")

p_e <- ggplot(sen, aes(gpu_eff, ratio)) +
  geom_point(colour = PAL[["teal"]], size = .5, alpha = .4) +
  geom_smooth(method = "loess", span = .6, se = FALSE, colour = PAL[["amber"]],
              linewidth = .7) +
  geom_hline(yintercept = median(sen$ratio), colour = PAL[["navy"]], linetype = 2,
             linewidth = .45) +
  labs(x = "assumed GPU stencil efficiency", y = "energy ratio", title = "sensitivity")

p_f <- ggplot(wl1, aes(reorder(machine, energy_kj), energy_kj)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["grey"]], PAL[["red"]])[order(wl1$energy_kj)],
           width = .6) +
  geom_text(aes(label = sprintf("%.1f", energy_kj)), hjust = -0.12, size = 2.1) +
  coord_flip() + scale_y_log10(expand = expansion(mult = c(0.02, 0.30))) +
  labs(x = NULL, y = "kJ per 24 h forecast", title = "W1 forecast energy")

fig <- (p_a | p_b | p_c) / (p_d | p_e | p_f) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold", colour = PAL[["navy"]]))

save_fig(fig, "fig01_requirements", w = 6.5, h = 4.3)
cat("fig01 written\n")
