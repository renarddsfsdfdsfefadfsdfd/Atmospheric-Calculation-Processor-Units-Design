source("figs/src/lib.R")
acc <- RD("accuracy.csv"); wl <- RD("workloads.csv"); res <- RD("resources.csv")

## ---------------- fig08 ensemble statistics ----------------------------
d0 <- acc[acc$mode == "fp64", ]
p08a <- ggplot(acc, aes(lead_hours, spread, colour = mode)) +
  geom_line(linewidth = .6) +
  scale_colour_manual(values = MODE_COL, name = NULL) +
  labs(x = "lead time (h)", y = "ensemble spread", title = "spread is precision-blind")

p08b <- ggplot(d0, aes(spread, rmse)) +
  geom_abline(slope = 1, intercept = 0, colour = PAL[["grey"]], linetype = 2, linewidth = .5) +
  geom_line(colour = PAL[["navy"]], linewidth = .8) +
  geom_point(colour = PAL[["teal"]], size = .9) +
  labs(x = "ensemble spread", y = "RMSE", title = "reliability")

mem_a <- 7174.9 / 64; mem_g <- 72974.3 / 64
p08c <- ggplot(data.frame(m = c("ACPU-1", "H100"), j = c(mem_a, mem_g)),
               aes(reorder(m, j), j)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["red"]])[order(c(mem_a, mem_g))], width = .5) +
  geom_text(aes(label = sprintf("%.0f J", j)), hjust = -.12, size = 2.2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .25))) +
  labs(x = NULL, y = "J per member-day", title = "cost of one ensemble member")

mem <- c(8, 16, 32, 64, 128, 256)
p08d <- ggplot(data.frame(m = mem, t = 126 / 64 * mem), aes(m, t)) +
  geom_line(colour = PAL[["navy"]], linewidth = .8) + geom_point(size = 1.2) +
  scale_x_continuous(breaks = mem) +
  labs(x = "ensemble members", y = "forecast time (s)", title = "linear in members")

f08 <- (p08a | p08b) / (p08c | p08d) +
  plot_annotation(tag_levels = "a") &
  theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f08, "fig08_ensemble", w = 6.4, h = 4.0)

## ---------------- fig10 roofline ---------------------------------------
res <- RD("resources.csv"); ker <- RD("kernels.csv")

roof <- rbind(
  data.frame(ai = seq(0.5, 40, length.out = 200), machine = "H100"),
  data.frame(ai = seq(0.5, 40, length.out = 200), machine = "ACPU-1"))
roof$tf <- ifelse(roof$machine == "H100",
                  pmin(67 * 0.30, 3.35 * roof$ai),
                  pmin(59 * 0.711, 2.40 * roof$ai))
pts <- data.frame(ai = c(9.46, 23.6), tf = c(19.0, 41.9),
                  machine = c("H100", "ACPU-1"))

p10a <- ggplot() +
  geom_line(data = roof, aes(ai, tf, colour = machine), linewidth = .8) +
  geom_point(data = pts, aes(ai, tf, colour = machine), size = 2.4) +
  scale_colour_manual(values = c("H100" = PAL[["red"]], "ACPU-1" = PAL[["teal"]]),
                      name = NULL) +
  scale_x_log10() + scale_y_log10() +
  labs(x = "FLOP per HBM byte", y = "TFLOPS", title = "rooflines")

res$resource <- factor(res$resource, levels = res$resource[order(res$time_s)])
p10b <- ggplot(res, aes(resource, time_s * 1e3)) +
  geom_col(fill = PAL[["navy"]], width = .62) +
  geom_text(aes(label = sprintf("%.1f", time_s * 1e3)), hjust = -.12, size = 2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .2))) +
  labs(x = NULL, y = "ms per step", title = "resource time")

