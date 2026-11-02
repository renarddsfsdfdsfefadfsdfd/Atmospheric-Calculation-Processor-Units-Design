## Shared style for every ACPU-1 report figure.
suppressPackageStartupMessages({
  library(ggplot2); library(grid); library(scales); library(patchwork)
})

PAL <- c(
  navy   = "#10233F",
  teal   = "#0E7C86",
  teal2  = "#3FA7AE",
  amber  = "#D9822B",
  red    = "#B4453C",
  green  = "#4C7A5A",
  grey   = "#7C8A9C",
  lgrey  = "#D7DEE7",
  ink    = "#1B2430"
)

MODE_COL <- c(fp64 = PAL[["navy"]], fp32 = PAL[["teal"]], fp16 = PAL[["teal2"]],
              bf16 = PAL[["amber"]], fp8 = PAL[["red"]], adaptive = PAL[["green"]])

theme_acpu <- function(base_size = 7.4, base_family = "Helvetica") {
  theme_minimal(base_size = base_size, base_family = base_family) +
    theme(
      text = element_text(colour = PAL[["ink"]]),
      plot.title = element_text(size = base_size + 0.4, face = "bold",
                                margin = margin(b = 3, l = 13), colour = PAL[["navy"]]),
      plot.subtitle = element_text(size = base_size - 0.6, colour = PAL[["grey"]],
                                   margin = margin(b = 4)),
      plot.tag = element_text(size = base_size + 0.8, face = "bold",
                              colour = PAL[["navy"]]),
      plot.tag.position = c(0.002, 1.0),
      axis.title = element_text(size = base_size - 0.2),
      axis.text = element_text(size = base_size - 0.6, colour = "#3A4657"),
      axis.ticks = element_line(colour = PAL[["lgrey"]], linewidth = 0.3),
      panel.grid.major = element_line(colour = "#E8EDF3", linewidth = 0.3),
      panel.grid.minor = element_blank(),
      panel.border = element_rect(colour = PAL[["lgrey"]], fill = NA, linewidth = 0.35),
      legend.title = element_text(size = base_size - 0.6),
      legend.text = element_text(size = base_size - 0.8),
      legend.key.size = unit(0.9, "lines"),
      legend.position = "top",
      legend.justification = "left",
      plot.margin = margin(4, 6, 4, 4),
      strip.text = element_text(size = base_size - 0.4, face = "bold")
    )
}

theme_set(theme_acpu())

## Save both PDF (for LaTeX) and PNG (for quick review). The PNG preview is
## optional: on hosts without a working bitmap device the PDF is still written.
save_fig <- function(p, name, w = 6.3, h = 3.4, dpi = 220) {
  dir.create("figs/out", showWarnings = FALSE, recursive = TRUE)
  pdf(file.path("figs/out", paste0(name, ".pdf")), width = w, height = h,
      family = "Helvetica", useDingbats = FALSE)
  print(p)
  dev.off()

  dir.create("figs/png", showWarnings = FALSE, recursive = TRUE)
  type <- if (capabilities("aqua")) "quartz" else getOption("bitmapType")
  tryCatch({
    png(file.path("figs/png", paste0(name, ".png")), width = w, height = h,
        units = "in", res = dpi, family = "Helvetica", type = type)
    print(p)
    dev.off()
  }, error = function(e) {
    try(dev.off(), silent = TRUE)
    message("PNG preview skipped for ", name, ": ", conditionMessage(e))
  })
  invisible(NULL)
}

RD <- function(f) read.csv(file.path("results", f), stringsAsFactors = FALSE)

## small helper: annotated bar value labels
lbl <- function(x, acc = 0.1) formatC(x, format = "f", digits = 1)
