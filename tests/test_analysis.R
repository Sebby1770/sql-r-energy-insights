#!/usr/bin/env Rscript
#
# Tests for the R pipeline. No testthat dependency, so CI needs only base R.
#
#   Rscript tests/test_analysis.R
#
# Covers the parsing and reporting logic that used to have no coverage at all:
# date-format detection, numeric coercion, HTML rendering of empty and NA
# frames, and the end-to-end SQL path including anomaly detection.

root <- normalizePath(
  file.path(
    dirname(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1]])),
    ".."
  )
)

source(file.path(root, "R", "run_analysis.R"))

passed <- 0
failures <- character(0)

test <- function(name, body) {
  result <- tryCatch(
    {
      suppressMessages(body())
      TRUE
    },
    error = function(e) {
      failures <<- c(failures, paste0(name, "\n    ", conditionMessage(e)))
      FALSE
    }
  )
  if (isTRUE(result)) {
    passed <<- passed + 1
  }
}

expect <- function(condition, message = "expectation failed") {
  if (!isTRUE(condition)) {
    stop(message, call. = FALSE)
  }
}

expect_equal <- function(actual, expected, message = "not equal") {
  if (!isTRUE(all.equal(actual, expected))) {
    stop(
      paste0(message, ": got ", paste(format(actual), collapse = ", "),
             ", expected ", paste(format(expected), collapse = ", ")),
      call. = FALSE
    )
  }
}

expect_error <- function(body, pattern = NULL) {
  caught <- tryCatch({
    body()
    NULL
  }, error = function(e) conditionMessage(e))

  if (is.null(caught)) {
    stop("expected an error but none was raised", call. = FALSE)
  }
  if (!is.null(pattern) && !grepl(pattern, caught, fixed = TRUE)) {
    stop(paste0("wrong error: ", caught, " (wanted ", pattern, ")"), call. = FALSE)
  }
}

write_temp_csv <- function(lines) {
  path <- tempfile(fileext = ".csv")
  writeLines(lines, path)
  path
}

# ---------------------------------------------------------------- columns --

test("normalise_column_name matches the browser normaliser", {
  expect_equal(normalise_column_name("  Grid Import (kWh) "), "grid_import_kwh")
  expect_equal(normalise_column_name("Off-Peak"), "off_peak")
})

test("find_column returns the first candidate present", {
  headers <- c("date", "usage_kwh", "suburb")
  expect_equal(find_column(headers, c("day", "date")), 1L)
  expect_equal(find_column(headers, c("grid_import_kwh", "usage_kwh")), 2L)
  expect(is.na(find_column(headers, c("nope"))), "missing column should be NA")
})

# ------------------------------------------------------------------ dates --

test("detect_date_format picks ISO when present", {
  detection <- detect_date_format(c("2025-01-02", "2025-03-04"))
  expect_equal(detection$format, "iso")
  expect_equal(detection$parsed_count, 2L)
  expect_equal(format(detection$parsed, "%Y-%m-%d"), c("2025-01-02", "2025-03-04"))
})

test("layouts match the whole string, never a prefix", {
  # as.Date("1/2/2024", "%Y/%m/%d") returns year 1 — a wrong date that also won
  # on parse count, quietly shifting an entire column.
  expect(is.na(apply_date_layout("1/2/2024", DATE_LAYOUTS[[1]])), "iso must not match d/m/y")
  expect(is.na(apply_date_layout("2025-01-02 08:00", DATE_LAYOUTS[[1]])), "no trailing junk")
})

test("impossible calendar days are rejected, not rolled forward", {
  expect(is.na(make_date(2025, 2, 31)), "31 February must not become 3 March")
  expect(is.na(make_date(2025, 13, 1)), "month 13 is invalid")
  expect(!is.na(make_date(2024, 2, 29)), "2024 is a leap year")
  expect(is.na(make_date(2025, 2, 29)), "2025 is not")
})

test("two-digit years are read as 20xx", {
  expect_equal(format(parse_user_dates("05/06/24"), "%Y-%m-%d"), "2024-06-05")
})

test("one format is chosen for the whole column", {
  # 13 can only be a day, so every value is day-first — including "1/2/2024",
  # which the old per-value loop read as 1 February under one format while
  # reading its neighbour under another.
  dates <- parse_user_dates(c("1/2/2024", "13/2/2024", "28/2/2024"))
  expect_equal(format(dates, "%Y-%m-%d"), c("2024-02-01", "2024-02-13", "2024-02-28"))
})