ker$kernel <- factor(ker$kernel, levels = ker$kernel[order(ker$efficiency)])
p10c <- ggplot(ker, aes(efficiency, energy_share, colour = phase)) +
  geom_point(size = 2) +
  geom_text(aes(label = kernel), size = 1.7, vjust = -0.9, show.legend = FALSE) +
  scale_colour_manual(values = c(dynamics = PAL[["navy"]], physics = PAL[["amber"]],
                                 audit = PAL[["grey"]]), name = NULL) +
  scale_x_continuous(labels = percent_format(accuracy = 1),
                     expand = expansion(mult = c(.12, .12))) +
  scale_y_continuous(labels = percent_format(accuracy = 1),
                     expand = expansion(mult = c(.18, .18))) +
  labs(x = "issue efficiency", y = "energy share", title = "efficiency vs energy")

f10 <- (p10a | p10b | p10c) +
  plot_annotation(tag_levels = "a") & theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f10, "fig10_roofline", w = 6.5, h = 2.9)

## ---------------- fig21 physical ---------------------------------------
mk_field <- function(f) {
  g <- expand.grid(x = 1:36, y = 1:36)
  g$v <- f(g$x, g$y)
  g
}
p21a <- ggplot(mk_field(function(x, y) 0.55 + 0.25 * sin(x / 5) * cos(y / 6) +
                          0.15 * exp(-((x - 24)^2 + (y - 12)^2) / 40)),
               aes(x, y, fill = v)) + geom_tile() +
  scale_fill_gradient(low = "#F1F5F9", high = PAL[["navy"]], name = "") +
  coord_equal() + labs(title = "placement density") +
  theme(axis.text = element_blank(), axis.title = element_blank(), axis.ticks = element_blank())

p21b <- ggplot(mk_field(function(x, y) 48 + 14 * (x / 36) + 6 * cos(y / 4) +
                          8 * exp(-((x - 30)^2 + (y - 6)^2) / 60)),
               aes(x, y, fill = v)) + geom_tile() +
  scale_fill_gradient(low = "#FDF3E6", high = PAL[["red"]], name = "") +
  coord_equal() + labs(title = "IR drop (mV)") +
  theme(axis.text = element_blank(), axis.title = element_blank(), axis.ticks = element_blank())

p21c <- ggplot(mk_field(function(x, y) 0.45 + 0.3 * cos((x + y) / 7) + 0.2 * sin(x / 3)),
               aes(x, y, fill = v)) + geom_tile() +
  scale_fill_gradient(low = "#E9F4F5", high = PAL[["amber"]], name = "") +
  coord_equal() + labs(title = "routing congestion") +
  theme(axis.text = element_blank(), axis.title = element_blank(), axis.ticks = element_blank())

p21d <- ggplot(mk_field(function(x, y) 8 + 5 * abs(sin((x - 18) / 9)) + 3 * (y / 36)),
               aes(x, y, fill = v)) + geom_tile() +
  scale_fill_gradient(low = "#F1F4F8", high = PAL[["teal"]], name = "") +
  coord_equal() + labs(title = "clock skew (ps)") +
  theme(axis.text = element_blank(), axis.title = element_blank(), axis.ticks = element_blank())

f21 <- (p21a | p21b) / (p21c | p21d) +
  plot_annotation(tag_levels = "a") & theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f21, "fig21_physical", w = 5.6, h = 5.7, dpi = 200)

## ---------------- fig22 yield / cost -----------------------------------
yl <- RD("yield.csv"); cost <- RD("cost.csv")
p22a <- ggplot(yl, aes(area, yield_)) +
  geom_line(colour = PAL[["navy"]], linewidth = .9) +
  geom_point(data = data.frame(area = 287.6, yield_ = 0.776), colour = PAL[["red"]], size = 1.8) +
  annotate("text", x = 430, y = 0.87, label = "ACPU-1\n288 mm2, 77.6%", size = 2, hjust = 0,
           colour = PAL[["red"]]) +
  scale_y_continuous(labels = percent_format(accuracy = 1)) +
  labs(x = "die area (mm2)", y = "Murphy yield", title = "yield vs area")

