/* GridScope analysis core for the browser.
 * Mirrors gridscope/analysis.py — keep formulas in sync.
 *
 *   Untiered split: peak 0.44 / shoulder 0.34 / off-peak 0.22 of supplied total
 *   consumed = peak + shoulder + off-peak
 *   grid = supplied grid else max(0, consumed - solar)
 *   anomaly: high_spike if grid >= 1.5 * mean(grid); low_dip if grid <= 0.5 * mean
 *   tariff bill = peak*peak + shoulder*shoulder + offpeak*offpeak - solar*export_credit
 *   compare: delta_kwh = right.grid - left.grid; shared_days = |days ∩ days|
 */
(function (root) {
  const VERSION = "0.3.0";

  const DEFAULT_TARIFF = {
    peak: 0.4,
    shoulder: 0.28,
    offpeak: 0.18,
    export_credit: 0.08
  };

  const TIER_SPLIT = { peak: 0.44, shoulder: 0.34, offpeak: 0.22 };
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function isoDay(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function weekdayName(date) {
    return WEEKDAYS[(date.getDay() + 6) % 7];
  }

  function parseDateAndHour(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return { date: null, hour: null };
    }

    const iso = raw.match(
      /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{1,2})(?::(\d{2}))?(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/
    );
    if (iso) {
      const date = new Date(`${iso[1]}T00:00:00`);
      if (Number.isNaN(date.getTime())) {
        return { date: null, hour: null };
      }
      const hour = iso[2] === undefined ? null : Math.max(0, Math.min(23, Number(iso[2])));
      return { date, hour };
    }

    const parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[T\s](\d{1,2}))?/);
    if (parts) {
      const first = Number(parts[1]);
      const second = Number(parts[2]);
      const year = Number(parts[3].length === 2 ? `20${parts[3]}` : parts[3]);
      const day = first > 12 ? first : second;
      const month = first > 12 ? second : first;
      const date = new Date(year, month - 1, day);
      if (Number.isNaN(date.getTime())) {
        return { date: null, hour: null };
      }
      const hour = parts[4] === undefined ? null : Math.max(0, Math.min(23, Number(parts[4])));
      return { date, hour };
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return { date: null, hour: null };
    }
    const hasTime = /T|\d:\d/.test(raw);
    return { date, hour: hasTime ? date.getHours() : null };
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }

  function coerceTariff(tariff) {
    const source = tariff || DEFAULT_TARIFF;
    const pick = (...names) => {
      for (const name of names) {
        if (source[name] !== undefined && source[name] !== null && source[name] !== "") {
          const parsed = Number(source[name]);
          if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
          }
        }
      }
      return null;
    };
    return {
      peak: pick("peak", "peak_rate") ?? DEFAULT_TARIFF.peak,
      shoulder: pick("shoulder", "shoulder_rate") ?? DEFAULT_TARIFF.shoulder,
      offpeak: pick("offpeak", "off_peak", "offpeak_rate") ?? DEFAULT_TARIFF.offpeak,
      export_credit: pick("export_credit", "exportCredit", "export", "feed_in") ?? DEFAULT_TARIFF.export_credit
    };
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
      bill: pickColumn(headers, ["estimated_bill", "bill", "cost", "amount", "charge"]),
      hour: pickColumn(headers, ["hour", "interval_hour", "tod_hour", "hour_of_day"])
    };

    if (col.day === -1) {
      throw new Error("Add a date column named day, date, reading_date, or timestamp.");
    }

    const hasTieredUsage = col.peak !== -1 || col.shoulder !== -1 || col.offpeak !== -1;
    const hasTotalUsage = col.grid !== -1 || col.total !== -1;
    if (!hasTieredUsage && !hasTotalUsage) {
      throw new Error("Add energy columns such as grid_import_kwh, total_kwh, peak_kwh, shoulder_kwh, or offpeak_kwh.");
    }

    const rows = [];
    for (let i = 1; i < parsed.length; i += 1) {
      const raw = parsed[i];
      const parsedDate = parseDateAndHour(raw[col.day]);
      if (!parsedDate.date) {
        continue;
      }

      const suppliedTotal = col.total !== -1 ? toNumber(raw[col.total]) : toNumber(raw[col.grid]);
      let peak = col.peak !== -1 ? toNumber(raw[col.peak]) : 0;
      let shoulder = col.shoulder !== -1 ? toNumber(raw[col.shoulder]) : 0;
      let offpeak = col.offpeak !== -1 ? toNumber(raw[col.offpeak]) : 0;

      if (!hasTieredUsage && suppliedTotal > 0) {
        peak = suppliedTotal * TIER_SPLIT.peak;
        shoulder = suppliedTotal * TIER_SPLIT.shoulder;
        offpeak = suppliedTotal * TIER_SPLIT.offpeak;
      }

      const consumed = peak + shoulder + offpeak;
      const solar = col.solar !== -1 ? toNumber(raw[col.solar]) : 0;
      const grid = col.grid !== -1 ? toNumber(raw[col.grid]) : Math.max(0, consumed - solar);
      const bill = col.bill !== -1 ? optionalNumber(raw[col.bill]) : null;
      let hour = parsedDate.hour;
      if (col.hour !== -1) {
        const hourValue = optionalNumber(raw[col.hour]);
        if (hourValue !== null) {
          hour = Math.max(0, Math.min(23, Math.round(hourValue)));
        }
      }

      rows.push({
        date: parsedDate.date,
        day: isoDay(parsedDate.date),
        month: monthKey(parsedDate.date),
        weekday: weekdayName(parsedDate.date),
        hour,
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

    return rows;
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  }

  function rowTariffBill(row, tariff) {
    return row.peak * tariff.peak + row.shoulder * tariff.shoulder + row.offpeak * tariff.offpeak - row.solar * tariff.export_credit;
  }

  function estimateBill(rows, tariff) {
    const rates = coerceTariff(tariff);
    return rows.reduce((total, row) => total + rowTariffBill(row, rates), 0);
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
      if (row.bill !== null && row.bill !== undefined) {
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

  function getAnomalies(rows) {
    if (rows.length === 0) {
      return [];
    }

    const avgGrid = sum(rows, "grid") / rows.length;
    return rows
      .map((row) => {
        const pct = avgGrid > 0 ? (row.grid / avgGrid) * 100 : 0;
        let anomalyType = "normal";
        if (row.grid >= avgGrid * 1.5) {
          anomalyType = "high_spike";
        } else if (row.grid <= avgGrid * 0.5) {
          anomalyType = "low_dip";
        }
        return {
          day: row.day,
          neighbourhood: row.neighbourhood,
          household: row.household,
          grid: row.grid,
          consumed: row.consumed,
          bill: row.bill,
          pctOfAverage: pct,
          pct_of_average: pct,
          anomalyType,
          anomaly_type: anomalyType
        };
      })
      .filter((row) => row.anomalyType !== "normal")
      .sort((a, b) => Math.abs(b.grid - avgGrid) - Math.abs(a.grid - avgGrid));
  }

  function getRecommendations(totals) {
    const recommendations = [];
    const peakShare = totals.consumed > 0 ? (totals.peak / totals.consumed) * 100 : 0;
    const solarOffset = totals.consumed > 0 ? (totals.solar / totals.consumed) * 100 : 0;
    const spend = totals.bill !== null && totals.bill !== undefined ? totals.bill : totals.tariffBill;
    const spendLabel = totals.bill !== null && totals.bill !== undefined ? "bill" : "tariff bill";
    const avgDailyBill = spend !== null && spend !== undefined && totals.days > 0 ? spend / totals.days : null;

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
        detail: `Average daily ${spendLabel} is ${formatMoney(avgDailyBill)} across ${formatNumber(totals.days, 0)} days.`,
        impact: avgDailyBill >= 8 ? "high" : avgDailyBill >= 5 ? "medium" : "low"
      });
    }

    return recommendations;
  }

  function householdsOf(rows) {
    const seen = [];
    for (const row of rows) {
      if (!seen.includes(row.household)) {
        seen.push(row.household);
      }
    }
    return seen;
  }

  function filterHousehold(rows, household) {
    if (!household || household === "all") {
      return rows.slice();
    }
    return rows.filter((row) => row.household === household);
  }

  function weekdayHeatmap(rows) {
    const hasHour = rows.some((row) => row.hour !== null && row.hour !== undefined);
    const axis = hasHour ? "hour" : "month";
    const buckets = hasHour
      ? Array.from({ length: 24 }, (_, hour) => pad2(hour))
      : Array.from(new Set(rows.map((row) => row.month))).sort();
    const bucketOf = (row) => {
      if (!hasHour) {
        return row.month;
      }
      return row.hour === null || row.hour === undefined ? null : pad2(row.hour);
    };

    const cells = [];
    let maxGrid = 0;
    for (const weekday of WEEKDAYS) {
      for (const bucket of buckets) {
        let grid = 0;
        let records = 0;
        for (const row of rows) {
          if (row.weekday !== weekday || bucketOf(row) !== bucket) {
            continue;
          }
          grid += row.grid;
          records += 1;
        }
        maxGrid = Math.max(maxGrid, grid);
        cells.push({ weekday, bucket, grid, records });
      }
    }

    return { axis, buckets, weekdays: WEEKDAYS.slice(), cells, maxGrid, max_grid: maxGrid };
  }

  function getTotals(rows, tariff) {
    const billRows = rows.filter((row) => row.bill !== null && row.bill !== undefined);
    return {
      records: rows.length,
      days: new Set(rows.map((row) => row.day)).size,
      households: new Set(rows.map((row) => row.household)).size,
      grid: sum(rows, "grid"),
      solar: sum(rows, "solar"),
      consumed: sum(rows, "consumed"),
      peak: sum(rows, "peak"),
      shoulder: sum(rows, "shoulder"),
      offpeak: sum(rows, "offpeak"),
      bill: billRows.length > 0 ? billRows.reduce((total, row) => total + row.bill, 0) : null,
      tariffBill: estimateBill(rows, tariff),
      tariff_bill: estimateBill(rows, tariff)
    };
  }

  function getAnalysis(rows, tariff, household) {
    const rates = coerceTariff(tariff);
    const filtered = filterHousehold(rows, household);
    const monthly = aggregateBy(filtered, (row) => row.month).sort((a, b) => a.key.localeCompare(b.key));
    for (const item of monthly) {
      const monthRows = filtered.filter((row) => row.month === item.key);
      item.tariffBill = estimateBill(monthRows, rates);
      item.tariff_bill = item.tariffBill;
    }
    const groups = aggregateBy(filtered, (row) => row.neighbourhood).sort((a, b) => b.grid - a.grid);
    for (const item of groups) {
      const groupRows = filtered.filter((row) => row.neighbourhood === item.key);
      item.tariffBill = estimateBill(groupRows, rates);
      item.tariff_bill = item.tariffBill;
    }
    const totals = getTotals(filtered, rates);
    return {
      rows: filtered,
      monthly,
      groups,
      anomalies: getAnomalies(filtered),
      recommendations: getRecommendations(totals),
      totals,
      heatmap: weekdayHeatmap(filtered),
      tariff: rates,
      households: householdsOf(filtered),
      household: household || "all"
    };
  }

  function compareDatasets(left, right, tariff) {
    const rates = coerceTariff(tariff);
    if (!left.length || !right.length) {
      throw new Error("Compare needs two non-empty datasets.");
    }
    const leftDays = new Set(left.map((row) => row.day));
    const rightDays = new Set(right.map((row) => row.day));
    const shared = [...leftDays].filter((day) => rightDays.has(day)).sort();
    const leftTotals = getTotals(left, rates);
    const rightTotals = getTotals(right, rates);
    const sharedSet = new Set(shared);
    const leftShared = left.filter((row) => sharedSet.has(row.day));
    const rightShared = right.filter((row) => sharedSet.has(row.day));
    const leftSharedTotals = leftShared.length ? getTotals(leftShared, rates) : null;
    const rightSharedTotals = rightShared.length ? getTotals(rightShared, rates) : null;
    const csvDelta =
      leftTotals.bill === null || rightTotals.bill === null ? null : rightTotals.bill - leftTotals.bill;

    return {
      sharedDays: shared.length,
      shared_days: shared.length,
      sharedDayList: shared,
      deltaKwh: rightTotals.grid - leftTotals.grid,
      delta_kwh: rightTotals.grid - leftTotals.grid,
      deltaBill: rightTotals.tariffBill - leftTotals.tariffBill,
      delta_bill: rightTotals.tariffBill - leftTotals.tariffBill,
      deltaCsvBill: csvDelta,
      sharedDeltaKwh: leftSharedTotals && rightSharedTotals ? rightSharedTotals.grid - leftSharedTotals.grid : 0,
      shared_delta_kwh: leftSharedTotals && rightSharedTotals ? rightSharedTotals.grid - leftSharedTotals.grid : 0,
      sharedDeltaBill: leftSharedTotals && rightSharedTotals ? rightSharedTotals.tariffBill - leftSharedTotals.tariffBill : 0,
      left: leftTotals,
      right: rightTotals
    };
  }

  function analysisTable(analysis) {
    return analysis.monthly.map((item) => ({
      month: item.key,
      records: item.records,
      households: item.households,
      grid_kwh: item.grid,
      solar_kwh: item.solar,
      consumed_kwh: item.consumed,
      peak_kwh: item.peak,
      shoulder_kwh: item.shoulder,
      offpeak_kwh: item.offpeak,
      csv_bill: item.bill,
      tariff_bill: item.tariffBill
    }));
  }

  function tableToCsv(rows) {
    if (!rows.length) {
      return "";
    }
    const headers = Object.keys(rows[0]);
    const escape = (value) => {
      const text = value === null || value === undefined ? "" : String(value);
      if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, "\"\"")}"`;
      }
      return text;
    };
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((key) => escape(row[key])).join(","));
    }
    return `${lines.join("\n")}\n`;
  }

  root.GridScope = {
    VERSION,
    DEFAULT_TARIFF,
    TIER_SPLIT,
    WEEKDAYS,
    parseCsv,
    normaliseRows,
    getAnalysis,
    getAnomalies,
    getRecommendations,
    estimateBill,
    compareDatasets,
    weekdayHeatmap,
    filterHousehold,
    householdsOf,
    analysisTable,
    tableToCsv,
    coerceTariff,
    formatNumber,
    formatMoney
  };
})(typeof window !== "undefined" ? window : globalThis);
