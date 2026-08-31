#!/usr/bin/env Rscript

APP_TITLE <- "GridScope Studio"

get_project_root <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_arg <- grep("^--file=", args, value = TRUE)

  if (length(file_arg) == 0) {
    return(normalizePath(getwd(), mustWork = TRUE))
  }

  script_path <- normalizePath(sub("^--file=", "", file_arg[[1]]), mustWork = TRUE)
  normalizePath(file.path(dirname(script_path), ".."), mustWork = TRUE)
}

parse_cli_args <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  options <- list(input = NULL, output = NULL)

  if ("--help" %in% args || "-h" %in% args) {
    cat(
      "Usage:\n",
      "  Rscript R/run_analysis.R\n",
      "  Rscript R/run_analysis.R --input path/to/energy.csv --output output/custom-report.html\n\n",
      "Custom CSV columns:\n",
      "  day or date\n",
      "  grid_import_kwh or total_kwh, or peak_kwh/shoulder_kwh/offpeak_kwh\n",
      "  optional: household_id, neighbourhood, solar_export_kwh, estimated_bill\n",
      sep = ""
    )
    quit(save = "no", status = 0)
  }

  i <- 1
  while (i <= length(args)) {
    if (args[[i]] == "--input") {
      if (i == length(args)) {
        stop("--input requires a path.", call. = FALSE)
      }
      options$input <- args[[i + 1]]
      i <- i + 2
    } else if (args[[i]] == "--output") {
      if (i == length(args)) {
        stop("--output requires a path.", call. = FALSE)
      }
      options$output <- args[[i + 1]]
      i <- i + 2
    } else {
      stop(paste("Unknown argument:", args[[i]]), call. = FALSE)
    }
  }

  options
}

run_checked <- function(command, args, stdin = NULL) {
  output <- system2(
    command = command,
    args = args,
    stdin = stdin,
    stdout = TRUE,
    stderr = TRUE
  )
  status <- attr(output, "status")

  if (!is.null(status) && status != 0) {
    stop(paste(output, collapse = "\n"), call. = FALSE)
  }

  output
}

execute_sql_file <- function(sqlite, db_path, sql_file) {
  message("Running SQL: ", basename(sql_file))
  invisible(run_checked(sqlite, db_path, stdin = sql_file))
}

