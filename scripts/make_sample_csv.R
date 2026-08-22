#!/usr/bin/env Rscript
#
# Regenerate data/sample_energy_upload.csv.
#
# The previous sample held 8 households with 2-3 readings each, which is not
# what a real meter or billing export looks like and gave the anomaly detector
# nothing to work with — no household had enough history for a baseline.
#
# This writes a year of daily readings for four households across two suburbs,
# with a seasonal shape (summer and winter peaks), weekend uplift, per-house
# solar, and a handful of deliberately planted anomalies so the robust detector
# has something real to find. Fully deterministic via set.seed.
#
# Usage: Rscript scripts/make_sample_csv.R

set.seed(20250822)

root <- normalizePath(file.path(dirname(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1]])), ".."))
output_path <- file.path(root, "data", "sample_energy_upload.csv")

households <- list(
  list(id = "H-101", suburb = "Northbank", base = 14.0, solar_kw = 6.6, residents = 4),
  list(id = "H-102", suburb = "Northbank", base = 9.5, solar_kw = 0.0, residents = 2),
  list(id = "H-201", suburb = "East Park", base = 18.5, solar_kw = 10.0, residents = 5),
  list(id = "H-202", suburb = "East Park", base = 7.0, solar_kw = 0.0, residents = 1)
)

days <- seq(as.Date("2024-07-01"), as.Date("2025-06-30"), by = "day")

# Planted anomalies: (household, date, multiplier). Two spikes big enough to
# clear a modified z-score of 3.5, and one near-zero dip for a holiday.
planted <- list(
  list(id = "H-101", day = as.Date("2025-01-18"), factor = 3.1),   # heatwave
  list(id = "H-201", day = as.Date("2024-08-09"), factor = 2.8),   # faulty heater
  list(id = "H-102", day = as.Date("2024-12-27"), factor = 0.08)   # away for Christmas
)

# Southern-hemisphere shape: hottest in January, coldest in July, both driving
# consumption up relative to the mild shoulder seasons.
seasonal_factor <- function(day) {
  doy <- as.integer(format(day, "%j"))
  summer <- cos(2 * pi * (doy - 15) / 365)   # peaks mid-January
  winter <- cos(2 * pi * (doy - 196) / 365)  # peaks mid-July
  1 + 0.30 * pmax(summer, 0) + 0.34 * pmax(winter, 0)
}

# Solar output tracks daylight, so it is the inverse: strongest in summer.
solar_factor <- function(day) {
  doy <- as.integer(format(day, "%j"))
  0.55 + 0.45 * cos(2 * pi * (doy - 15) / 365)
}

rows <- list()

for (house in households) {
  for (day in days) {
    day <- as.Date(day, origin = "1970-01-01")

    weekend <- format(day, "%u") %in% c("6", "7")
    total <- house$base *
      seasonal_factor(day) *
      (if (weekend) 1.14 else 1.0) *
      rnorm(1, mean = 1, sd = 0.09)

    for (event in planted) {
      if (event$id == house$id && event$day == day) {
        total <- total * event$factor
      }
    }
    total <- max(total, 0.2)

    # Tier split shifts with the season: more evening peak in winter, more
    # off-peak overnight cooling in summer.
    peak_share <- 0.38 + 0.06 * (seasonal_factor(day) - 1) + rnorm(1, 0, 0.02)
    peak_share <- min(max(peak_share, 0.28), 0.52)
    offpeak_share <- 0.24 + rnorm(1, 0, 0.02)
    offpeak_share <- min(max(offpeak_share, 0.16), 0.32)
    shoulder_share <- 1 - peak_share - offpeak_share

    peak <- total * peak_share
    shoulder <- total * shoulder_share
    offpeak <- total * offpeak_share

    solar_export <- if (house$solar_kw > 0) {
      max(0, house$solar_kw * 0.78 * solar_factor(day) * rnorm(1, 1, 0.14))
    } else {
      0
    }
    # A house cannot export more than it generates beyond its own daytime use.
    solar_export <- min(solar_export, total * 0.85)

    grid_import <- max(0, total - solar_export)

    # Simple time-of-use tariff plus a daily supply charge.
    bill <- 1.15 +
      peak * 0.42 +
      shoulder * 0.28 +
      offpeak * 0.19 -
      solar_export * 0.07

    rows[[length(rows) + 1]] <- data.frame(
      day = format(day, "%Y-%m-%d"),
      household_id = house$id,
      neighbourhood = house$suburb,
      peak_kwh = round(peak, 2),
      shoulder_kwh = round(shoulder, 2),
      offpeak_kwh = round(offpeak, 2),
      solar_export_kwh = round(solar_export, 2),
      grid_import_kwh = round(grid_import, 2),
      estimated_bill = round(max(bill, 0), 2),
      stringsAsFactors = FALSE
    )
  }
}

frame <- do.call(rbind, rows)
frame <- frame[order(frame$day, frame$household_id), ]

dir.create(dirname(output_path), recursive = TRUE, showWarnings = FALSE)
write.csv(frame, output_path, row.names = FALSE)

cat(
  "Wrote", nrow(frame), "rows to", output_path,
  "\n  households:", length(households),
  "\n  range:", min(frame$day), "to", max(frame$day),
  "\n  planted anomalies:", length(planted), "\n"
)