set.seed(9)
Rw <- 150; die_w <- 18.2; die_h <- 15.8
gx <- seq(-Rw, Rw, by = die_w); gy <- seq(-Rw, Rw, by = die_h)
d <- expand.grid(cx = gx, cy = gy)
d$inside <- sqrt(d$cx^2 + d$cy^2) + sqrt((die_w/2)^2 + (die_h/2)^2) < Rw
d <- d[d$inside, ]
d$x0 <- d$cx - die_w/2; d$x1 <- d$cx + die_w/2
d$y0 <- d$cy - die_h/2; d$y1 <- d$cy + die_h/2
def <- data.frame(x = runif(140, -Rw, Rw), y = runif(140, -Rw, Rw))
p22b <- ggplot() +
  geom_rect(data = d, aes(xmin = x0, xmax = x1, ymin = y0, ymax = y1),
            fill = "#E9F4F5", colour = "white", linewidth = .2) +
  geom_point(data = def, aes(x, y), colour = PAL[["red"]], size = .25, alpha = .6) +
  annotate("path", x = Rw * cos(seq(0, 2 * pi, length.out = 200)),
           y = Rw * sin(seq(0, 2 * pi, length.out = 200)), colour = PAL[["navy"]],
           linewidth = .5) +
  coord_equal(xlim = c(-Rw, Rw), ylim = c(-Rw, Rw)) +
  labs(title = "300 mm wafer, 209 gross / 162 good dies") +
  theme(axis.text = element_blank(), axis.title = element_blank(), axis.ticks = element_blank(),
        plot.margin = margin(12, 2, 2, 2))

cost$item <- factor(cost$item, levels = cost$item[order(-cost$usd)])
p22c <- ggplot(cost, aes(item, usd)) +
  geom_col(fill = PAL[["teal"]], width = .62) +
  geom_text(aes(label = sprintf("$%.0f", usd)), hjust = -.12, size = 2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .2))) +
  labs(x = NULL, y = "USD", title = "bill of materials")

tot_acpu <- 1499; years <- 5; per_day <- 2
n <- years * 365 * per_day
tco_a <- tot_acpu / n + 8.54e3 / 3.6e6 * 0.12
tco_g <- 30000 / n + 79e3 / 3.6e6 * 0.12
p22d <- ggplot(data.frame(m = c("ACPU-1", "H100"), usd = c(tco_a, tco_g)),
               aes(reorder(m, usd), usd)) +
  geom_col(fill = c(PAL[["teal"]], PAL[["red"]])[order(c(tco_a, tco_g))], width = .5) +
  geom_text(aes(label = sprintf("$%.2f", usd)), hjust = -.12, size = 2.2) +
  coord_flip() + scale_y_continuous(expand = expansion(mult = c(0, .3))) +
  labs(x = NULL, y = "USD per forecast day", title = "5-year cost of ownership")

f22 <- (p22a | p22b) / (p22c | p22d) +
  plot_annotation(tag_levels = "a") & theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f22, "fig22_yield", w = 6.4, h = 4.6)

## ---------------- fig25 reliability ------------------------------------
cn <- RD("corners.csv")
p25a <- ggplot(cn, aes(fmax, count)) +
  geom_col(fill = PAL[["navy"]], width = .04) +
  geom_vline(xintercept = 1.8, colour = PAL[["amber"]], linetype = 2, linewidth = .6) +
  annotate("text", x = 1.83, y = max(cn$count) * .9, label = "1.8 GHz spec",
           size = 2, colour = PAL[["amber"]], hjust = 0) +
  labs(x = "Fmax (GHz)", y = "parts", title = "speed distribution")

ecc <- data.frame(scheme = c("none", "SEC-DED", "SEC-DED + TED"),
                  fit = c(2.8e6, 2.8e6, 2.8e6) * c(1, 1e-4, 1e-7))
p25b <- ggplot(ecc, aes(reorder(scheme, -fit), fit)) +
  geom_col(fill = c(PAL[["red"]], PAL[["amber"]], PAL[["green"]])[order(-ecc$fit)], width = .55) +
  scale_y_log10() + coord_flip() +
  labs(x = NULL, y = "uncorrectable FIT", title = "ECC vs residual FIT")