test("month-first columns are detected when day-first cannot fit", {
  dates <- parse_user_dates(c("2/13/2024", "3/14/2024"))
  expect_equal(format(dates, "%Y-%m-%d"), c("2024-02-13", "2024-03-14"))
})

test("ambiguous slash columns are recognised", {
  expect(is_ambiguous_slash_column(c("01/02/2024", "03/04/2024")), "both <= 12 is ambiguous")
  expect(!is_ambiguous_slash_column(c("13/02/2024", "28/04/2024")), "13 cannot be a month")
  expect(!is_ambiguous_slash_column(c("2024-01-02")), "ISO is never ambiguous")
})

test("unparseable dates come back as NA rather than a wrong date", {
  dates <- parse_user_dates(c("2025-01-01", "not a date", "2025-01-03"))
  expect_equal(sum(is.na(dates)), 1L)
})

# --------------------------------------------------------------- numerics --

test("numeric_values strips currency and separators", {
  expect_equal(numeric_values(c("$1,234.50", " 12 ", "")), c(1234.5, 12, 0))
})

test("unreadable values are counted rather than silently zeroed", {
  reset_coercion_log()
  values <- numeric_values(c("10", "n/a", "12"))
  expect_equal(values, c(10, 0, 12))
  expect_equal(COERCION_LOG$unreadable, 1L)
})

test("blank cells are not counted as unreadable", {
  reset_coercion_log()
  numeric_values(c("10", "", "12"))
  expect_equal(COERCION_LOG$unreadable, 0L)
})

test("optional_numeric_values keeps NA for blanks", {
  values <- optional_numeric_values(c("10", "", "x"))
  expect_equal(values[[1]], 10)
  expect(is.na(values[[2]]), "blank should stay NA")
  expect(is.na(values[[3]]), "unparseable should stay NA")
})

# ------------------------------------------------------------ normalising --

test("a tiered CSV is marked as measured", {
  path <- write_temp_csv(c(
    "day,peak_kwh,shoulder_kwh,offpeak_kwh",
    "2025-01-01,8,6,4"
  ))
  frame <- normalise_user_csv(path)
  expect_equal(nrow(frame), 1L)
  expect_equal(attr(frame, "tier_source"), "measured")
  expect_equal(frame$peak_kwh, 8)
})

test("a total-only CSV is marked as estimated and split by the documented shares", {
  path <- write_temp_csv(c("day,total_kwh", "2025-01-01,20"))
  frame <- normalise_user_csv(path)
  expect_equal(attr(frame, "tier_source"), "estimated")
  expect_equal(frame$peak_kwh, round(20 * ESTIMATED_TIER_SHARES$peak, 4))
  expect_equal(frame$shoulder_kwh, round(20 * ESTIMATED_TIER_SHARES$shoulder, 4))
  expect_equal(frame$offpeak_kwh, round(20 * ESTIMATED_TIER_SHARES$offpeak, 4))
})

test("grid import is derived from consumption minus solar and never negative", {
  path <- write_temp_csv(c(
    "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh",
    "2025-01-01,8,6,4,5",
    "2025-01-02,1,1,1,50"
  ))
  frame <- normalise_user_csv(path)
  expect_equal(frame$grid_import_kwh, c(13, 0))
})

test("rows with unreadable dates are dropped and counted", {
  path <- write_temp_csv(c(
    "day,grid_import_kwh",
    "2025-01-01,10",
    "rubbish,12",
    "2025-01-03,11"
  ))
  frame <- normalise_user_csv(path)
  expect_equal(nrow(frame), 2L)
  expect_equal(attr(frame, "skipped_rows"), 1L)
})

test("missing household and group columns get stable defaults", {
  path <- write_temp_csv(c("day,grid_import_kwh", "2025-01-01,10"))
  frame <- normalise_user_csv(path)
  expect_equal(frame$household_id, "Unknown")
  expect_equal(frame$neighbourhood, "Ungrouped")
})

test("a CSV with no date column is rejected with a useful message", {
  path <- write_temp_csv(c("foo,bar", "1,2"))
  expect_error(function() normalise_user_csv(path), "needs a date column")
})

