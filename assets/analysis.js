/* GridScope analysis core for the browser.
 * Mirrors gridscope/analysis.py — keep formulas in sync.
 *
 *   Untiered split: peak 0.44 / shoulder 0.34 / off-peak 0.22 of supplied total
 *   consumed = peak + shoulder + off-peak
 *   grid = supplied grid else max(0, consumed - solar)
 *   anomaly: household mean if that household has >= 4 rows, else global mean
 *   energy = peak*peak + shoulder*shoulder + offpeak*offpeak
 *   export = solar * export_credit
 *   ex_gst = energy + daily_supply * distinct_days - export
 *   tariff bill (inc GST) = ex_gst * (1 + gst)
 *   compare: delta_kwh = right.grid - left.grid; shared_days = |days ∩ days|
 *     join household+day when both sides have >1 household, else day
 *   optional TOU: weekend off-peak; weekday 14-19 peak; 7-13 and 20-21 shoulder
 *     never retier rows whose tiers came from CSV peak/shoulder/offpeak columns
 *   coverage: unique days vs first–last span; list missing days only when dense
 *   totals peak_share / solar_share = 100 * peak|solar / consumed (else 0)
 *   totals cost_per_kwh = tariff_bill / consumed (else null)
 *   weekend_split: Sat/Sun vs rest; unique days, consumed kWh, GST-inclusive bills
 *   data_quality: duplicate (household, day) keys; negative energy; zero grid
 *   shift_peak: copy rows, move fraction * peak into off-peak; consumed unchanged
 *   what_if_peak_shift: baseline vs shifted GST-inclusive bills and saving_aud
 *   what_if_solar_self: fraction * solar * max(0, shoulder - export) * (1+gst); does not mutate rows
 *   dedupe_rows: sum energy (+ bill when both present) for duplicate (household, day) keys
 *   groups kwh_per_household = grid / households (else null)
 *   compare monthly_delta: shared month keys, delta_kwh = right.grid - left.grid
 */