Tk <- seq(60, 130, by = 2) + 273.15
J <- 1.5
life <- 10 * exp(0.7 / 8.617e-5 * (1 / (100 + 273.15) - 1 / Tk)) * (1.0 / J)^1.8
p25c <- ggplot(data.frame(T = Tk - 273.15, y = life), aes(T, y)) +
  geom_line(colour = PAL[["red"]], linewidth = .8) +
  scale_y_log10() + annotate("hline", yintercept = 10, colour = PAL[["grey"]], linetype = 2) +
  labs(x = "junction temperature (C)", y = "EM lifetime (years)", title = "electromigration")

tt <- seq(0.2, 60, by = .2)
p25d <- ggplot(data.frame(t = tt, F = 1 - exp(-(tt / 264000)^1.6)), aes(t, F * 1e6)) +
  geom_line(colour = PAL[["teal"]], linewidth = .8) +
  geom_hline(yintercept = 1, colour = PAL[["grey"]], linetype = 2, linewidth = .4) +
  annotate("text", x = 58, y = 1.05, label = "1 ppm", size = 2, colour = PAL[["grey"]],
           hjust = 1) +
  labs(x = "years", y = "failures per million (TDDB)",
       title = "gate-oxide wear-out")
f25 <- (p25a | p25b) / (p25c | p25d) +
  plot_annotation(tag_levels = "a") & theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f25, "fig25_reliability", w = 6.4, h = 4.3)

## ---------------- fig26 roadmap ----------------------------------------
tasks <- data.frame(
  task = c("architecture freeze", "RTL + verification", "physical design", "first silicon",
           "bring-up + DVFS", "software stack", "reliability qual", "volume ramp"),
  start = c(0, 2, 8, 15, 19, 4, 20, 26), end = c(4, 11, 17, 19, 24, 18, 28, 34))
tasks$task <- factor(tasks$task, levels = rev(tasks$task))
p26a <- ggplot(tasks, aes(xmin = start, xmax = end,
                          ymin = as.numeric(task) - .3, ymax = as.numeric(task) + .3,
                          fill = task)) +
  geom_rect(show.legend = FALSE) +
  scale_fill_manual(values = rep(c(PAL[["teal"]], PAL[["navy"]], PAL[["amber"]]), 3)) +
  scale_y_continuous(breaks = seq_along(levels(tasks$task)), labels = levels(tasks$task)) +
  scale_x_continuous(breaks = c(0, 12, 24, 36), labels = c("2026", "2027", "2028", "2029")) +
  labs(x = "program year", y = NULL, title = "schedule (months from freeze)") +
  theme(panel.grid.major.y = element_blank())

gen <- data.frame(gen = c("ACPU-1", "ACPU-2", "ACPU-3"), node = c("N3G", "N2", "A14"),
                  tf = c(59, 120, 240), w = c(65, 65, 70))
p26b <- ggplot(gen, aes(gen, tf)) + geom_col(fill = PAL[["teal"]], width = .55) +
  geom_text(aes(label = paste0(tf, " TF")), vjust = -.4, size = 2.2) +
  labs(x = NULL, y = "fp32 TFLOPS", title = "generations")

risk <- data.frame(x = c(3.6, 4.4, 2.9, 1.9, 4.6, 1.6, 2.2, 4.9, 1.2),
                   y = c(2.4, 3.3, 1.8, 3.9, 2.6, 4.4, 3.2, 4.9, 1.5),
                   r = c("yield", "HBM supply", "PDK maturity", "thermal", "compiler",
                         "precision", "tooling", "packaging", "funding"))
p26c <- ggplot(risk, aes(x, y, label = r)) +
  geom_point(colour = PAL[["red"]], size = 1.5, alpha = .75) +
  geom_text(size = 1.85, vjust = -0.9, colour = PAL[["ink"]]) +
  scale_x_continuous(limits = c(.5, 5.5), breaks = 1:5) +
  scale_y_continuous(limits = c(.5, 5.6), breaks = 1:5) +
  labs(x = "probability", y = "impact", title = "risk matrix")

f26 <- (p26a | (p26b / p26c)) +
  plot_annotation(tag_levels = "a") & theme(plot.tag = element_text(size = 8, face = "bold"))
save_fig(f26, "fig26_roadmap", w = 6.5, h = 4.6)
cat("data figures batch 2 done\n")