test("a CSV with no energy column is rejected", {
  path <- write_temp_csv(c("day", "2025-01-01"))
  expect_error(function() normalise_user_csv(path), "needs grid_import_kwh")
})

test("an empty CSV is rejected", {
  path <- write_temp_csv(c("day,grid_import_kwh"))
  expect_error(function() normalise_user_csv(path), "no data rows")
})

# ------------------------------------------------------------------ html ---

test("html_escape neutralises markup", {
  expect_equal(html_escape("<b>&\"x\""), "&lt;b&gt;&amp;&quot;x&quot;")
})

test("data_frame_to_html renders an empty frame instead of crashing", {
  out <- data_frame_to_html(data.frame())
  expect(grepl("No rows", out, fixed = TRUE), "empty frame should say so")
})

test("data_frame_to_html renders NA as a dash, not the string NA", {
  frame <- data.frame(month = c("2025-01"), bill = NA_real_, stringsAsFactors = FALSE)
  out <- data_frame_to_html(frame)
  expect(grepl("—", out, fixed = TRUE), "NA should render as an em dash")
  expect(!grepl("<td>NA</td>", out, fixed = TRUE), "the literal NA should not appear")
})

test("data_frame_to_html escapes cell contents", {
  frame <- data.frame(name = "<script>", stringsAsFactors = FALSE)
  out <- data_frame_to_html(frame)
  expect(grepl("&lt;script&gt;", out, fixed = TRUE), "cells must be escaped")
  expect(!grepl("<script>", out, fixed = TRUE), "raw markup must not survive")
})

test("data_frame_to_html honours its row limit", {
  frame <- data.frame(x = 1:20)
  out <- data_frame_to_html(frame, limit = 3)
  expect_equal(lengths(regmatches(out, gregexpr("<tr>", out)))[[1]], 4L) # header + 3
})

test("top_row returns NULL for an empty frame", {
  expect(is.null(top_row(data.frame(), "x")), "empty frame should give NULL")
  expect(is.null(top_row(NULL, "x")), "NULL frame should give NULL")
  expect(is.null(top_row(data.frame(y = 1), "x")), "missing column should give NULL")
})

test("top_row picks the largest or smallest as asked", {
  frame <- data.frame(name = c("a", "b", "c"), value = c(2, 9, 5), stringsAsFactors = FALSE)
  expect_equal(top_row(frame, "value")$name, "b")
  expect_equal(top_row(frame, "value", decreasing = FALSE)$name, "a")
})

test("the studio workspace has no unfilled tokens and links the NEM12 sample", {
  html <- load_studio_workspace(root)
  expect(!grepl("{{", html, fixed = TRUE), "every {{TOKEN}} should be filled")
  expect(grepl("../data/sample_nem12.csv", html, fixed = TRUE), "NEM12 sample link")
})

test("NEM12 files are recognised so the R pipeline can refuse them clearly", {
  expect(is_nem12_file(file.path(root, "data", "sample_nem12.csv")), "sample NEM12 detected")
  expect(!is_nem12_file(file.path(root, "data", "sample_energy_upload.csv")), "column CSV is not NEM12")
})

test("top_row returns NULL for an empty frame instead of a row of NAs", {
  expect(is.null(top_row(data.frame(x = numeric(0)), "x")), "empty frame")
  expect_equal(top_row(data.frame(x = c(1, 3, 2)), "x")$x, 3)
  expect_equal(top_row(data.frame(x = c(1, 3, 2)), "x", decreasing = FALSE)$x, 1)
})

test("money and number format predictably", {
  expect_equal(money(1234.5), "$1,234.50")
  expect_equal(number(1234.56, 1), "1,234.6")
})

# ------------------------------------------------------------ end-to-end ---

sqlite <- Sys.which("sqlite3")