query_to_frame <- function(sqlite, db_path, sql_file) {
  output <- run_checked(
    sqlite,
    c("-header", "-csv", db_path),
    stdin = sql_file
  )

  if (length(output) == 0) {
    return(data.frame())
  }

  read.csv(
    text = paste(output, collapse = "\n"),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
}

sqlite_import_path <- function(path) {
  paste0('"', gsub('"', '""', normalizePath(path, mustWork = TRUE), fixed = TRUE), '"')
}

import_csv_to_table <- function(sqlite, db_path, csv_path, table_name) {
  import_script <- tempfile(fileext = ".sql")
  writeLines(
    c(
      ".mode csv",
      paste(".import --skip 1", sqlite_import_path(csv_path), table_name)
    ),
    import_script
  )
  invisible(run_checked(sqlite, db_path, stdin = import_script))
}

normalise_column_name <- function(value) {
  value <- tolower(trimws(value))
  value <- gsub("[^a-z0-9]+", "_", value)
  gsub("^_|_$", "", value)
}

find_column <- function(headers, candidates) {
  match_index <- match(candidates, headers)
  match_index <- match_index[!is.na(match_index)]

  if (length(match_index) == 0) {
    return(NA_integer_)
  }

  match_index[[1]]
}

parse_user_dates <- function(values) {
  values <- trimws(as.character(values))
  parsed <- rep(as.Date(NA), length(values))
  formats <- c("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y", "%Y/%m/%d")

  for (format in formats) {
    candidates <- suppressWarnings(as.Date(values, format = format))
    parsed[is.na(parsed) & !is.na(candidates)] <- candidates[is.na(parsed) & !is.na(candidates)]
  }

  parsed
}

numeric_values <- function(values, default = 0) {
  cleaned <- gsub("[$,[:space:]]", "", as.character(values))
  cleaned[cleaned == ""] <- NA_character_
  parsed <- suppressWarnings(as.numeric(cleaned))
  parsed[is.na(parsed)] <- default
  parsed
}

optional_numeric_values <- function(values) {
  cleaned <- gsub("[$,[:space:]]", "", as.character(values))
  cleaned[cleaned == ""] <- NA_character_
  suppressWarnings(as.numeric(cleaned))
}

column_or_default <- function(data, column, default) {
  if (is.na(column)) {
    if (length(default) == nrow(data)) {
      return(default)
    }

    return(rep(default, nrow(data)))
  }

  data[[column]]
}

normalise_user_csv <- function(input_path) {
  raw <- read.csv(
    input_path,
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  if (nrow(raw) == 0) {
    stop("The input CSV has no data rows.", call. = FALSE)
  }

  headers <- normalise_column_name(names(raw))
  columns <- list(
    day = find_column(headers, c("day", "date", "reading_date", "timestamp", "meter_date")),
    household = find_column(headers, c("household_id", "account_id", "site_id", "meter_id", "customer_id")),
    neighbourhood = find_column(headers, c("neighbourhood", "neighborhood", "suburb", "area", "region")),
    peak = find_column(headers, c("peak_kwh", "peak", "peak_usage_kwh")),
    shoulder = find_column(headers, c("shoulder_kwh", "shoulder", "shoulder_usage_kwh")),
    offpeak = find_column(headers, c("offpeak_kwh", "off_peak_kwh", "offpeak", "off_peak")),
    solar = find_column(headers, c("solar_export_kwh", "solar_kwh", "export_kwh", "solar_export")),
    grid = find_column(headers, c("grid_import_kwh", "import_kwh", "grid_kwh", "usage_kwh", "consumption_kwh")),
    total = find_column(headers, c("total_kwh", "consumed_kwh", "energy_kwh", "kwh")),
    bill = find_column(headers, c("estimated_bill", "bill", "cost", "amount", "charge"))
  )

  if (is.na(columns$day)) {
    stop("The input CSV needs a date column named day, date, reading_date, or timestamp.", call. = FALSE)
  }

  has_tiered_usage <- !is.na(columns$peak) || !is.na(columns$shoulder) || !is.na(columns$offpeak)
  has_total_usage <- !is.na(columns$grid) || !is.na(columns$total)
  if (!has_tiered_usage && !has_total_usage) {
    stop("The input CSV needs grid_import_kwh, total_kwh, or peak/shoulder/offpeak kWh columns.", call. = FALSE)
  }

  dates <- parse_user_dates(raw[[columns$day]])
  valid_rows <- !is.na(dates)
  if (!any(valid_rows)) {
    stop("No valid dates were found in the input CSV.", call. = FALSE)
  }

  raw <- raw[valid_rows, , drop = FALSE]
  dates <- dates[valid_rows]

  supplied_total <- numeric_values(column_or_default(raw, columns$total, column_or_default(raw, columns$grid, 0)))
  peak <- numeric_values(column_or_default(raw, columns$peak, 0))
  shoulder <- numeric_values(column_or_default(raw, columns$shoulder, 0))
  offpeak <- numeric_values(column_or_default(raw, columns$offpeak, 0))

  if (!has_tiered_usage) {
    peak <- supplied_total * 0.44
    shoulder <- supplied_total * 0.34
    offpeak <- supplied_total * 0.22
  }

  solar <- numeric_values(column_or_default(raw, columns$solar, 0))
  grid <- if (is.na(columns$grid)) {
    pmax(0, peak + shoulder + offpeak - solar)
  } else {
    numeric_values(raw[[columns$grid]])
  }

  bill <- if (is.na(columns$bill)) {
    rep(NA_real_, nrow(raw))
  } else {
    optional_numeric_values(raw[[columns$bill]])
  }

  household <- as.character(column_or_default(raw, columns$household, "Unknown"))
  neighbourhood <- as.character(column_or_default(raw, columns$neighbourhood, "Ungrouped"))
  household[trimws(household) == ""] <- "Unknown"
  neighbourhood[trimws(neighbourhood) == ""] <- "Ungrouped"

  data.frame(
    day = format(dates, "%Y-%m-%d"),
    household_id = household,
    neighbourhood = neighbourhood,
    peak_kwh = round(peak, 4),
    shoulder_kwh = round(shoulder, 4),
    offpeak_kwh = round(offpeak, 4),
    solar_export_kwh = round(solar, 4),
    grid_import_kwh = round(grid, 4),
    estimated_bill = round(bill, 4),
    stringsAsFactors = FALSE
  )
}

write_table <- function(data, path) {
  write.csv(data, path, row.names = FALSE)
  message("Wrote table: ", path)
}

money <- function(x) {
  paste0("$", format(round(x, 2), big.mark = ",", nsmall = 2, trim = TRUE))
}

number <- function(x, digits = 1) {
  format(round(x, digits), big.mark = ",", nsmall = digits, trim = TRUE)
}

html_escape <- function(x) {
  x <- gsub("&", "&amp;", x, fixed = TRUE)
  x <- gsub("<", "&lt;", x, fixed = TRUE)
  x <- gsub(">", "&gt;", x, fixed = TRUE)
  x <- gsub('"', "&quot;", x, fixed = TRUE)
  x
}

js_embed_csv <- function(text) {
  x <- paste(text, collapse = "\n")
  x <- gsub("\\", "\\\\", x, fixed = TRUE)
  x <- gsub("\"", "\\\"", x, fixed = TRUE)
  x <- gsub("\r", "\\r", x, fixed = TRUE)
  x <- gsub("\n", "\\n", x, fixed = TRUE)
  x <- gsub("<", "\\u003c", x, fixed = TRUE)
  paste0("\"", x, "\"")
}

load_studio_workspace <- function(root, template_href = "../data/sample_energy_upload.csv") {
  path <- file.path(root, "assets", "studio-panel.html")
  html <- paste(readLines(path, warn = FALSE), collapse = "\n")
  html <- gsub("{{TEMPLATE_HREF}}", template_href, html, fixed = TRUE)
  html <- gsub("{{TARIFF_PEAK}}", "0.40", html, fixed = TRUE)
  html <- gsub("{{TARIFF_SHOULDER}}", "0.28", html, fixed = TRUE)
  html <- gsub("{{TARIFF_OFFPEAK}}", "0.18", html, fixed = TRUE)
  html <- gsub("{{TARIFF_EXPORT}}", "0.08", html, fixed = TRUE)
  html <- gsub("{{TARIFF_SUPPLY}}", "1.10", html, fixed = TRUE)
  html <- gsub("{{TARIFF_GST}}", "0.10", html, fixed = TRUE)
  html
}

studio_scripts_html <- function(source_csv = NULL, label = "Uploaded CSV") {
  bootstrap <- ""
  if (!is.null(source_csv) && nzchar(source_csv)) {
    bootstrap <- paste0(
      "<script>window.GRIDSCOPE_BOOTSTRAP = {csv: ",
      js_embed_csv(source_csv),
      ", label: ",
      js_embed_csv(label),
      "};</script>\n"
    )
  }
  paste0(
    bootstrap,
    "<script src=\"../assets/analysis.js\"></script>\n",
    "<script src=\"../assets/studio.js\"></script>\n"
  )
}

data_frame_to_html <- function(data, limit = 8) {
  data <- head(data, limit)
  header <- paste0("<th>", html_escape(names(data)), "</th>", collapse = "")
  rows <- apply(data, 1, function(row) {
    paste0("<tr>", paste0("<td>", html_escape(as.character(row)), "</td>", collapse = ""), "</tr>")
  })

  paste0(
    "<table><thead><tr>", header, "</tr></thead><tbody>",
    paste(rows, collapse = "\n"),
    "</tbody></table>"
  )
}

plot_monthly_usage <- function(monthly, path) {
  png(path, width = 1100, height = 720, res = 130)
  old_par <- par(mar = c(5, 5, 4, 5) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  x <- seq_len(nrow(monthly))
  plot(
    x,
    monthly$grid_import_kwh,
    type = "b",
    pch = 19,
    lwd = 3,
    col = "#2563eb",
    xaxt = "n",
    xlab = "",
    ylab = "Grid import (kWh)",
    main = "Monthly Grid Import and Solar Export"
  )
  lines(x, monthly$solar_export_kwh, type = "b", pch = 17, lwd = 3, col = "#f97316")
  axis(1, at = x, labels = monthly$month, las = 2)
  grid(col = "#d9d9d9")
  legend(
    "topright",
    legend = c("Grid import", "Solar export"),
    col = c("#2563eb", "#f97316"),
    pch = c(19, 17),
    lwd = 3,
    bty = "n"
  )
}

plot_plan_comparison <- function(plans, path) {
  png(path, width = 1000, height = 700, res = 130)
  old_par <- par(mar = c(7, 5, 4, 2) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  bars <- barplot(
    plans$avg_daily_bill,
    names.arg = plans$plan_name,
    col = c("#10b981", "#2563eb", "#8b5cf6"),
    border = NA,
    las = 2,
    ylab = "Average daily bill",
    main = "Average Daily Bill by Energy Plan"
  )
  text(
    bars,
    plans$avg_daily_bill,
    labels = money(plans$avg_daily_bill),
    pos = 3,
    cex = 0.9
  )
  grid(nx = NA, ny = NULL, col = "#d9d9d9")
}

plot_load_mix <- function(load_mix, path) {
  png(path, width = 1100, height = 720, res = 130)
  old_par <- par(mar = c(7, 5, 4, 8) + 0.1, xpd = TRUE)
  on.exit({
    par(old_par)
    dev.off()
  })

  mix <- t(as.matrix(load_mix[, c("peak_kwh", "shoulder_kwh", "offpeak_kwh", "solar_export_kwh")]))
  barplot(
    mix,
    names.arg = load_mix$neighbourhood,
    col = c("#ef4444", "#f59e0b", "#2563eb", "#10b981"),
    border = NA,
    las = 2,
    ylab = "Annual kWh",
    main = "Neighbourhood Load Mix"
  )
  legend(
    "topright",
    inset = c(-0.26, 0),
    legend = c("Peak", "Shoulder", "Off-peak", "Solar export"),
    fill = c("#ef4444", "#f59e0b", "#2563eb", "#10b981"),
    bty = "n"
  )
  grid(nx = NA, ny = NULL, col = "#d9d9d9")
}

plot_household_efficiency <- function(efficiency, path) {
  png(path, width = 1050, height = 720, res = 130)
  old_par <- par(mar = c(5, 5, 4, 2) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  has_solar <- efficiency$solar_kw > 0
  point_sizes <- 1.1 + efficiency$residents * 0.12

  plot(
    efficiency$kwh_per_resident,
    efficiency$annual_bill_per_resident,
    pch = 21,
    bg = ifelse(has_solar, "#10b981", "#f59e0b"),
    col = "#111827",
    cex = point_sizes,
    xlab = "Annual kWh per resident",
    ylab = "Annual bill per resident",
    main = "Household Efficiency"
  )
  grid(col = "#d9d9d9")
  legend(
    "topright",
    legend = c("Solar", "No solar"),
    pt.bg = c("#10b981", "#f59e0b"),
    pch = 21,
    bty = "n"
  )
}

plot_user_load_mix <- function(load_mix, path) {
  png(path, width = 900, height = 650, res = 130)
  old_par <- par(mar = c(6, 5, 4, 2) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  barplot(
    load_mix$kwh,
    names.arg = load_mix$load_type,
    col = c("#ef4444", "#f59e0b", "#2563eb", "#10b981"),
    border = NA,
    las = 2,
    ylab = "kWh",
    main = "Load Mix"
  )
  grid(nx = NA, ny = NULL, col = "#d9d9d9")
}

plot_user_anomalies <- function(anomalies, path) {
  png(path, width = 1000, height = 650, res = 130)
  old_par <- par(mar = c(7, 5, 4, 2) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  if (nrow(anomalies) == 0) {
    plot.new()
    text(0.5, 0.5, "No unusual usage days detected.", cex = 1.2)
    return(invisible(NULL))
  }

  labels <- paste(anomalies$day, anomalies$anomaly_type, sep = "\n")
  colors <- ifelse(anomalies$anomaly_type == "high_spike", "#ef4444", "#2563eb")
  bars <- barplot(
    anomalies$grid_import_kwh,
    names.arg = labels,
    col = colors,
    border = NA,
    las = 2,
    ylab = "Grid import (kWh)",
    main = "Unusual Usage Days"
  )
  text(
    bars,
    anomalies$grid_import_kwh,
    labels = paste0(anomalies$pct_of_average, "%"),
    pos = 3,
    cex = 0.8
  )
  grid(nx = NA, ny = NULL, col = "#d9d9d9")
}

plot_user_group_summary <- function(groups, path) {
  png(path, width = 1000, height = 650, res = 130)
  old_par <- par(mar = c(7, 5, 4, 2) + 0.1)
  on.exit({
    par(old_par)
    dev.off()
  })

  barplot(
    groups$grid_import_kwh,
    names.arg = groups$neighbourhood,
    col = "#2563eb",
    border = NA,
    las = 2,
    ylab = "Grid import (kWh)",
    main = "Grid Import by Group"
  )
  grid(nx = NA, ny = NULL, col = "#d9d9d9")
}

render_recommendation_cards <- function(recommendations) {
  if (nrow(recommendations) == 0) {
    return("<p>No major savings opportunities were flagged for this dataset.</p>")
  }

  cards <- apply(recommendations, 1, function(row) {
    paste0(
      "<li><strong>", html_escape(row[["opportunity"]]), "</strong> ",
      html_escape(row[["detail"]]), " <span class=\"impact impact-",
      html_escape(tolower(row[["potential_impact"]])), "\">",
      html_escape(row[["potential_impact"]]), " impact</span></li>"
    )
  })

  paste0("<ul class=\"insight-list\">", paste(cards, collapse = ""), "</ul>")
}

write_uploaded_report <- function(monthly, groups, load_mix, quality, anomalies, recommendations, path, root, source_csv = "") {
  total_bill <- if (all(is.na(monthly$estimated_bill))) {
    NA_real_
  } else {
    sum(monthly$estimated_bill, na.rm = TRUE)
  }
  highest_month <- monthly[order(monthly$grid_import_kwh, decreasing = TRUE), ][1, ]
  top_group <- groups[order(groups$grid_import_kwh, decreasing = TRUE), ][1, ]

  html <- paste0(
    "<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>", APP_TITLE, "</title>
<link rel=\"stylesheet\" href=\"../assets/studio.css\">
</head>
<body>
<header>
<p class=\"eyebrow\">GridScope 0.3.0</p>
<h1>", APP_TITLE, "</h1>
<p class=\"lede\">Personal energy analysis generated from your uploaded CSV. Use the studio to filter households, rebill a tariff, compare another file, and export the current table.</p>
</header>
<main>
",
    load_studio_workspace(root),
    "
<h2 class=\"demo-heading\">Pipeline snapshot</h2>
<section class=\"metrics\">
<div class=\"metric\"><span>Records</span><strong>", quality$records, "</strong></div>
<div class=\"metric\"><span>Days covered</span><strong>", quality$days, "</strong></div>
<div class=\"metric\"><span>Grid import</span><strong>", number(quality$grid_import_kwh, 1), " kWh</strong></div>
<div class=\"metric\"><span>Solar export</span><strong>", number(quality$solar_export_kwh, 1), " kWh</strong></div>
<div class=\"metric\"><span>Estimated cost</span><strong>", ifelse(is.na(total_bill), "Not supplied", money(total_bill)), "</strong></div>
</section>

<section class=\"report-section\">
<h2>Key Signals</h2>
<ul class=\"insight-list\">
<li>Highest grid import month: ", html_escape(highest_month$month), " at ", number(highest_month$grid_import_kwh, 1), " kWh.</li>
<li>Top grid import group: ", html_escape(top_group$neighbourhood), " at ", number(top_group$grid_import_kwh, 1), " kWh.</li>
<li>Solar exports equal ", number(quality$solar_export_pct, 1), "% of recorded consumption.</li>
<li>Peak usage is ", number(quality$peak_share_pct, 1), "% of recorded consumption.</li>
</ul>
</section>

<section class=\"report-section\">
<h2>Monthly Demand</h2>
<div class=\"figure\"><img src=\"figures/user_monthly_usage.png\" alt=\"Monthly grid import and solar export chart\"></div>
",
    data_frame_to_html(monthly, 12),
    "
</section>

<section class=\"report-section\">
<h2>Load Mix</h2>
<div class=\"figure\"><img src=\"figures/user_load_mix.png\" alt=\"Load mix chart\"></div>
",
    data_frame_to_html(load_mix, 8),
    "
</section>

<section class=\"report-section\">
<h2>Groups</h2>
<div class=\"figure\"><img src=\"figures/user_group_summary.png\" alt=\"Grid import by group chart\"></div>
",
    data_frame_to_html(groups, 10),
    "
</section>

<section class=\"report-section\">
<h2>Unusual Days</h2>
<div class=\"figure\"><img src=\"figures/user_anomalies.png\" alt=\"Unusual usage days chart\"></div>
",
    data_frame_to_html(anomalies, 10),
    "
</section>

<section class=\"report-section\">
<h2>Savings Opportunities</h2>
",
    render_recommendation_cards(recommendations),
    "
</section>
</main>
",
    studio_scripts_html(source_csv, "Uploaded CSV"),
    "</body>
</html>"
  )

  writeLines(html, path)
  message("Wrote custom report: ", path)
}

write_report <- function(monthly, efficiency, plans, load_mix, path, root) {
  total_import <- sum(monthly$grid_import_kwh)
  total_solar <- sum(monthly$solar_export_kwh)
  total_bill <- sum(monthly$estimated_bill)
  best_household <- efficiency[order(efficiency$efficiency_rank), ][1, ]
  best_plan <- plans[order(plans$avg_daily_bill), ][1, ]
  top_neighbourhood <- load_mix[order(load_mix$estimated_bill, decreasing = TRUE), ][1, ]

  html <- paste0(
    "<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>", APP_TITLE, "</title>
<link rel=\"stylesheet\" href=\"../assets/studio.css\">
</head>
<body>
<header>
<p class=\"eyebrow\">GridScope 0.3.0</p>
<h1>", APP_TITLE, "</h1>
<p class=\"lede\">Upload energy data, review clear charts, and spot cost and demand patterns without turning the page into a spreadsheet cave.</p>
</header>
<main>
",
    load_studio_workspace(root),
    "
<h2 class=\"demo-heading\">Demo Portfolio</h2>
<section class=\"metrics\">
<div class=\"metric\"><span>Annual grid import</span><strong>", number(total_import, 1), " kWh</strong></div>
<div class=\"metric\"><span>Solar exported</span><strong>", number(total_solar, 1), " kWh</strong></div>
<div class=\"metric\"><span>Estimated bills</span><strong>", money(total_bill), "</strong></div>
<div class=\"metric\"><span>Lowest average plan</span><strong>", html_escape(best_plan$plan_name), "</strong></div>
</section>

<h2>Monthly Demand</h2>
<p>Grid imports rise in hotter and colder months, while solar export peaks through the modeled summer profile.</p>
<div class=\"figure\"><img src=\"figures/monthly_usage.png\" alt=\"Monthly grid import and solar export chart\"></div>
",
    data_frame_to_html(monthly, 12),
    "
<h2>Plan Comparison</h2>
<p>", html_escape(best_plan$plan_name), " has the lowest average daily bill in this synthetic portfolio. The comparison also tracks peak-share exposure and solar export share by plan.</p>
<div class=\"figure\"><img src=\"figures/plan_comparison.png\" alt=\"Average daily bill by plan chart\"></div>
",
    data_frame_to_html(plans, 8),
    "
<h2>Neighbourhood Load Mix</h2>
<p>", html_escape(top_neighbourhood$neighbourhood), " has the highest estimated annual bill in the model, making it a useful candidate for demand response or solar export programs.</p>
<div class=\"figure\"><img src=\"figures/neighbourhood_load_mix.png\" alt=\"Neighbourhood load mix chart\"></div>
",
    data_frame_to_html(load_mix, 8),
    "
<h2>Household Efficiency</h2>
<p>The top-ranked household is #", best_household$household_id, " in ", html_escape(best_household$neighbourhood), ", with ", number(best_household$kwh_per_resident, 1), " kWh per resident.</p>
<div class=\"figure\"><img src=\"figures/household_efficiency.png\" alt=\"Household efficiency scatter plot\"></div>
",
    data_frame_to_html(efficiency, 10),
    "
</main>
",
    studio_scripts_html(),
    "</body>
</html>"
  )

  writeLines(html, path)
  message("Wrote report: ", path)
}

run_custom_analysis <- function(root, sqlite, input_path, output_path) {
  input_path <- if (grepl("^/", input_path)) {
    input_path
  } else {
    file.path(root, input_path)
  }
  input_path <- normalizePath(input_path, mustWork = TRUE)

  output_path <- if (is.null(output_path)) {
    file.path(root, "output", "custom-report.html")
  } else if (grepl("^/", output_path)) {
    output_path
  } else {
    file.path(root, output_path)
  }

  data_dir <- file.path(root, "data")
  output_dir <- dirname(output_path)
  table_dir <- file.path(output_dir, "tables")
  figure_dir <- file.path(output_dir, "figures")
  db_path <- file.path(data_dir, "user_energy.sqlite")
  normalised_csv <- file.path(data_dir, "user_readings_normalized.csv")

  dir.create(data_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(table_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(figure_dir, recursive = TRUE, showWarnings = FALSE)

  if (file.exists(db_path)) {
    unlink(db_path)
  }

  normalised <- normalise_user_csv(input_path)
  write.csv(normalised, normalised_csv, row.names = FALSE, na = "")
  message("Normalised input rows: ", nrow(normalised))

  execute_sql_file(sqlite, db_path, file.path(root, "sql", "user_upload_schema.sql"))
  import_csv_to_table(sqlite, db_path, normalised_csv, "user_readings")

  query_files <- c(
    user_monthly_usage = file.path(root, "sql", "queries", "user_monthly_usage.sql"),
    user_group_summary = file.path(root, "sql", "queries", "user_group_summary.sql"),
    user_load_mix = file.path(root, "sql", "queries", "user_load_mix.sql"),
    user_quality = file.path(root, "sql", "queries", "user_quality.sql"),
    user_anomalies = file.path(root, "sql", "queries", "user_anomalies.sql"),
    user_savings_opportunities = file.path(root, "sql", "queries", "user_savings_opportunities.sql")
  )

  tables <- lapply(query_files, function(path) query_to_frame(sqlite, db_path, path))

  for (name in names(tables)) {
    write_table(tables[[name]], file.path(table_dir, paste0(name, ".csv")))
  }

  plot_monthly_usage(tables$user_monthly_usage, file.path(figure_dir, "user_monthly_usage.png"))
  plot_user_group_summary(tables$user_group_summary, file.path(figure_dir, "user_group_summary.png"))
  plot_user_load_mix(tables$user_load_mix, file.path(figure_dir, "user_load_mix.png"))
  plot_user_anomalies(tables$user_anomalies, file.path(figure_dir, "user_anomalies.png"))

  write_uploaded_report(
    monthly = tables$user_monthly_usage,
    groups = tables$user_group_summary,
    load_mix = tables$user_load_mix,
    quality = tables$user_quality[1, ],
    anomalies = tables$user_anomalies,
    recommendations = tables$user_savings_opportunities,
    path = output_path,
    root = root,
    source_csv = paste(readLines(input_path, warn = FALSE), collapse = "\n")
  )

  message("Done. Open ", output_path, " to view the report.")
}

main <- function() {
  options <- parse_cli_args()
  root <- get_project_root()
  sqlite <- Sys.which("sqlite3")

  if (sqlite == "") {
    stop("sqlite3 was not found on PATH. Install SQLite and rerun this script.", call. = FALSE)
  }

  if (!is.null(options$input)) {
    run_custom_analysis(root, sqlite, options$input, options$output)
    return(invisible(NULL))
  }

  data_dir <- file.path(root, "data")
  table_dir <- file.path(root, "output", "tables")
  figure_dir <- file.path(root, "output", "figures")
  db_path <- file.path(data_dir, "energy_insights.sqlite")

  dir.create(data_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(table_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(figure_dir, recursive = TRUE, showWarnings = FALSE)

  if (file.exists(db_path)) {
    unlink(db_path)
  }

  execute_sql_file(sqlite, db_path, file.path(root, "sql", "schema.sql"))
  execute_sql_file(sqlite, db_path, file.path(root, "sql", "seed.sql"))

  query_files <- c(
    monthly_usage = file.path(root, "sql", "queries", "monthly_usage.sql"),
    household_efficiency = file.path(root, "sql", "queries", "household_efficiency.sql"),
    plan_comparison = file.path(root, "sql", "queries", "plan_comparison.sql"),
    neighbourhood_load_mix = file.path(root, "sql", "queries", "neighbourhood_load_mix.sql")
  )

  tables <- lapply(query_files, function(path) query_to_frame(sqlite, db_path, path))

  for (name in names(tables)) {
    write_table(tables[[name]], file.path(table_dir, paste0(name, ".csv")))
  }

  plot_monthly_usage(tables$monthly_usage, file.path(figure_dir, "monthly_usage.png"))
  plot_plan_comparison(tables$plan_comparison, file.path(figure_dir, "plan_comparison.png"))
  plot_load_mix(tables$neighbourhood_load_mix, file.path(figure_dir, "neighbourhood_load_mix.png"))
  plot_household_efficiency(tables$household_efficiency, file.path(figure_dir, "household_efficiency.png"))

  write_report(
    monthly = tables$monthly_usage,
    efficiency = tables$household_efficiency,
    plans = tables$plan_comparison,
    load_mix = tables$neighbourhood_load_mix,
    path = file.path(root, "output", "report.html"),
    root = root
  )

  message("Done. Open output/report.html to view the report.")
}

main()
