(function () {
  // Offline fallback for the "Try Sample" button: six weeks of one
  // household's readings, including a real spike, so the anomaly detector
  // has something to find. When the page is served over http the button
  // loads the full year from data/sample_energy_upload.csv instead.
  const sampleCsv = `day,household_id,neighbourhood,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh,grid_import_kwh,estimated_bill
2024-12-19,H-101,Northbank,5.48,5.45,3.73,4.64,10.02,5.36
2024-12-20,H-101,Northbank,7.09,5.22,4.55,4.96,11.9,6.11
2024-12-21,H-101,Northbank,9.13,7.1,5.12,4.37,16.99,7.64
2024-12-22,H-101,Northbank,7.95,7.98,5.14,4.31,16.75,7.4
2024-12-23,H-101,Northbank,6.87,5.04,4.07,5.2,10.79,5.86
2024-12-24,H-101,Northbank,6.74,5.78,4.17,4.54,12.16,6.08
2024-12-25,H-101,Northbank,8.18,7.57,4.88,4.9,15.74,7.29
2024-12-26,H-101,Northbank,7.34,6.31,4.72,5.24,13.13,6.53
2024-12-27,H-101,Northbank,7.2,7.07,4.94,4.8,14.41,6.75
2024-12-28,H-101,Northbank,9.51,8.54,5.56,5.56,18.05,8.2
2024-12-29,H-101,Northbank,8.41,8.65,5.94,4.83,18.16,7.89
2024-12-30,H-101,Northbank,6.3,5.81,4.12,4.15,12.08,5.92
2024-12-31,H-101,Northbank,7.7,6.97,4.63,4.96,14.34,6.87
2025-01-01,H-101,Northbank,6.62,7.27,3.95,5.17,12.67,6.35
2025-01-02,H-101,Northbank,7.44,6.43,4.59,5.4,13.06,6.57
2025-01-03,H-101,Northbank,7.36,5.9,4.33,5.59,12,6.32
2025-01-04,H-101,Northbank,7.67,6.93,4.09,5.2,13.5,6.73
2025-01-05,H-101,Northbank,8.79,8.33,5.29,4.52,17.88,7.86
2025-01-06,H-101,Northbank,8.41,7.17,5.03,5.2,15.41,7.28
2025-01-07,H-101,Northbank,6.21,5.72,3.83,5.86,9.9,5.68
2025-01-08,H-101,Northbank,6.47,6.81,3.53,5.95,10.87,6.03
2025-01-09,H-101,Northbank,6.61,6.34,3.99,3.67,13.28,6.21
2025-01-10,H-101,Northbank,6.8,6.65,4.08,4.54,13,6.33
2025-01-11,H-101,Northbank,7.73,8.05,5.54,6.01,15.31,7.28
2025-01-12,H-101,Northbank,8.89,7.69,5.4,4.09,17.89,7.78
2025-01-13,H-101,Northbank,7.59,7.18,4.27,5.04,14.01,6.81
2025-01-14,H-101,Northbank,6.29,5,3.7,5.33,9.68,5.53
2025-01-15,H-101,Northbank,6.59,5.6,3.9,4.62,11.46,5.9
2025-01-16,H-101,Northbank,7.26,7.16,4.19,4.74,13.88,6.67
2025-01-17,H-101,Northbank,7.58,6.41,4.73,5.89,12.83,6.62
2025-01-18,H-101,Northbank,20.88,19.09,13.11,4.68,48.4,17.43
2025-01-19,H-101,Northbank,8.39,7,4.09,5.73,13.75,7.01
2025-01-20,H-101,Northbank,7.02,5.41,3.66,4.65,11.44,5.98
2025-01-21,H-101,Northbank,6.69,5.99,4.41,4.71,12.38,6.15
2025-01-22,H-101,Northbank,7.88,6.58,4.81,5.63,13.63,6.82
2025-01-23,H-101,Northbank,7.91,6.83,4.98,5.51,14.21,6.94
2025-01-24,H-101,Northbank,8.28,7.64,4.83,5.19,15.56,7.32
2025-01-25,H-101,Northbank,8.73,8.25,5.42,4.92,17.48,7.81
2025-01-26,H-101,Northbank,8.86,7.64,4.34,4.42,16.42,7.53
2025-01-27,H-101,Northbank,7.2,6.65,4.72,4.13,14.44,6.64
2025-01-28,H-101,Northbank,7.38,7.19,4.21,4.95,13.85,6.72
2025-01-29,H-101,Northbank,7.5,6.49,5.1,6.65,12.44,6.62
2025-01-30,H-101,Northbank,7.05,6.26,3.82,4.35,12.77,6.28
2025-01-31,H-101,Northbank,7.8,5.9,5.58,5.84,13.43,6.73
2025-02-01,H-101,Northbank,6.79,6.35,4.79,4.72,13.22,6.36`;

  // Must match ESTIMATED_TIER_SHARES in R/run_analysis.R.
  const ESTIMATED_TIER_SHARES = { peak: 0.44, shoulder: 0.34, offpeak: 0.22 };

  const colors = {
    blue: "#2563eb",
    green: "#10b981",
    amber: "#f59e0b",
    red: "#ef4444",
    violet: "#7c3aed",
    ink: "#172033",
    muted: "#667085",
    line: "#d9e2ef"
  };

  const $ = (selector) => document.querySelector(selector);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) {
      return "0";
    }
    return value.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) {
      return "Not supplied";
    }
    return value.toLocaleString(undefined, {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (char === "\"") {
        if (quoted && next === "\"") {
          field += "\"";
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === "," && !quoted) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") {
          i += 1;
        }
        row.push(field);
        if (row.some((cell) => cell.trim() !== "")) {
          rows.push(row);
        }
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }

    return rows;
  }

  function normaliseKey(value) {
    return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }

  function pickColumn(headers, candidates) {
    for (const candidate of candidates) {
      const index = headers.indexOf(candidate);
      if (index !== -1) {
        return index;
      }
    }
    return -1;
  }

  function toNumber(value) {
    const cleaned = String(value || "").replace(/[$,\s]/g, "");
    if (cleaned === "") {
      return 0;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function optionalNumber(value) {
    const cleaned = String(value || "").replace(/[$,\s]/g, "");
    if (cleaned === "") {
      return null;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // Dates are handled as plain calendar days, never as instants. Building a
  // Date at local midnight and then reading it back with toISOString() shifts
  // the day backwards in every timezone ahead of UTC — in Melbourne every row
  // in the anomaly table was labelled with the previous date.
  function isoDay(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function makeDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    const date = new Date(year, month - 1, day);
    // Rejects 31 February and friends, which Date silently rolls forward.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  const DATE_LAYOUTS = [
    { name: "iso", pattern: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, order: ["y", "m", "d"] },
    { name: "day-first", pattern: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/, order: ["d", "m", "y"] },
    { name: "month-first", pattern: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/, order: ["m", "d", "y"] }
  ];

  function applyLayout(raw, layout) {
    const match = String(raw).trim().match(layout.pattern);
    if (!match) {
      return null;
    }
    const values = {};
    layout.order.forEach((field, index) => {
      values[field] = Number(match[index + 1]);
    });
    const year = String(values.y).length <= 2 ? 2000 + values.y : values.y;
    return makeDate(year, values.m, values.d);
  }

  // A column has one date format, so pick it once for the whole column rather
  // than per value. Guessing per row meant "1/2/2024" and "13/2/2024" in the
  // same file were read under two different conventions, silently.
  function detectDateLayout(values) {
    let best = null;
    for (const layout of DATE_LAYOUTS) {
      let parsed = 0;
      for (const value of values) {
        if (applyLayout(value, layout)) {
          parsed += 1;
        }
      }
      if (!best || parsed > best.parsed) {
        best = { layout, parsed };
      }
    }
    if (!best || best.parsed === 0) {
      return { layout: null, parsed: 0, ambiguous: false };
    }

    // Both day-first and month-first fit when every component is <= 12.
    const ambiguous =
      best.layout.name === "day-first" &&
      values.some((value) => {
        const match = String(value).trim().match(DATE_LAYOUTS[1].pattern);
        return match && Number(match[1]) <= 12 && Number(match[2]) <= 12;
      });

    return { layout: best.layout, parsed: best.parsed, ambiguous };
  }

  // Kept for single values (and for the loose fallback); prefers the ISO form,
  // then day-first, matching the R pipeline's ordering.
  function parseDate(value, layout) {
    const raw = String(value || "").trim();
    if (!raw) {
      return null;
    }
    if (layout) {
      return applyLayout(raw, layout);
    }
    for (const candidate of DATE_LAYOUTS) {
      const parsed = applyLayout(raw, candidate);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  function normaliseRows(text) {
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      throw new Error("The CSV needs a header row and at least one data row.");
    }

    const headers = parsed[0].map(normaliseKey);
    const col = {
      day: pickColumn(headers, ["day", "date", "reading_date", "timestamp", "meter_date"]),
      household: pickColumn(headers, ["household_id", "account_id", "site_id", "meter_id", "customer_id"]),
      neighbourhood: pickColumn(headers, ["neighbourhood", "neighborhood", "suburb", "area", "region"]),
      peak: pickColumn(headers, ["peak_kwh", "peak", "peak_usage_kwh"]),
      shoulder: pickColumn(headers, ["shoulder_kwh", "shoulder", "shoulder_usage_kwh"]),
      offpeak: pickColumn(headers, ["offpeak_kwh", "off_peak_kwh", "offpeak", "off_peak"]),
      solar: pickColumn(headers, ["solar_export_kwh", "solar_kwh", "export_kwh", "solar_export"]),
      grid: pickColumn(headers, ["grid_import_kwh", "import_kwh", "grid_kwh", "usage_kwh", "consumption_kwh"]),
      total: pickColumn(headers, ["total_kwh", "consumed_kwh", "energy_kwh", "kwh"]),
      bill: pickColumn(headers, ["estimated_bill", "bill", "cost", "amount", "charge"])
    };

    if (col.day === -1) {
      throw new Error("Add a date column named day, date, reading_date, or timestamp.");
    }

    const hasTieredUsage = col.peak !== -1 || col.shoulder !== -1 || col.offpeak !== -1;
    const hasTotalUsage = col.grid !== -1 || col.total !== -1;
    if (!hasTieredUsage && !hasTotalUsage) {
      throw new Error("Add energy columns such as grid_import_kwh, total_kwh, peak_kwh, shoulder_kwh, or offpeak_kwh.");
    }

    const dateColumn = parsed.slice(1).map((row) => row[col.day]);
    const detection = detectDateLayout(dateColumn);
    const notes = [];
    if (detection.ambiguous) {
      notes.push("Dates like 03/05/2024 were read day-first. Use YYYY-MM-DD to be explicit.");
    }

    const rows = [];
    let skipped = 0;
    for (let i = 1; i < parsed.length; i += 1) {
      const raw = parsed[i];
      const date = parseDate(raw[col.day], detection.layout);
      if (!date) {
        skipped += 1;
        continue;
      }

      const suppliedTotal = col.total !== -1 ? toNumber(raw[col.total]) : toNumber(raw[col.grid]);
      let peak = col.peak !== -1 ? toNumber(raw[col.peak]) : 0;
      let shoulder = col.shoulder !== -1 ? toNumber(raw[col.shoulder]) : 0;
      let offpeak = col.offpeak !== -1 ? toNumber(raw[col.offpeak]) : 0;

      if (!hasTieredUsage && suppliedTotal > 0) {
        peak = suppliedTotal * ESTIMATED_TIER_SHARES.peak;
        shoulder = suppliedTotal * ESTIMATED_TIER_SHARES.shoulder;
        offpeak = suppliedTotal * ESTIMATED_TIER_SHARES.offpeak;
      }

      const consumed = peak + shoulder + offpeak;
      const solar = col.solar !== -1 ? toNumber(raw[col.solar]) : 0;
      const grid = col.grid !== -1 ? toNumber(raw[col.grid]) : Math.max(0, consumed - solar);
      const bill = col.bill !== -1 ? optionalNumber(raw[col.bill]) : null;

      rows.push({
        date,
        month: monthKey(date),
        household: col.household !== -1 && raw[col.household] ? String(raw[col.household]).trim() : "Unknown",
        neighbourhood: col.neighbourhood !== -1 && raw[col.neighbourhood] ? String(raw[col.neighbourhood]).trim() : "Ungrouped",
        peak,
        shoulder,
        offpeak,
        solar,
        grid,
        bill,
        consumed
      });
    }

    if (rows.length === 0) {
      throw new Error("No valid dated rows were found.");
    }

    if (skipped > 0) {
      notes.push(`${skipped} row(s) were skipped because their date could not be read.`);
    }
    if (!hasTieredUsage) {
      notes.push(
        `No peak/shoulder/offpeak columns, so the split was estimated at ` +
          `${Math.round(ESTIMATED_TIER_SHARES.peak * 100)}/` +
          `${Math.round(ESTIMATED_TIER_SHARES.shoulder * 100)}/` +
          `${Math.round(ESTIMATED_TIER_SHARES.offpeak * 100)}%. ` +
          `Peak share and load mix below are estimates.`
      );
    }

    rows.notes = notes;
    rows.tierSource = hasTieredUsage ? "measured" : "estimated";
    return rows;
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  }

  function aggregateBy(rows, keyFn) {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          records: 0,
          households: new Set(),
          peak: 0,
          shoulder: 0,
          offpeak: 0,
          solar: 0,
          grid: 0,
          bill: 0,
          billRows: 0,
          consumed: 0
        });
      }
      const group = groups.get(key);
      group.records += 1;
      group.households.add(row.household);
      group.peak += row.peak;
      group.shoulder += row.shoulder;
      group.offpeak += row.offpeak;
      group.solar += row.solar;
      group.grid += row.grid;
      group.consumed += row.consumed;
      if (row.bill !== null) {
        group.bill += row.bill;
        group.billRows += 1;
      }
    }

    return Array.from(groups.values()).map((group) => ({
      ...group,
      households: group.households.size,
      bill: group.billRows > 0 ? group.bill : null
    }));
  }

  function median(values) {
    if (values.length === 0) {
      return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }

  // 0.6745 rescales the median absolute deviation so the score is comparable
  // to a standard deviation for normally distributed data.
  const MODIFIED_Z_SCALE = 0.6745;
  const MODIFIED_Z_THRESHOLD = 3.5;
  const MIN_OBSERVATIONS_FOR_Z = 5;

  // Mirrors sql/queries/user_anomalies.sql. Comparing every row to the mean of
  // all rows meant the mean was inflated by the spikes it was meant to find,
  // and that a large household read as permanently "high" next to a small one.
  // Each household is now scored against its own median and MAD.
  function getAnomalies(rows) {
    if (rows.length === 0) {
      return [];
    }

    // One entry per household-day, so several readings for one day are summed
    // rather than compared individually.
    const byDay = new Map();
    for (const row of rows) {
      const key = `${isoDay(row.date)}\u0000${row.household}`;
      const existing = byDay.get(key);
      if (existing) {
        existing.grid += row.grid;
        existing.consumed += row.consumed;
        existing.bill = existing.bill === null ? row.bill : existing.bill + (row.bill || 0);
      } else {
        byDay.set(key, {
          day: isoDay(row.date),
          household: row.household,
          neighbourhood: row.neighbourhood,
          grid: row.grid,
          consumed: row.consumed,
          bill: row.bill
        });
      }
    }

    const daily = Array.from(byDay.values());
    const byHousehold = new Map();
    for (const entry of daily) {
      if (!byHousehold.has(entry.household)) {
        byHousehold.set(entry.household, []);
      }
      byHousehold.get(entry.household).push(entry);
    }

    const found = [];
    for (const entries of byHousehold.values()) {
      const grids = entries.map((entry) => entry.grid);
      const centre = median(grids);
      const mad = median(grids.map((value) => Math.abs(value - centre)));
      const useZ = mad > 0 && entries.length >= MIN_OBSERVATIONS_FOR_Z;

      for (const entry of entries) {
        const z = useZ ? (MODIFIED_Z_SCALE * (entry.grid - centre)) / mad : null;
        let anomalyType = "normal";
        if (useZ) {
          if (z >= MODIFIED_Z_THRESHOLD) {
            anomalyType = "high_spike";
          } else if (z <= -MODIFIED_Z_THRESHOLD) {
            anomalyType = "low_dip";
          }
        } else if (centre > 0) {
          // Too little history for a robust score: fall back to a ratio rule
          // against the household's own median.
          if (entry.grid >= centre * 1.5) {
            anomalyType = "high_spike";
          } else if (entry.grid <= centre * 0.5) {
            anomalyType = "low_dip";
          }
        }

        if (anomalyType === "normal") {
          continue;
        }

        found.push({
          day: entry.day,
          neighbourhood: entry.neighbourhood,
          household: entry.household,
          grid: entry.grid,
          consumed: entry.consumed,
          bill: entry.bill,
          householdMedian: centre,
          pctOfAverage: centre > 0 ? (entry.grid / centre) * 100 : 0,
          modifiedZ: z,
          method: useZ ? "modified_z" : "ratio",
          anomalyType
        });
      }
    }

    return found.sort((a, b) => {
      const scoreA = a.modifiedZ === null ? Math.abs(a.grid - a.householdMedian) : Math.abs(a.modifiedZ);
      const scoreB = b.modifiedZ === null ? Math.abs(b.grid - b.householdMedian) : Math.abs(b.modifiedZ);
      return scoreB - scoreA || a.day.localeCompare(b.day);
    });
  }

  function getRecommendations(totals) {
    const recommendations = [];
    const peakShare = totals.consumed > 0 ? (totals.peak / totals.consumed) * 100 : 0;
    const solarOffset = totals.consumed > 0 ? (totals.solar / totals.consumed) * 100 : 0;
    const avgDailyBill = totals.bill !== null && totals.days > 0 ? totals.bill / totals.days : null;

    if (peakShare >= 35) {
      recommendations.push({
        opportunity: "Shift peak usage",
        detail: `Peak is ${formatNumber(peakShare)}% of consumption. Moving 10% of peak into off-peak could reduce demand charges.`,
        impact: peakShare >= 45 ? "high" : "medium"
      });
    }

    if (solarOffset >= 10) {
      recommendations.push({
        opportunity: "Increase solar self-consumption",
        detail: `Solar exports are ${formatNumber(solarOffset)}% of consumption. Battery or load shifting could capture more value.`,
        impact: solarOffset >= 20 ? "high" : "medium"
      });
    }

    if (avgDailyBill !== null) {
      recommendations.push({
        opportunity: "Review estimated spend",
        detail: `Average daily bill is ${formatMoney(avgDailyBill)} across ${formatNumber(totals.days, 0)} days.`,
        impact: avgDailyBill >= 8 ? "high" : avgDailyBill >= 5 ? "medium" : "low"
      });
    }

    return recommendations;
  }

  function getAnalysis(rows) {
    const monthly = aggregateBy(rows, (row) => row.month).sort((a, b) => a.key.localeCompare(b.key));
    const groups = aggregateBy(rows, (row) => row.neighbourhood).sort((a, b) => b.grid - a.grid);
    const billRows = rows.filter((row) => row.bill !== null).length;
    const totals = {
      records: rows.length,
      days: new Set(rows.map((row) => isoDay(row.date))).size,
      households: new Set(rows.map((row) => row.household)).size,
      grid: sum(rows, "grid"),
      solar: sum(rows, "solar"),
      consumed: sum(rows, "consumed"),
      peak: sum(rows, "peak"),
      shoulder: sum(rows, "shoulder"),
      offpeak: sum(rows, "offpeak"),
      bill: billRows > 0 ? rows.reduce((total, row) => total + (row.bill || 0), 0) : null
    };

    return {
      rows,
      monthly,
      groups,
      anomalies: getAnomalies(rows),
      recommendations: getRecommendations(totals),
      totals
    };
  }

  function makeInsights(analysis) {
    const monthly = analysis.monthly;
    const totals = analysis.totals;
    const highest = monthly.reduce((best, item) => (item.grid > best.grid ? item : best), monthly[0]);
    const lowest = monthly.reduce((best, item) => (item.grid < best.grid ? item : best), monthly[0]);
    const solarOffset = totals.consumed > 0 ? (totals.solar / totals.consumed) * 100 : 0;
    const peakShare = totals.consumed > 0 ? (totals.peak / totals.consumed) * 100 : 0;
    const billInsight = totals.bill === null
      ? "No bill column was supplied, so cost analysis is skipped."
      : `Estimated spend across the file is ${formatMoney(totals.bill)}.`;

    return [
      `Highest grid import month: ${highest.key} at ${formatNumber(highest.grid)} kWh.`,
      `Lowest grid import month: ${lowest.key} at ${formatNumber(lowest.grid)} kWh.`,
      `Solar exports equal ${formatNumber(solarOffset)}% of recorded consumption.`,
      `Peak usage is ${formatNumber(peakShare)}% of recorded consumption.`,
      billInsight
    ];
  }

  function metric(label, value) {
    return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function renderMetrics(analysis) {
    const totals = analysis.totals;
    $("#personal-metrics").innerHTML = [
      metric("Records", formatNumber(totals.records, 0)),
      metric("Days covered", formatNumber(totals.days, 0)),
      metric("Grid import", `${formatNumber(totals.grid)} kWh`),
      metric("Solar export", `${formatNumber(totals.solar)} kWh`),
      metric("Estimated cost", formatMoney(totals.bill))
    ].join("");
  }

  function emptyChart(message) {
    return `<div class="chart-empty">${escapeHtml(message)}</div>`;
  }

  function svgFrame(width, height, content) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Generated energy chart">${content}</svg>`;
  }

  function drawMonthlyChart(monthly) {
    if (monthly.length === 0) {
      return emptyChart("No monthly data.");
    }

    const width = 760;
    const height = 310;
    const pad = { top: 28, right: 24, bottom: 54, left: 58 };
    const maxValue = Math.max(...monthly.map((item) => Math.max(item.grid, item.solar)), 1);
    const xStep = monthly.length === 1 ? 0 : (width - pad.left - pad.right) / (monthly.length - 1);
    const y = (value) => height - pad.bottom - (value / maxValue) * (height - pad.top - pad.bottom);
    const x = (index) => pad.left + xStep * index;
    const gridPoints = monthly.map((item, index) => `${x(index)},${y(item.grid)}`).join(" ");
    const solarPoints = monthly.map((item, index) => `${x(index)},${y(item.solar)}`).join(" ");
    const labels = monthly.map((item, index) => {
      const lx = x(index);
      return `<text x="${lx}" y="${height - 22}" text-anchor="middle" font-size="12" fill="${colors.muted}">${escapeHtml(item.key)}</text>`;
    }).join("");
    const guides = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const gy = pad.top + ratio * (height - pad.top - pad.bottom);
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="${colors.line}" stroke-width="1" />`;
    }).join("");

    return svgFrame(width, height, `
      ${guides}
      <polyline points="${gridPoints}" fill="none" stroke="${colors.blue}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      <polyline points="${solarPoints}" fill="none" stroke="${colors.green}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      ${monthly.map((item, index) => `<circle cx="${x(index)}" cy="${y(item.grid)}" r="5" fill="${colors.blue}" />`).join("")}
      ${monthly.map((item, index) => `<circle cx="${x(index)}" cy="${y(item.solar)}" r="5" fill="${colors.green}" />`).join("")}
      ${labels}
      <text x="${pad.left}" y="18" font-size="13" fill="${colors.blue}" font-weight="700">Grid import</text>
      <text x="${pad.left + 100}" y="18" font-size="13" fill="${colors.green}" font-weight="700">Solar export</text>
    `);
  }

  function drawLoadMix(groups) {
    if (groups.length === 0) {
      return emptyChart("No grouped data.");
    }

    const width = 760;
    const rowHeight = 44;
    const height = 76 + groups.length * rowHeight;
    const labelWidth = 138;
    const barWidth = width - labelWidth - 42;
    const maxTotal = Math.max(...groups.map((group) => group.peak + group.shoulder + group.offpeak + group.solar), 1);
    const palette = [colors.red, colors.amber, colors.blue, colors.green];
    const rows = groups.slice(0, 8).map((group, index) => {
      const y = 52 + index * rowHeight;
      const values = [group.peak, group.shoulder, group.offpeak, group.solar];
      let offset = labelWidth;
      const rects = values.map((value, valueIndex) => {
        const widthValue = (value / maxTotal) * barWidth;
        const rect = `<rect x="${offset}" y="${y}" width="${Math.max(widthValue, 0)}" height="20" fill="${palette[valueIndex]}" />`;
        offset += widthValue;
        return rect;
      }).join("");
      return `
        <text x="0" y="${y + 15}" font-size="13" fill="${colors.ink}">${escapeHtml(group.key)}</text>
        ${rects}
      `;
    }).join("");

    return svgFrame(width, height, `
      <text x="${labelWidth}" y="20" font-size="13" fill="${colors.red}" font-weight="700">Peak</text>
      <text x="${labelWidth + 58}" y="20" font-size="13" fill="${colors.amber}" font-weight="700">Shoulder</text>
      <text x="${labelWidth + 142}" y="20" font-size="13" fill="${colors.blue}" font-weight="700">Off-peak</text>
      <text x="${labelWidth + 230}" y="20" font-size="13" fill="${colors.green}" font-weight="700">Solar export</text>
      ${rows}
    `);
  }

  function drawAnomalyChart(anomalies) {
    if (anomalies.length === 0) {
      return emptyChart("No unusual usage days detected.");
    }

    const width = 760;
    const height = 310;
    const pad = { top: 30, right: 18, bottom: 72, left: 58 };
    const maxValue = Math.max(...anomalies.map((item) => item.grid), 1);
    const gap = 10;
    const barWidth = Math.max(12, (width - pad.left - pad.right - gap * (anomalies.length - 1)) / anomalies.length);
    const bars = anomalies.slice(0, 10).map((item, index) => {
      const x = pad.left + index * (barWidth + gap);
      const barHeight = (item.grid / maxValue) * (height - pad.top - pad.bottom);
      const y = height - pad.bottom - barHeight;
      const fill = item.anomalyType === "high_spike" ? colors.red : colors.blue;
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="${fill}" />
        <text x="${x + barWidth / 2}" y="${height - 48}" text-anchor="middle" font-size="11" fill="${colors.muted}">${escapeHtml(item.day)}</text>
        <text x="${x + barWidth / 2}" y="${height - 28}" text-anchor="middle" font-size="11" fill="${colors.muted}">${escapeHtml(item.anomalyType)}</text>
      `;
    }).join("");

    return svgFrame(width, height, bars);
  }

  function drawCostChart(monthly) {
    const withBills = monthly.filter((item) => item.bill !== null);
    if (withBills.length === 0) {
      return emptyChart("No bill column supplied.");
    }

    const width = 760;
    const height = 310;
    const pad = { top: 30, right: 18, bottom: 54, left: 58 };
    const maxValue = Math.max(...withBills.map((item) => item.bill), 1);
    const gap = 12;
    const barWidth = Math.max(14, (width - pad.left - pad.right - gap * (withBills.length - 1)) / withBills.length);
    const bars = withBills.map((item, index) => {
      const x = pad.left + index * (barWidth + gap);
      const barHeight = (item.bill / maxValue) * (height - pad.top - pad.bottom);
      const y = height - pad.bottom - barHeight;
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="${colors.violet}" />
        <text x="${x + barWidth / 2}" y="${height - 22}" text-anchor="middle" font-size="12" fill="${colors.muted}">${escapeHtml(item.key)}</text>
      `;
    }).join("");
    const guides = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const gy = pad.top + ratio * (height - pad.top - pad.bottom);
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="${colors.line}" stroke-width="1" />`;
    }).join("");

    return svgFrame(width, height, `${guides}${bars}`);
  }

  function renderInsights(analysis) {
    $("#personal-insights").innerHTML = makeInsights(analysis)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }

  function renderTable(container, rows, columns) {
    if (rows.length === 0) {
      container.innerHTML = "";
      return;
    }

    const header = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = columns.map((column) => `<td>${escapeHtml(column.format(row[column.key], row))}</td>`).join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    container.innerHTML = `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderRecommendations(recommendations) {
    const container = $("#recommendation-list");
    if (!container) {
      return;
    }

    if (recommendations.length === 0) {
      container.innerHTML = "<li>No major savings opportunities were flagged for this dataset.</li>";
      return;
    }

    container.innerHTML = recommendations.map((item) => `
      <li>
        <strong>${escapeHtml(item.opportunity)}</strong>
        ${escapeHtml(item.detail)}
        <span class="impact impact-${escapeHtml(item.impact)}">${escapeHtml(item.impact)} impact</span>
      </li>
    `).join("");
  }

  function renderTables(analysis) {
    renderTable($("#monthly-table"), analysis.monthly, [
      { key: "key", label: "Month", format: (value) => value },
      { key: "grid", label: "Grid import", format: (value) => `${formatNumber(value)} kWh` },
      { key: "solar", label: "Solar export", format: (value) => `${formatNumber(value)} kWh` },
      { key: "consumed", label: "Consumed", format: (value) => `${formatNumber(value)} kWh` },
      { key: "bill", label: "Cost", format: (value) => formatMoney(value) }
    ]);

    renderTable($("#group-table"), analysis.groups, [
      { key: "key", label: "Group", format: (value) => value },
      { key: "records", label: "Records", format: (value) => formatNumber(value, 0) },
      { key: "households", label: "Households", format: (value) => formatNumber(value, 0) },
      { key: "grid", label: "Grid import", format: (value) => `${formatNumber(value)} kWh` },
      { key: "solar", label: "Solar export", format: (value) => `${formatNumber(value)} kWh` }
    ]);

    renderTable($("#anomaly-table"), analysis.anomalies, [
      { key: "day", label: "Day", format: (value) => value },
      { key: "household", label: "Household", format: (value) => value },
      { key: "grid", label: "Grid import", format: (value) => `${formatNumber(value)} kWh` },
      {
        key: "householdMedian",
        label: "Its usual",
        format: (value) => `${formatNumber(value)} kWh`
      },
      { key: "pctOfAverage", label: "% of usual", format: (value) => `${formatNumber(value)}%` },
      {
        key: "modifiedZ",
        label: "Score",
        format: (value) => (value === null ? "ratio rule" : formatNumber(value, 1))
      },
      { key: "anomalyType", label: "Type", format: (value) => value }
    ]);
  }

  let latestAnalysis = null;

  function exportAnalysis() {
    if (!latestAnalysis) {
      return;
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      totals: latestAnalysis.totals,
      monthly: latestAnalysis.monthly,
      groups: latestAnalysis.groups,
      anomalies: latestAnalysis.anomalies,
      recommendations: latestAnalysis.recommendations
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "energy-analysis.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.body.classList.toggle("theme-dark", isDark);
    const toggle = $("#theme-toggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(isDark));
      toggle.textContent = isDark ? "Light mode" : "Dark mode";
    }
    localStorage.setItem("gridscope-theme", theme);
  }

  function renderAnalysis(rows, label) {
    const analysis = getAnalysis(rows);
    latestAnalysis = analysis;
    $("#personal-results").hidden = false;

    // Anything the parser had to assume or discard is stated, not buried.
    const notes = rows.notes || [];
    const status = $("#upload-status");
    status.dataset.tone = notes.length > 0 ? "warn" : "ok";
    status.textContent = [`${label}: ${analysis.totals.records} records analysed.`]
      .concat(notes)
      .join(" ");
    renderMetrics(analysis);
    renderInsights(analysis);
    $("#monthly-chart").innerHTML = drawMonthlyChart(analysis.monthly);
    $("#mix-chart").innerHTML = drawLoadMix(analysis.groups);
    $("#cost-chart").innerHTML = drawCostChart(analysis.monthly);
    $("#anomaly-chart").innerHTML = drawAnomalyChart(analysis.anomalies);
    renderTables(analysis);
    renderRecommendations(analysis.recommendations);

    const exportButton = $("#export-analysis");
    if (exportButton) {
      exportButton.disabled = false;
    }
  }

  function handleText(text, label) {
    try {
      const rows = normaliseRows(text);
      renderAnalysis(rows, label);
    } catch (error) {
      $("#personal-results").hidden = true;
      $("#upload-status").dataset.tone = "error";
      $("#upload-status").textContent = error.message;
    }
  }

  function init() {
    const input = $("#energy-csv");
    const sample = $("#load-sample");
    const exportButton = $("#export-analysis");
    const themeToggle = $("#theme-toggle");
    if (!input || !sample) {
      return;
    }

    applyTheme(localStorage.getItem("gridscope-theme") === "dark" ? "dark" : "light");

    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        const nextTheme = document.body.classList.contains("theme-dark") ? "light" : "dark";
        applyTheme(nextTheme);
      });
    }

    if (exportButton) {
      exportButton.addEventListener("click", exportAnalysis);
    }

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => handleText(String(reader.result || ""), file.name);
      reader.onerror = () => {
        $("#upload-status").dataset.tone = "error";
        $("#upload-status").textContent = "The file could not be read.";
      };
      reader.readAsText(file);
    });

    sample.addEventListener("click", () => {
      // file:// and offline opens cannot fetch, so fall back to the embedded
      // extract rather than failing.
      fetch("../data/sample_energy_upload.csv")
        .then((response) => {
          if (!response.ok) {
            throw new Error(String(response.status));
          }
          return response.text();
        })
        .then((text) => handleText(text, "Sample data (full year)"))
        .catch(() => handleText(sampleCsv, "Sample data (offline extract)"));
    });
  }

  // Pure helpers are exported so tests/js/run.mjs can exercise the same code
  // the page runs, rather than a copy of it.
  const api = {
    ESTIMATED_TIER_SHARES,
    MODIFIED_Z_THRESHOLD,
    MIN_OBSERVATIONS_FOR_Z,
    parseCsv,
    normaliseKey,
    pickColumn,
    toNumber,
    optionalNumber,
    isoDay,
    monthKey,
    makeDate,
    parseDate,
    detectDateLayout,
    normaliseRows,
    median,
    aggregateBy,
    getAnomalies,
    getRecommendations,
    getAnalysis,
    makeInsights,
    escapeHtml,
    sampleCsv
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    window.GridScope = api;
    document.addEventListener("DOMContentLoaded", init);
  }
}());
