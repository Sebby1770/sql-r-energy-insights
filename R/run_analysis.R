#!/usr/bin/env Rscript

get_project_root <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_arg <- grep("^--file=", args, value = TRUE)

  if (length(file_arg) == 0) {
    return(normalizePath(getwd(), mustWork = TRUE))
  }

  script_path <- normalizePath(sub("^--file=", "", file_arg[[1]]), mustWork = TRUE)
  normalizePath(file.path(dirname(script_path), ".."), mustWork = TRUE)
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

write_report <- function(monthly, efficiency, plans, load_mix, path) {
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
<title>SQL + R Energy Insights</title>
<style>
:root { color-scheme: light; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f7f8fb;
  color: #172033;
}
header {
  background: #172033;
  color: #ffffff;
  padding: 44px 7vw 36px;
}
main {
  max-width: 1120px;
  margin: 0 auto;
  padding: 30px 20px 54px;
}
h1 { margin: 0 0 10px; font-size: 2.4rem; letter-spacing: 0; }
h2 { margin: 34px 0 14px; color: #172033; }
p { line-height: 1.6; }
.lede { max-width: 760px; color: #dbeafe; }
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
  margin: 22px 0;
}
.metric {
  background: #ffffff;
  border: 1px solid #e3e8f2;
  border-radius: 8px;
  padding: 16px;
}
.metric span {
  display: block;
  color: #667085;
  font-size: 0.88rem;
}
.metric strong {
  display: block;
  margin-top: 7px;
  font-size: 1.35rem;
}
.figure {
  background: #ffffff;
  border: 1px solid #e3e8f2;
  border-radius: 8px;
  padding: 12px;
  margin: 16px 0;
}
.figure img {
  display: block;
  width: 100%;
  height: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  background: #ffffff;
  border: 1px solid #e3e8f2;
  border-radius: 8px;
  overflow: hidden;
}
th, td {
  padding: 9px 10px;
  border-bottom: 1px solid #e3e8f2;
  text-align: left;
  font-size: 0.92rem;
}
th {
  background: #edf2f7;
  color: #344054;
}
tr:last-child td { border-bottom: 0; }
</style>
</head>
<body>
<header>
<h1>SQL + R Energy Insights</h1>
<p class=\"lede\">A compact analytics pipeline built with SQL and base R. SQL creates the SQLite data model, seeds a synthetic year of energy readings, and runs reusable analysis queries. R executes the pipeline and turns the results into tables, charts, and this report.</p>
</header>
<main>
<section class=\"metrics\">
<div class=\"metric\"><span>Annual grid import</span><strong>", number(total_import, 1), " kWh</strong></div>
<div class=\"metric\"><span>Solar exported</span><strong>", number(total_solar, 1), " kWh</strong></div>
<div class=\"metric\"><span>Estimated bills</span><strong>", money(total_bill), "</strong></div>
<div class=\"metric\"><span>Lowest average plan</span><strong>", html_escape(best_plan$plan_name), "</strong></div>
</section>

<h2>Monthly Demand</h2>
<p>Grid imports rise in hotter and colder months, while solar export peaks through the summer profile generated in SQL.</p>
<div class=\"figure\"><img src=\"figures/monthly_usage.png\" alt=\"Monthly grid import and solar export chart\"></div>
",
    data_frame_to_html(monthly, 12),
    "
<h2>Plan Comparison</h2>
<p>", html_escape(best_plan$plan_name), " has the lowest average daily bill in this synthetic portfolio. The query also tracks peak-share exposure and solar export share by plan.</p>
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
</body>
</html>"
  )

  writeLines(html, path)
  message("Wrote report: ", path)
}

main <- function() {
  root <- get_project_root()
  sqlite <- Sys.which("sqlite3")

  if (sqlite == "") {
    stop("sqlite3 was not found on PATH. Install SQLite and rerun this script.", call. = FALSE)
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
    path = file.path(root, "output", "report.html")
  )

  message("Done. Open output/report.html to view the report.")
}

main()