(function (root) {
  const VERSION = "0.7.0";

  const DEFAULT_TARIFF = {
    peak: 0.4,
    shoulder: 0.28,
    offpeak: 0.18,
    export_credit: 0.08,
    daily_supply: 1.1,
    gst: 0.1
  };

  const DEFAULT_PLANS = [
    { name: "Flex Saver", peak: 0.4, shoulder: 0.28, offpeak: 0.18, export_credit: 0.08, daily_supply: 1.1 },
    { name: "Solar Plus", peak: 0.38, shoulder: 0.27, offpeak: 0.17, export_credit: 0.12, daily_supply: 1.35 },
    { name: "Flat Comfort", peak: 0.32, shoulder: 0.32, offpeak: 0.32, export_credit: 0.05, daily_supply: 1.6 }
  ];

  const TIER_SPLIT = { peak: 0.44, shoulder: 0.34, offpeak: 0.22 };
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const HOUSEHOLD_BASELINE_MIN_ROWS = 4;

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

  function normaliseDateOrder(dateOrder) {
    const order = String(dateOrder || "dmy").trim().toLowerCase();
    if (order !== "dmy" && order !== "mdy" && order !== "auto") {
      return "dmy";
    }
    return order;
  }

  function makeDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function parseDateAndHour(value, dateOrder = "dmy") {
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
      const order = normaliseDateOrder(dateOrder);
      let day;
      let month;
      if (first > 12) {
        day = first;
        month = second;
      } else if (second > 12) {
        day = second;
        month = first;
      } else if (order === "mdy") {
        month = first;
        day = second;
      } else if (order === "auto") {
        day = second;
        month = first;
      } else {
        day = first;
        month = second;
      }
      const date = makeDate(year, month, day);
      if (!date) {
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
      export_credit: pick("export_credit", "exportCredit", "export", "feed_in") ?? DEFAULT_TARIFF.export_credit,
      daily_supply: pick("daily_supply", "supply", "daily", "dailySupply") ?? DEFAULT_TARIFF.daily_supply,
      gst: pick("gst", "gst_rate", "gstRate") ?? DEFAULT_TARIFF.gst
    };
  }

  function parseOptions(options) {
    if (typeof options === "string") {
      return { dateOrder: normaliseDateOrder(options) };
    }
    const source = options || {};
    return {
      dateOrder: normaliseDateOrder(source.dateOrder || source.date_order || "dmy")
    };
  }

  function parseEnergyCsv(text, options) {
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      throw new Error("The CSV needs a header row and at least one data row.");
    }

    const dateOrder = parseOptions(options).dateOrder;
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
      const parsedDate = parseDateAndHour(raw[col.day], dateOrder);
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
        consumed,
        tier_source: hasTieredUsage ? "csv" : "split",
        tierSource: hasTieredUsage ? "csv" : "split"
      });
    }

    if (rows.length === 0) {
      throw new Error("No valid dated rows were found.");
    }

    return rows;
  }

  function normaliseRows(text, options) {
    return parseEnergyCsv(text, options);
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  }

  function touBucket(weekday, hour) {
    if (weekday === "Sat" || weekday === "Sun") {
      return "offpeak";
    }
    if (hour >= 14 && hour <= 19) {
      return "peak";
    }
    if ((hour >= 7 && hour <= 13) || hour === 20 || hour === 21) {
      return "shoulder";
    }
    return "offpeak";
  }

  function rowHasHour(row) {
    return row.hour !== null && row.hour !== undefined;
  }

  function applyTou(rows) {
    const materialised = rows.map((row) => ({ ...row }));
    if (!materialised.length || !materialised.some(rowHasHour)) {
      return materialised;
    }
    return materialised.map((row) => {
      if (row.tier_source === "csv" || !rowHasHour(row)) {
        return row;
      }
      const hour = Number(row.hour);
      const energy = row.grid === null || row.grid === undefined ? Number(row.consumed) || 0 : Number(row.grid) || 0;
      const bucket = touBucket(row.weekday, hour);
      const next = { ...row, peak: 0, shoulder: 0, offpeak: 0 };
      next[bucket] = energy;
      next.consumed = next.peak + next.shoulder + next.offpeak;
      return next;
    });
  }

  function addDaysIso(iso, days) {
    const [year, month, day] = String(iso).split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
  }

  function calendarCoverage(rows) {
    const uniqueDays = Array.from(new Set(rows.map((row) => row.day).filter(Boolean))).sort();
    const recorded = uniqueDays.length;
    if (recorded === 0) {
      return {
        recorded: 0,
        first: null,
        last: null,
        span_days: 0,
        spanDays: 0,
        density: 0,
        kind: "short",
        missing_days: [],
        missingDays: [],
        missing_count: 0,
        missingCount: 0
      };
    }

    const first = uniqueDays[0];
    const last = uniqueDays[uniqueDays.length - 1];
    const [y1, m1, d1] = first.split("-").map(Number);
    const [y2, m2, d2] = last.split("-").map(Number);
    const spanDays = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
    const density = spanDays > 0 ? recorded / spanDays : 0;
    const missingCount = spanDays - recorded;
    let kind = "sparse";
    if (recorded < 2) {
      kind = "short";
    } else if (density >= 0.7) {
      kind = "daily";
    }

    const missingDays = [];
    if (kind === "daily" && missingCount) {
      const recordedSet = new Set(uniqueDays);
      let cursor = first;
      while (cursor <= last) {
        if (!recordedSet.has(cursor)) {
          missingDays.push(cursor);
          if (missingDays.length >= 60) {
            break;
          }
        }
        cursor = addDaysIso(cursor, 1);
      }
    }

    return {
      recorded,
      first,
      last,
      span_days: spanDays,
      spanDays,
      density,
      kind,
      missing_days: missingDays,
      missingDays,
      missing_count: missingCount,
      missingCount
    };
  }

  function billComponents(rows, tariff) {
    const rates = coerceTariff(tariff);
    const energy =
      sum(rows, "peak") * rates.peak +
      sum(rows, "shoulder") * rates.shoulder +
      sum(rows, "offpeak") * rates.offpeak;
    const exportCredit = sum(rows, "solar") * rates.export_credit;
    const days = new Set(rows.map((row) => row.day)).size;
    const supplyCharge = rates.daily_supply * days;
    const exGst = energy + supplyCharge - exportCredit;
    const gstAmount = exGst * rates.gst;
    const incGst = exGst * (1 + rates.gst);
    return {
      energy,
      export: exportCredit,
      days,
      supply_charge: supplyCharge,
      supplyCharge,
      tariff_bill_ex_gst: exGst,
      tariffBillExGst: exGst,
      gst_amount: gstAmount,
      gstAmount,
      tariff_bill: incGst,
      tariffBill: incGst
    };
  }

  function rowTariffBill(row, tariff) {
    return row.peak * tariff.peak + row.shoulder * tariff.shoulder + row.offpeak * tariff.offpeak - row.solar * tariff.export_credit;
  }

  function estimateBill(rows, tariff) {
    return billComponents(rows, tariff).tariff_bill;
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

    const globalMean = sum(rows, "grid") / rows.length;
    const grouped = new Map();
    for (const row of rows) {
      const household = row.household || "Unknown";
      if (!grouped.has(household)) {
        grouped.set(household, []);
      }
      grouped.get(household).push(row);
    }
    const householdMeans = new Map();
    for (const [household, householdRows] of grouped.entries()) {
      if (householdRows.length >= HOUSEHOLD_BASELINE_MIN_ROWS) {
        householdMeans.set(household, sum(householdRows, "grid") / householdRows.length);
      }
    }

    return rows
      .map((row) => {
        const household = row.household || "Unknown";
        const baseline = householdMeans.has(household) ? "household" : "global";
        const mean = householdMeans.has(household) ? householdMeans.get(household) : globalMean;
        const pct = mean > 0 ? (row.grid / mean) * 100 : 0;
        let anomalyType = "normal";
        if (row.grid >= mean * 1.5) {
          anomalyType = "high_spike";
        } else if (row.grid <= mean * 0.5) {
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
          anomaly_type: anomalyType,
          baseline,
          baselineKwh: mean,
          baseline_kwh: mean
        };
      })
      .filter((row) => row.anomalyType !== "normal")
      .sort((a, b) => {
        const delta = Math.abs(b.grid - b.baseline_kwh) - Math.abs(a.grid - a.baseline_kwh);
        if (delta !== 0) {
          return delta;
        }
        return String(a.day).localeCompare(String(b.day));
      });
  }

  function getRecommendations(totals, tariff) {
    const recommendations = [];
    const rates = coerceTariff(tariff);
    const peakKwh = Number(totals.peak) || 0;
    const solarKwh = Number(totals.solar) || 0;
    const peakShare = totals.consumed > 0 ? (peakKwh / totals.consumed) * 100 : 0;
    const solarOffset = totals.consumed > 0 ? (solarKwh / totals.consumed) * 100 : 0;
    const spend = totals.bill !== null && totals.bill !== undefined ? totals.bill : (totals.tariffBill ?? totals.tariff_bill);
    const spendLabel = totals.bill !== null && totals.bill !== undefined ? "bill" : "tariff bill";
    const avgDailyBill = spend !== null && spend !== undefined && totals.days > 0 ? spend / totals.days : null;
    const gstFactor = 1 + rates.gst;

    if (peakShare >= 35) {
      const saving = 0.1 * peakKwh * (rates.peak - rates.offpeak) * gstFactor;
      recommendations.push({
        opportunity: "Shift peak usage",
        detail: `Peak is ${formatNumber(peakShare)}% of consumption. Moving 10% of peak into off-peak could save ${formatMoney(saving)}.`,
        impact: peakShare >= 45 ? "high" : "medium",
        saving_aud: saving,
        savingAud: saving
      });
    }

    if (solarOffset >= 10) {
      const spread = Math.max(0, rates.shoulder - rates.export_credit);
      const saving = 0.5 * solarKwh * spread * gstFactor;
      recommendations.push({
        opportunity: "Increase solar self-consumption",
        detail: `Solar exports are ${formatNumber(solarOffset)}% of consumption. Using 50% of export on-site could save ${formatMoney(saving)}.`,
        impact: solarOffset >= 20 ? "high" : "medium",
        saving_aud: saving,
        savingAud: saving
      });
    }

    if (avgDailyBill !== null) {
      const projected = avgDailyBill * 30;
      recommendations.push({
        opportunity: "Review estimated spend",
        detail: `Average daily ${spendLabel} is ${formatMoney(avgDailyBill)} across ${formatNumber(totals.days, 0)} days. Projected 30-day cost is ${formatMoney(projected)}.`,
        impact: avgDailyBill >= 8 ? "high" : avgDailyBill >= 5 ? "medium" : "low",
        saving_aud: 0,
        savingAud: 0
      });
    }

    recommendations.sort((a, b) => {
      const delta = b.saving_aud - a.saving_aud;
      if (delta !== 0) {
        return delta;
      }
      return a.opportunity.localeCompare(b.opportunity);
    });
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
    const components = billComponents(rows, tariff);
    const consumed = sum(rows, "consumed");
    const peak = sum(rows, "peak");
    const solar = sum(rows, "solar");
    const peakShare = consumed ? (100 * peak) / consumed : 0;
    const solarShare = consumed ? (100 * solar) / consumed : 0;
    return {
      records: rows.length,
      days: new Set(rows.map((row) => row.day)).size,
      households: new Set(rows.map((row) => row.household)).size,
      grid: sum(rows, "grid"),
      solar,
      consumed,
      peak,
      shoulder: sum(rows, "shoulder"),
      offpeak: sum(rows, "offpeak"),
      peak_share: peakShare,
      peakShare,
      solar_share: solarShare,
      solarShare,
      bill: billRows.length > 0 ? billRows.reduce((total, row) => total + row.bill, 0) : null,
      tariffBill: components.tariff_bill,
      tariff_bill: components.tariff_bill,
      cost_per_kwh: consumed ? components.tariff_bill / consumed : null,
      costPerKwh: consumed ? components.tariff_bill / consumed : null,
      tariffBillExGst: components.tariff_bill_ex_gst,
      tariff_bill_ex_gst: components.tariff_bill_ex_gst,
      supplyCharge: components.supply_charge,
      supply_charge: components.supply_charge,
      gstAmount: components.gst_amount,
      gst_amount: components.gst_amount
    };
  }

  function weekendSplit(rows, tariff) {
    const rates = coerceTariff(tariff);
    const weekdayRows = [];
    const weekendRows = [];
    for (const row of rows) {
      if (row.weekday === "Sat" || row.weekday === "Sun") {
        weekendRows.push(row);
      } else {
        weekdayRows.push(row);
      }
    }
    const weekdayDays = new Set(weekdayRows.map((row) => row.day)).size;
    const weekendDays = new Set(weekendRows.map((row) => row.day)).size;
    const weekdayKwh = sum(weekdayRows, "consumed");
    const weekendKwh = sum(weekendRows, "consumed");
    const weekdayBill = weekdayRows.length ? estimateBill(weekdayRows, rates) : 0;
    const weekendBill = weekendRows.length ? estimateBill(weekendRows, rates) : 0;
    return {
      weekday_days: weekdayDays,
      weekdayDays,
      weekend_days: weekendDays,
      weekendDays,
      weekday_kwh: weekdayKwh,
      weekdayKwh,
      weekend_kwh: weekendKwh,
      weekendKwh,
      weekday_bill: weekdayBill,
      weekdayBill,
      weekend_bill: weekendBill,
      weekendBill
    };
  }

  function dataQuality(rows) {
    const keyCounts = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.household || "Unknown", row.day || ""]);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
    let duplicateKeys = 0;
    for (const count of keyCounts.values()) {
      if (count > 1) {
        duplicateKeys += 1;
      }
    }
    let negativeEnergy = 0;
    let zeroGrid = 0;
    for (const row of rows) {
      const values = [row.peak, row.shoulder, row.offpeak, row.grid, row.solar];
      if (values.some((value) => Number(value) < 0)) {
        negativeEnergy += 1;
      }
      if ((Number(row.grid) || 0) === 0) {
        zeroGrid += 1;
      }
    }
    return {
      duplicate_keys: duplicateKeys,
      duplicateKeys,
      negative_energy: negativeEnergy,
      negativeEnergy,
      zero_grid: zeroGrid,
      zeroGrid
    };
  }

  function clampFraction(fraction) {
    const value = Number(fraction);
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  function shiftPeak(rows, fraction) {
    const frac = clampFraction(fraction);
    return rows.map((row) => {
      const peak = Number(row.peak) || 0;
      const moved = peak * frac;
      const nextPeak = peak - moved;
      const nextOffpeak = (Number(row.offpeak) || 0) + moved;
      return {
        ...row,
        peak: nextPeak,
        offpeak: nextOffpeak,
        consumed: nextPeak + (Number(row.shoulder) || 0) + nextOffpeak
      };
    });
  }

  function whatIfPeakShift(rows, tariff, fraction) {
    const rates = coerceTariff(tariff);
    const frac = clampFraction(fraction === undefined ? 0.1 : fraction);
    const baselineBill = estimateBill(rows, rates);
    const shiftedBill = estimateBill(shiftPeak(rows, frac), rates);
    const saving = baselineBill - shiftedBill;
    return {
      fraction: frac,
      baseline_bill: baselineBill,
      baselineBill,
      shifted_bill: shiftedBill,
      shiftedBill,
      saving_aud: saving,
      savingAud: saving
    };
  }

  function whatIfSolarSelf(rows, tariff, fraction) {
    const rates = coerceTariff(tariff);
    const frac = clampFraction(fraction === undefined ? 0.5 : fraction);
    const totalSolar = sum(rows, "solar");
    const spread = Math.max(0, rates.shoulder - rates.export_credit);
    const saving = frac * totalSolar * spread * (1 + rates.gst);
    const baselineBill = estimateBill(rows, rates);
    const shiftedBill = baselineBill - saving;
    return {
      fraction: frac,
      saving_aud: saving,
      savingAud: saving,
      baseline_bill: baselineBill,
      baselineBill,
      shifted_bill: shiftedBill,
      shiftedBill
    };
  }

  function dedupeRows(rows) {
    const grouped = new Map();
    const order = [];
    for (const row of rows) {
      const key = JSON.stringify([row.household || "Unknown", row.day || ""]);
      if (!grouped.has(key)) {
        grouped.set(key, { ...row });
        order.push(key);
        continue;
      }
      const target = grouped.get(key);
      for (const field of ["peak", "shoulder", "offpeak", "solar", "grid", "consumed"]) {
        target[field] = (Number(target[field]) || 0) + (Number(row[field]) || 0);
      }
      if (row.bill !== null && row.bill !== undefined) {
        if (target.bill !== null && target.bill !== undefined) {
          target.bill += row.bill;
        } else {
          target.bill = row.bill;
        }
      }
      if ((target.hour === null || target.hour === undefined) && row.hour !== null && row.hour !== undefined) {
        target.hour = row.hour;
      }
    }
    return order.map((key) => grouped.get(key));
  }

  function monthGridAndBill(rows, rates) {
    const grouped = aggregateBy(rows, (row) => row.month);
    const result = new Map();
    for (const item of grouped) {
      if (!item.key) {
        continue;
      }
      const monthRows = rows.filter((row) => row.month === item.key);
      result.set(item.key, { kwh: item.grid, bill: estimateBill(monthRows, rates) });
    }
    return result;
  }

  function comparePlans(rows, plans, gst) {
    const gstRate = gst === null || gst === undefined ? DEFAULT_TARIFF.gst : Number(gst);
    const source = plans && plans.length ? plans : DEFAULT_PLANS;
    const scored = source.map((plan) => {
      const rates = coerceTariff({ ...plan, gst: gstRate < 0 ? 0 : gstRate });
      const bill = estimateBill(rows, rates);
      return {
        name: plan.name || "Plan",
        tariff: rates,
        bill,
        delta_vs_cheapest: 0,
        deltaVsCheapest: 0,
        winner: false
      };
    });
    if (!scored.length) {
      return { plans: [], cheapest: null };
    }
    const cheapestBill = Math.min(...scored.map((item) => item.bill));
    const cheapest = scored.find((item) => item.bill === cheapestBill).name;
    for (const item of scored) {
      item.delta_vs_cheapest = item.bill - cheapestBill;
      item.deltaVsCheapest = item.delta_vs_cheapest;
      item.winner = item.name === cheapest;
    }
    return { plans: scored, cheapest };
  }

  function getAnalysis(rows, tariff, household, tou, dedupe) {
    const rates = coerceTariff(tariff);
    let filtered = filterHousehold(rows, household);
    let touApplied = false;
    let touNote = "";
    if (tou) {
      const hasHour = filtered.some(rowHasHour);
      const eligible = filtered.filter((row) => row.tier_source !== "csv" && rowHasHour(row)).length;
      filtered = applyTou(filtered);
      if (!hasHour) {
        touNote = "TOU skipped: no hour on every row.";
      } else if (!eligible) {
        touNote = "TOU skipped: this CSV already has peak/shoulder/offpeak columns.";
      } else {
        touApplied = true;
        touNote = `TOU applied to ${eligible} rows.`;
      }
    }
    if (dedupe) {
      filtered = dedupeRows(filtered);
    }
    const monthly = aggregateBy(filtered, (row) => row.month).sort((a, b) => a.key.localeCompare(b.key));
    monthly.forEach((item, index) => {
      const monthRows = filtered.filter((row) => row.month === item.key);
      item.tariffBill = estimateBill(monthRows, rates);
      item.tariff_bill = item.tariffBill;
      if (index === 0) {
        item.mom_grid = null;
        item.mom_bill = null;
      } else {
        item.mom_grid = item.grid - monthly[index - 1].grid;
        item.mom_bill = item.tariff_bill - monthly[index - 1].tariff_bill;
      }
      item.momGrid = item.mom_grid;
      item.momBill = item.mom_bill;
    });
    const groups = aggregateBy(filtered, (row) => row.neighbourhood).sort((a, b) => b.grid - a.grid);
    for (const item of groups) {
      const groupRows = filtered.filter((row) => row.neighbourhood === item.key);
      item.tariffBill = estimateBill(groupRows, rates);
      item.tariff_bill = item.tariffBill;
      item.kwh_per_household = item.households ? item.grid / item.households : null;
      item.kwhPerHousehold = item.kwh_per_household;
    }
    const totals = getTotals(filtered, rates);
    const plans = comparePlans(filtered, null, rates.gst);
    const coverage = calendarCoverage(filtered);
    const whatIf = whatIfPeakShift(filtered, rates, 0.1);
    const whatIfSolar = whatIfSolarSelf(filtered, rates, 0.5);
    return {
      rows: filtered,
      monthly,
      groups,
      anomalies: getAnomalies(filtered),
      recommendations: getRecommendations(totals, rates),
      totals,
      heatmap: weekdayHeatmap(filtered),
      tariff: rates,
      households: householdsOf(filtered),
      household: household || "all",
      plans,
      tou: Boolean(tou),
      tou_applied: touApplied,
      touApplied,
      tou_note: touNote,
      touNote,
      coverage,
      weekend: weekendSplit(filtered, rates),
      quality: dataQuality(filtered),
      what_if: whatIf,
      whatIf,
      what_if_solar: whatIfSolar,
      whatIfSolar
    };
  }

  function compareDatasets(left, right, tariff) {
    const rates = coerceTariff(tariff);
    if (!left.length || !right.length) {
      throw new Error("Compare needs two non-empty datasets.");
    }
    const leftHouseholds = new Set(left.map((row) => row.household));
    const rightHouseholds = new Set(right.map((row) => row.household));
    const join = leftHouseholds.size > 1 && rightHouseholds.size > 1 ? "household_day" : "day";
    let shared;
    let leftShared;
    let rightShared;
    if (join === "household_day") {
      const pairKey = (row) => JSON.stringify([row.household, row.day]);
      const leftKeys = new Set(left.map(pairKey));
      const rightKeys = new Set(right.map(pairKey));
      const sharedKeys = new Set([...leftKeys].filter((key) => rightKeys.has(key)));
      leftShared = left.filter((row) => sharedKeys.has(pairKey(row)));
      rightShared = right.filter((row) => sharedKeys.has(pairKey(row)));
      shared = [...new Set([...sharedKeys].map((key) => JSON.parse(key)[1]))].sort();
    } else {
      const leftDays = new Set(left.map((row) => row.day));
      const rightDays = new Set(right.map((row) => row.day));
      shared = [...leftDays].filter((day) => rightDays.has(day)).sort();
      const sharedSet = new Set(shared);
      leftShared = left.filter((row) => sharedSet.has(row.day));
      rightShared = right.filter((row) => sharedSet.has(row.day));
    }
    const leftTotals = getTotals(left, rates);
    const rightTotals = getTotals(right, rates);
    const leftSharedTotals = leftShared.length ? getTotals(leftShared, rates) : null;
    const rightSharedTotals = rightShared.length ? getTotals(rightShared, rates) : null;
    const csvDelta =
      leftTotals.bill === null || rightTotals.bill === null ? null : rightTotals.bill - leftTotals.bill;
    const leftMonths = monthGridAndBill(left, rates);
    const rightMonths = monthGridAndBill(right, rates);
    const monthlyDelta = [...leftMonths.keys()]
      .filter((month) => rightMonths.has(month))
      .sort()
      .map((month) => {
        const deltaKwh = rightMonths.get(month).kwh - leftMonths.get(month).kwh;
        const deltaBill = rightMonths.get(month).bill - leftMonths.get(month).bill;
        return {
          month,
          delta_kwh: deltaKwh,
          deltaKwh,
          delta_bill: deltaBill,
          deltaBill
        };
      });

    return {
      join,
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
      monthly_delta: monthlyDelta,
      monthlyDelta,
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
      tariff_bill: item.tariffBill,
      mom_grid: item.mom_grid ?? item.momGrid ?? null,
      mom_bill: item.mom_bill ?? item.momBill ?? null
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
    DEFAULT_PLANS,
    TIER_SPLIT,
    WEEKDAYS,
    parseCsv,
    parseDateAndHour,
    parseEnergyCsv,
    normaliseRows,
    getAnalysis,
    getAnomalies,
    getRecommendations,
    getTotals,
    estimateBill,
    compareDatasets,
    comparePlans,
    applyTou,
    calendarCoverage,
    weekdayHeatmap,
    weekendSplit,
    dataQuality,
    shiftPeak,
    whatIfPeakShift,
    whatIfSolarSelf,
    dedupeRows,
    filterHousehold,
    householdsOf,
    analysisTable,
    tableToCsv,
    coerceTariff,
    formatNumber,
    formatMoney
  };
})(typeof window !== "undefined" ? window : globalThis);