if (sqlite == "") {
  message("sqlite3 not on PATH — skipping the end-to-end SQL tests.")
} else {
  build_db <- function(frame) {
    dir <- tempfile()
    dir.create(dir)
    db <- file.path(dir, "test.sqlite")
    csv <- file.path(dir, "rows.csv")
    write.csv(frame, csv, row.names = FALSE, na = "")
    execute_sql_file(sqlite, db, file.path(root, "sql", "user_upload_schema.sql"))
    import_csv_to_table(sqlite, db, csv, "user_readings")
    execute_sql_file(sqlite, db, file.path(root, "sql", "user_upload_finalise.sql"))
    db
  }

  synthetic <- function(household, values, start = as.Date("2025-01-01")) {
    data.frame(
      day = format(start + seq_along(values) - 1, "%Y-%m-%d"),
      household_id = household,
      neighbourhood = "Test",
      peak_kwh = round(values * 0.4, 4),
      shoulder_kwh = round(values * 0.35, 4),
      offpeak_kwh = round(values * 0.25, 4),
      solar_export_kwh = 0,
      grid_import_kwh = values,
      estimated_bill = NA_real_,
      tier_source = "measured",
      stringsAsFactors = FALSE
    )
  }

  test("stderr from sqlite no longer contaminates query results", {
    db <- build_db(synthetic("H-1", c(10, 11, 12)))
    query <- tempfile(fileext = ".sql")
    # A statement that succeeds but makes sqlite write to stderr; under the old
    # merged-stream implementation this line landed in the parsed CSV.
    writeLines(c(
      ".output stderr",
      "SELECT 'a warning from sqlite';",
      ".output stdout",
      "SELECT COUNT(*) AS n FROM user_readings;"
    ), query)
    frame <- query_to_frame(sqlite, db, query)
    expect_equal(names(frame), "n")
    expect_equal(frame$n, 3L)
  })

  test("a household with one spike yields exactly one anomaly", {
    db <- build_db(synthetic("H-1", c(10, 10.5, 9.8, 10.2, 10.1, 9.9, 10.3, 40, 10.0, 9.7)))
    frame <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_anomalies.sql"))
    expect_equal(nrow(frame), 1L)
    expect_equal(frame$anomaly_type, "high_spike")
    expect_equal(frame$grid_import_kwh, 40)
    expect_equal(frame$method, "mad")
  })

  test("household size differences are not flagged as anomalies", {
    frame <- rbind(
      synthetic("big", c(40, 41, 39, 40.5, 39.5, 40.2, 40.1)),
      synthetic("small", c(5, 5.2, 4.9, 5.1, 5.0, 4.8, 5.05))
    )
    db <- build_db(frame)
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_anomalies.sql"))
    expect_equal(nrow(result), 0L)
  })

  test("an extreme outlier does not hide a second genuine spike", {
    # The mean-based rule missed the 25 kWh day because the 200 kWh day pushed
    # the mean above it; the median is unmoved.
    db <- build_db(synthetic("H-1", c(10, 10, 10, 10, 10, 10, 10, 10, 200, 25)))
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_anomalies.sql"))
    expect_equal(sort(result$grid_import_kwh), c(25, 200))
  })

  test("a flat series produces no anomalies and no division by zero", {
    db <- build_db(synthetic("H-1", rep(10, 8)))
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_anomalies.sql"))
    expect_equal(nrow(result), 0L)
  })

  test("short histories fall back to the ratio rule", {
    db <- build_db(synthetic("H-1", c(10, 10, 30)))
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_anomalies.sql"))
    expect_equal(nrow(result), 1L)
    expect_equal(result$method, "ratio")
  })

  test("the quality query reports the tier source and negative rows", {
    frame <- synthetic("H-1", c(10, 11, 12))
    frame$grid_import_kwh[[2]] <- -5
    db <- build_db(frame)
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_quality.sql"))
    expect_equal(result$records, 3L)
    expect_equal(result$tier_source, "measured")
    expect_equal(result$negative_rows, 1L)
  })

  test("query results keep their header row on current sqlite", {
    db <- build_db(synthetic("H-1", c(10, 11, 12)))
    query <- tempfile(fileext = ".sql")
    writeLines("SELECT household_id, COUNT(*) AS days FROM user_readings GROUP BY household_id;", query)
    frame <- query_to_frame(sqlite, db, query)
    expect_equal(names(frame), c("household_id", "days"))
    expect_equal(frame$days, 3L)
  })

  test("blank bills import as missing, not as a $0 bill", {
    frame <- synthetic("H-1", c(10, 11))
    frame$estimated_bill <- c(NA, 4.5)
    db <- build_db(frame)
    query <- tempfile(fileext = ".sql")
    writeLines("SELECT COUNT(estimated_bill) AS billed FROM user_readings;", query)
    expect_equal(query_to_frame(sqlite, db, query)$billed, 1L)
  })

  test("a seasonal baseline does not flag an ordinary winter", {
    # 60 days at ~10 kWh, then 60 days at ~16 kWh (heating): a whole-year
    # baseline would flag the winter; the +/- 15 day window should not.
    wobble <- rep(c(0, 0.4, -0.3, 0.2, -0.1, 0.3, -0.4, 0.1, -0.2, 0), 12)
    values <- c(rep(10, 60), rep(16, 60)) + wobble
    frame <- query_to_frame(
      sqlite, build_db(synthetic("H-1", values)),
      file.path(root, "sql", "queries", "user_anomalies.sql")
    )
    expect_equal(nrow(frame), 0L, "no anomalies expected")
  })

  python <- Sys.which("python3")
  if (python == "") {
    message("python3 not on PATH — skipping the SQL vs Python anomaly parity tests.")
  } else {
    python_anomalies <- function(path) {
      script <- paste(
        "import sys",
        "from gridscope.analysis import get_anomalies, load_csv",
        "for a in get_anomalies(load_csv(sys.argv[1])):",
        "    z = '' if a['z_score'] is None else repr(a['z_score'])",
        "    print(','.join([a['household'], a['day'], a['anomaly_type'], a['method'], z]))",
        sep = "\n"
      )
      script_path <- tempfile(fileext = ".py")
      writeLines(script, script_path)
      old <- setwd(root)
      on.exit(setwd(old), add = TRUE)
      lines <- system2(python, c(script_path, path), stdout = TRUE, env = paste0("PYTHONPATH=", root))
      if (!is.null(attr(lines, "status"))) stop("python3 could not run the engine", call. = FALSE)
      if (length(lines) == 0) {
        return(data.frame(household = character(0), day = character(0), type = character(0),
                          method = character(0), z = numeric(0), stringsAsFactors = FALSE))
      }
      parts <- do.call(rbind, strsplit(lines, ",", fixed = TRUE))
      if (ncol(parts) == 4) parts <- cbind(parts, "")
      data.frame(household = parts[, 1], day = parts[, 2], type = parts[, 3], method = parts[, 4],
                 z = suppressWarnings(as.numeric(parts[, 5])), stringsAsFactors = FALSE)
    }

    sql_anomalies <- function(path) {
      normalised <- normalise_user_csv(path)
      frame <- query_to_frame(sqlite, build_db(normalised), file.path(root, "sql", "queries", "user_anomalies.sql"))
      data.frame(household = frame$household_id, day = frame$day, type = frame$anomaly_type,
                 method = frame$method, z = as.numeric(frame$modified_z), stringsAsFactors = FALSE)
    }

    for (sample in c("data/sample_energy_upload.csv", "tests/fixtures/legacy_sample.csv")) {
      local({
        sample_path <- file.path(root, sample)
        test(paste("SQL anomalies match the Python engine on", sample), {
          py <- python_anomalies(sample_path)
          sql <- sql_anomalies(sample_path)
          key <- function(frame) paste(frame$household, frame$day, frame$type, frame$method)
          expect_equal(sort(key(sql)), sort(key(py)), "flagged household-days")
          py <- py[order(key(py)), ]
          sql <- sql[order(key(sql)), ]
          both <- !is.na(py$z)
          expect(identical(both, !is.na(sql$z)), "z present for the same rows")
          expect(all(abs(py$z[both] - sql$z[both]) < 1e-6), "z-scores agree to 1e-6")
        })
      })
    }
  }

  test("monthly usage groups by calendar month and carries a trend column", {
    frame <- rbind(
      synthetic("H-1", rep(10, 5), start = as.Date("2025-01-01")),
      synthetic("H-1", rep(20, 5), start = as.Date("2025-02-01"))
    )
    db <- build_db(frame)
    result <- query_to_frame(sqlite, db, file.path(root, "sql", "queries", "user_monthly_usage.sql"))
    expect_equal(result$month, c("2025-01", "2025-02"))
    expect_equal(result$grid_import_kwh, c(50, 100))
    expect_equal(result$month_over_month_import_kwh[[2]], 50)
  })
}

# ----------------------------------------------------------------- report ---

if (length(failures) > 0) {
  cat("\n", length(failures), " failing, ", passed, " passing\n\n", sep = "")
  for (failure in failures) {
    cat("  x ", failure, "\n", sep = "")
  }
  quit(save = "no", status = 1)
}

cat(passed, "passing\n")
