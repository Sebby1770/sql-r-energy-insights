/* GridScope analysis core for the browser.
 * Mirrors gridscope/analysis.py — keep formulas in sync.
 *
 *   Untiered split: peak 0.44 / shoulder 0.34 / off-peak 0.22 of supplied total
 *   consumed = peak + shoulder + off-peak
 *   grid = supplied grid else max(0, consumed - solar)
 *   NEM12 interval files: hourly rows, import tiered by the TOU windows below
 *     (tier_source "interval"), export as solar
 *   anomalies on household-day totals; baseline window = that household's days
 *     within +/- 15 days (whole history when < 7): MAD > 0 -> modified z
 *     0.6745 * (x - median) / MAD, flag |z| >= 3.5; else ratio 1.5x / 0.5x to the
 *     window median; households with < 4 days use the median of every household-day
 *   battery: per household, time order; charge from export to capacity, deliver
 *     soc * efficiency into import (peak, shoulder, off-peak)
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
 *   data_quality: duplicate (household, day, hour) keys; negative energy; zero grid;
 *     estimated/substituted and missing NEM12 intervals
 *   shift_peak: copy rows, move fraction * peak into off-peak; consumed unchanged
 *   what_if_peak_shift: baseline vs shifted GST-inclusive bills and saving_aud
 *   what_if_solar_self: fraction * solar * max(0, shoulder - export) * (1+gst); does not mutate rows
 *   dedupe_rows: sum energy (+ bill when both present) for duplicate (household, day, hour) keys
 *   groups kwh_per_household = grid / households (else null)
 *   compare monthly_delta: shared month keys, delta_kwh = right.grid - left.grid
 */
(function (root) {
  const VERSION = "0.9.0";

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
  const MAD_MIN_DAYS = 7;
  const ANOMALY_WINDOW_DAYS = 15;
  const MAD_Z_THRESHOLD = 3.5;
  const MAD_SCALE = 0.6745;
  const PLAN_SWITCH_HIGH = 0.1;
  const PLAN_SWITCH_MEDIUM = 0.03;
  const DEFAULT_BATTERY = { capacity_kwh: 10, efficiency: 0.9 };
  const NEM12_UOM = { KWH: 1, WH: 0.001, MWH: 1000 };
  const NEM12_ESTIMATED = new Set(["S", "F", "E"]);
  const NEM12_INTERVALS = new Set([1, 5, 10, 15, 30, 60]);

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

  function parseHourValue(value) {
    const raw = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
    if (raw === "") {
      return null;
    }
    const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
    if (match) {
      let hour = Number(match[1]);
      if (match[3] === "pm" && hour < 12) {
        hour += 12;
      } else if (match[3] === "am" && hour === 12) {
        hour = 0;
      }
      return hour >= 0 && hour <= 23 ? hour : null;
    }
    const number = optionalNumber(raw);
    if (number === null) {
      return null;
    }
    return Math.trunc(Math.max(0, Math.min(23, number)));
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
      hour: pickColumn(headers, ["hour", "interval_hour", "tod_hour", "hour_of_day"]),
      time: pickColumn(headers, ["time", "interval_time", "start_time", "read_time", "interval_start"])
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
      for (const hourCol of [col.time, col.hour]) {
        if (hourCol !== -1) {
          const hourValue = parseHourValue(raw[hourCol]);
          if (hourValue !== null) {
            hour = hourValue;
          }
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

  function looksLikeNem12(text) {
    const lines = String(text || "").replace(/\ufeff/g, "").split(/\r?\n/);
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }
      const cells = stripped.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "").toUpperCase());
      if (cells[0] === "100") {
        return cells.length > 1 && cells[1] === "NEM12";
      }
      return cells[0] === "200";
    }
    return false;
  }

  function nem12Date(raw) {
    const text = String(raw || "").trim();
    if (!/^\d{8}$/.test(text)) {
      throw new Error(`NEM12 300 record has an unreadable date: '${raw}'.`);
    }
    const date = makeDate(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
    if (!date) {
      throw new Error(`NEM12 300 record has an invalid date: '${raw}'.`);
    }
    return date;
  }

  function nem12Value(raw) {
    const text = String(raw === undefined ? "" : raw).trim();
    if (text === "") {
      return null;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  function parseNem12Details(text) {
    const records = parseCsv(text);
    if (!records.length) {
      throw new Error("The NEM12 file is empty.");
    }
    let channel = null;
    const buckets = new Map();
    const nmis = [];
    const channels = [];
    const intervalMinutes = new Set();
    const skipped = new Set();
    let daysSeen = 0;
    let pending = null;

    const bucketFor = (nmi, date, hour) => {
      const key = JSON.stringify([nmi, isoDay(date), hour]);
      if (!buckets.has(key)) {
        buckets.set(key, { nmi, date, hour, import: 0, export: 0, estimated: 0, missing: 0 });
      }
      return buckets.get(key);
    };
    const addDay = (values, flags, date, current) => {
      values.forEach((value, index) => {
        const hour = Math.floor((index * current.interval) / 60);
        const bucket = bucketFor(current.nmi, date, hour);
        if (value === null || flags[index] === "N") {
          bucket.missing += 1;
          return;
        }
        bucket[current.kind] += value * current.scale;
        if (NEM12_ESTIMATED.has(flags[index])) {
          bucket.estimated += 1;
        }
      });
    };
    const flushPending = () => {
      if (pending) {
        addDay(pending.values, pending.flags, pending.date, pending.channel);
        pending = null;
      }
    };

    for (const record of records) {
      const kind = String(record[0] || "").trim();
      if (kind !== "400") {
        flushPending();
      }
      if (kind === "100") {
        const version = String(record[1] || "").trim().toUpperCase();
        if (version !== "NEM12") {
          throw new Error(`Only NEM12 interval files are supported (this header says ${version || "nothing"}).`);
        }
        continue;
      }
      if (kind === "200") {
        if (record.length < 9) {
          throw new Error("NEM12 200 record is missing fields.");
        }
        const nmi = String(record[1]).trim();
        const suffix = String(record[4]).trim().toUpperCase();
        const uom = String(record[7]).trim().toUpperCase();
        const intervalText = String(record[8]).trim();
        const interval = /^\d+$/.test(intervalText) ? Number(intervalText) : NaN;
        if (!Number.isFinite(interval)) {
          throw new Error(`NEM12 200 record has an unreadable interval length: '${record[8]}'.`);
        }
        if (!NEM12_INTERVALS.has(interval)) {
          throw new Error(`NEM12 interval length ${interval} is not supported.`);
        }
        const first = suffix.slice(0, 1);
        const channelKind = first === "E" ? "import" : first === "B" ? "export" : null;
        const scale = Object.prototype.hasOwnProperty.call(NEM12_UOM, uom) ? NEM12_UOM[uom] : null;
        if (!channelKind || scale === null) {
          skipped.add(`${suffix} (${uom})`);
          channel = { skip: true };
          continue;
        }
        channel = { skip: false, nmi, suffix, kind: channelKind, scale, interval };
        intervalMinutes.add(interval);
        if (!nmis.includes(nmi)) {
          nmis.push(nmi);
        }
        const label = `${nmi}:${suffix}`;
        if (!channels.includes(label)) {
          channels.push(label);
        }
        continue;
      }
      if (kind === "300") {
        if (!channel) {
          throw new Error("NEM12 300 record appears before any 200 record.");
        }
        if (channel.skip) {
          continue;
        }
        const count = Math.floor(1440 / channel.interval);
        if (record.length < 2 + count) {
          throw new Error(`NEM12 300 record has ${Math.max(0, record.length - 2)} values; expected ${count} for ${channel.interval}-minute intervals.`);
        }
        const date = nem12Date(record[1]);
        const values = record.slice(2, 2 + count).map(nem12Value);
        let flag = record.length > 2 + count ? String(record[2 + count]).trim().toUpperCase().slice(0, 1) : "";
        flag = flag || "A";
        daysSeen += 1;
        if (flag === "V") {
          pending = { channel, date, values, flags: new Array(count).fill("A") };
          continue;
        }
        addDay(values, new Array(count).fill(flag), date, channel);
        continue;
      }
      if (kind === "400") {
        if (!pending || record.length < 4) {
          continue;
        }
        const startText = String(record[1]).trim();
        const endText = String(record[2]).trim();
        if (!/^-?\d+$/.test(startText) || !/^-?\d+$/.test(endText)) {
          continue;
        }
        const start = Number(startText);
        const end = Number(endText);
        const flag = String(record[3]).trim().toUpperCase().slice(0, 1) || "A";
        for (let position = Math.max(1, start); position <= Math.min(pending.flags.length, end); position += 1) {
          pending.flags[position - 1] = flag;
        }
      }
    }
    flushPending();

    if (!buckets.size) {
      throw new Error("No kWh import or export channels were found in this NEM12 file.");
    }

    const keys = Array.from(buckets.keys()).sort((a, b) => {
      const left = JSON.parse(a);
      const right = JSON.parse(b);
      for (let i = 0; i < 3; i += 1) {
        if (left[i] < right[i]) {
          return -1;
        }
        if (left[i] > right[i]) {
          return 1;
        }
      }
      return 0;
    });
    const rows = keys.map((key) => {
      const bucket = buckets.get(key);
      const weekday = weekdayName(bucket.date);
      const grid = bucket.import;
      const tier = touBucket(weekday, bucket.hour);
      return {
        date: bucket.date,
        day: isoDay(bucket.date),
        month: monthKey(bucket.date),
        weekday,
        hour: bucket.hour,
        household: bucket.nmi,
        neighbourhood: "Ungrouped",
        peak: tier === "peak" ? grid : 0,
        shoulder: tier === "shoulder" ? grid : 0,
        offpeak: tier === "offpeak" ? grid : 0,
        solar: bucket.export,
        grid,
        bill: null,
        consumed: grid,
        tier_source: "interval",
        tierSource: "interval",
        estimated_intervals: bucket.estimated,
        missing_intervals: bucket.missing
      };
    });
    const meta = {
      format: "nem12",
      nmis,
      channels,
      interval_minutes: intervalMinutes.size ? Math.min(...intervalMinutes) : null,
      skipped_channels: Array.from(skipped).sort(),
      interval_days: daysSeen
    };
    return { rows, meta };
  }

  function parseNem12(text) {
    return parseNem12Details(text).rows;
  }

  function detectFormat(text) {
    return looksLikeNem12(text) ? "nem12" : "csv";
  }

  function parseEnergyTextDetails(text, options) {
    if (looksLikeNem12(text)) {
      return parseNem12Details(text);
    }
    return {
      rows: parseEnergyCsv(text, options),
      meta: { format: "csv", nmis: [], channels: [], interval_minutes: null, skipped_channels: [], interval_days: 0 }
    };
  }

  function parseEnergyText(text, options) {
    return parseEnergyTextDetails(text, options).rows;
  }

  function normaliseRows(text, options) {
    return parseEnergyText(text, options);
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
      if (row.tier_source === "csv" || row.tier_source === "interval" || !rowHasHour(row)) {
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

  function median(values) {
    const ordered = Array.from(values, Number).sort((a, b) => a - b);
    const count = ordered.length;
    if (!count) {
      return null;
    }
    const middle = Math.floor(count / 2);
    if (count % 2) {
      return ordered[middle];
    }
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function compareText(a, b) {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  }

  function dailyTotals(rows) {
    const totals = new Map();
    for (const row of rows) {
      const household = String(row.household || "Unknown");
      const day = String(row.day || "");
      const key = JSON.stringify([household, day]);
      if (!totals.has(key)) {
        totals.set(key, {
          day,
          household,
          neighbourhood: row.neighbourhood || "Ungrouped",
          grid: 0,
          solar: 0,
          consumed: 0,
          bill: null
        });
      }
      const item = totals.get(key);
      item.grid += Number(row.grid) || 0;
      item.solar += Number(row.solar) || 0;
      item.consumed += Number(row.consumed) || 0;
      if (row.bill !== null && row.bill !== undefined) {
        item.bill = (item.bill || 0) + Number(row.bill);
      }
    }
    return Array.from(totals.values()).sort((a, b) => compareText(a.household, b.household) || compareText(a.day, b.day));
  }

  function dailySeries(rows) {
    const byDay = new Map();
    for (const item of dailyTotals(rows)) {
      if (!byDay.has(item.day)) {
        byDay.set(item.day, { day: item.day, grid: 0, solar: 0, consumed: 0 });
      }
      const target = byDay.get(item.day);
      target.grid += item.grid;
      target.solar += item.solar;
      target.consumed += item.consumed;
    }
    return Array.from(byDay.keys()).sort(compareText).map((day) => byDay.get(day));
  }

  function dayOrdinal(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return Math.round(Date.UTC(year, month - 1, day) / 86400000);
  }

  function ratioType(value, baseline) {
    if (baseline <= 0) {
      return null;
    }
    if (value >= baseline * 1.5) {
      return "high_spike";
    }
    if (value <= baseline * 0.5) {
      return "low_dip";
    }
    return null;
  }

  function getAnomalies(rows) {
    const days = dailyTotals(rows);
    if (!days.length) {
      return [];
    }
    const globalMedian = median(days.map((item) => item.grid)) || 0;
    const grouped = new Map();
    for (const item of days) {
      if (!grouped.has(item.household)) {
        grouped.set(item.household, []);
      }
      grouped.get(item.household).push(item);
    }
    const flagged = [];
    for (const [household, householdDays] of grouped.entries()) {
      const values = householdDays.map((item) => item.grid);
      const ordinals = householdDays.map((item) => dayOrdinal(item.day));
      const count = values.length;
      householdDays.forEach((item, position) => {
        const grid = item.grid;
        let window = values.filter((_, other) => Math.abs(ordinals[other] - ordinals[position]) <= ANOMALY_WINDOW_DAYS);
        if (window.length < MAD_MIN_DAYS) {
          window = values;
        }
        const windowMedian = median(window) || 0;
        let mad = null;
        if (window.length >= MAD_MIN_DAYS) {
          mad = median(window.map((value) => Math.abs(value - windowMedian)));
        }
        let method;
        let baseline;
        let baselineKwh;
        let zScore = null;
        let anomalyType;
        if (count >= HOUSEHOLD_BASELINE_MIN_ROWS && mad !== null && mad > 0) {
          method = "mad";
          baseline = "household";
          baselineKwh = windowMedian;
          zScore = (MAD_SCALE * (grid - windowMedian)) / mad;
          if (zScore >= MAD_Z_THRESHOLD) {
            anomalyType = "high_spike";
          } else if (zScore <= -MAD_Z_THRESHOLD) {
            anomalyType = "low_dip";
          } else {
            return;
          }
        } else {
          method = "ratio";
          if (count >= HOUSEHOLD_BASELINE_MIN_ROWS) {
            baseline = "household";
            baselineKwh = windowMedian;
          } else {
            baseline = "global";
            baselineKwh = globalMedian;
          }
          anomalyType = ratioType(grid, baselineKwh);
          if (!anomalyType) {
            return;
          }
        }
        const pct = baselineKwh > 0 ? (grid / baselineKwh) * 100 : 0;
        flagged.push({
          day: item.day,
          neighbourhood: item.neighbourhood,
          household,
          grid,
          consumed: item.consumed,
          bill: item.bill,
          pctOfAverage: pct,
          pct_of_average: pct,
          anomalyType,
          anomaly_type: anomalyType,
          baseline,
          baselineKwh,
          baseline_kwh: baselineKwh,
          method,
          z_score: zScore,
          zScore
        });
      });
    }
    return flagged.sort((a, b) => {
      const delta = Math.abs(b.grid - b.baseline_kwh) - Math.abs(a.grid - a.baseline_kwh);
      if (delta !== 0) {
        return delta;
      }
      return compareText(String(a.day), String(b.day)) || compareText(String(a.household), String(b.household));
    });
  }

  function getRecommendations(totals, tariff, plans) {
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

    const switchSaving = Number((plans || {}).switch_saving ?? (plans || {}).switchSaving) || 0;
    const currentBill = Number((plans || {}).current_bill ?? (plans || {}).currentBill) || 0;
    if (switchSaving > 0.005 && currentBill > 0) {
      const share = switchSaving / currentBill;
      const cheapest = String((plans || {}).cheapest || "the cheapest plan");
      recommendations.push({
        opportunity: `Switch to ${cheapest}`,
        detail: `On this usage ${cheapest} bills ${formatMoney(switchSaving)} less than your current tariff (${formatNumber(share * 100)}%).`,
        impact: share >= PLAN_SWITCH_HIGH ? "high" : share >= PLAN_SWITCH_MEDIUM ? "medium" : "low",
        saving_aud: switchSaving,
        savingAud: switchSaving
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
      return compareText(a.opportunity, b.opportunity);
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

    const sums = new Map();
    for (const row of rows) {
      const bucket = bucketOf(row);
      if (bucket === null || bucket === undefined || !WEEKDAYS.includes(row.weekday)) {
        continue;
      }
      const key = `${row.weekday}|${bucket}`;
      const cell = sums.get(key) || [0, 0];
      cell[0] += Number(row.grid) || 0;
      cell[1] += 1;
      sums.set(key, cell);
    }
    const cells = [];
    let maxGrid = 0;
    for (const weekday of WEEKDAYS) {
      for (const bucket of buckets) {
        const [grid, records] = sums.get(`${weekday}|${bucket}`) || [0, 0];
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
    const days = rows.map((row) => row.day).filter(Boolean).sort(compareText);
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
      gst_amount: components.gst_amount,
      first_day: days.length ? days[0] : null,
      last_day: days.length ? days[days.length - 1] : null
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

  function readingKey(row) {
    const hour = rowHasHour(row) ? String(Math.trunc(Number(row.hour))) : "";
    return JSON.stringify([String(row.household || "Unknown"), String(row.day || ""), hour]);
  }

  function dataQuality(rows) {
    const keyCounts = new Map();
    for (const row of rows) {
      const key = readingKey(row);
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
    let estimatedIntervals = 0;
    let missingIntervals = 0;
    for (const row of rows) {
      estimatedIntervals += Number(row.estimated_intervals) || 0;
      missingIntervals += Number(row.missing_intervals) || 0;
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
      zeroGrid,
      estimated_intervals: estimatedIntervals,
      estimatedIntervals,
      missing_intervals: missingIntervals,
      missingIntervals
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

  function positive(value) {
    const number = Number(value) || 0;
    return number > 0 ? number : 0;
  }

  function simulateBattery(rows, capacityKwh, efficiency) {
    const capacity = Math.max(0, Number(capacityKwh === undefined ? DEFAULT_BATTERY.capacity_kwh : capacityKwh) || 0);
    const eff = clampFraction(efficiency === undefined ? DEFAULT_BATTERY.efficiency : efficiency);
    const adjusted = rows.map((row) => ({ ...row }));
    const order = adjusted.map((_, index) => index).sort((a, b) => {
      const left = adjusted[a];
      const right = adjusted[b];
      return compareText(String(left.household || "Unknown"), String(right.household || "Unknown"))
        || compareText(String(left.day || ""), String(right.day || ""))
        || (rowHasHour(left) ? Number(left.hour) : -1) - (rowHasHour(right) ? Number(right.hour) : -1)
        || a - b;
    });
    const stateOfCharge = new Map();
    let chargedTotal = 0;
    let deliveredTotal = 0;
    for (const index of order) {
      const row = adjusted[index];
      const household = String(row.household || "Unknown");
      let soc = stateOfCharge.get(household) || 0;
      const exported = positive(row.solar);
      const charge = Math.min(exported, Math.max(0, capacity - soc));
      if (charge > 0) {
        soc += charge;
        row.solar = (Number(row.solar) || 0) - charge;
        chargedTotal += charge;
      }
      if (eff > 0 && soc > 0) {
        const tiers = { peak: positive(row.peak), shoulder: positive(row.shoulder), offpeak: positive(row.offpeak) };
        const demand = Math.min(positive(row.grid), tiers.peak + tiers.shoulder + tiers.offpeak);
        const deliver = Math.min(soc * eff, demand);
        if (deliver > 0) {
          let remaining = deliver;
          for (const name of ["peak", "shoulder", "offpeak"]) {
            const take = Math.min(remaining, tiers[name]);
            if (take > 0) {
              row[name] = (Number(row[name]) || 0) - take;
              remaining -= take;
            }
          }
          row.grid = (Number(row.grid) || 0) - deliver;
          soc = Math.max(0, soc - deliver / eff);
          deliveredTotal += deliver;
        }
      }
      stateOfCharge.set(household, soc);
    }
    return { rows: adjusted, charged_kwh: chargedTotal, delivered_kwh: deliveredTotal };
  }

  function whatIfBattery(rows, tariff, capacityKwh, efficiency, costAud) {
    const rates = coerceTariff(tariff);
    const capacity = Math.max(0, Number(capacityKwh === undefined ? DEFAULT_BATTERY.capacity_kwh : capacityKwh) || 0);
    const eff = clampFraction(efficiency === undefined ? DEFAULT_BATTERY.efficiency : efficiency);
    const sim = simulateBattery(rows, capacity, eff);
    const baselineBill = estimateBill(rows, rates);
    const batteryBill = estimateBill(sim.rows, rates);
    const saving = baselineBill - batteryBill;
    const days = new Set(rows.map((row) => row.day)).size;
    const batteries = new Set(rows.map((row) => String(row.household || "Unknown"))).size;
    const annualSaving = days ? (saving * 365) / days : 0;
    const costNumber = costAud === null || costAud === undefined || costAud === "" ? null : Number(costAud);
    const cost = costNumber === null || !Number.isFinite(costNumber) ? null : Math.max(0, costNumber);
    const totalCost = cost === null ? null : cost * batteries;
    const payback = totalCost !== null && totalCost > 0 && annualSaving > 0 ? totalCost / annualSaving : null;
    const cycles = capacity > 0 && batteries ? sim.charged_kwh / (capacity * batteries) : 0;
    return {
      capacity_kwh: capacity,
      efficiency: eff,
      days,
      batteries,
      charged_kwh: sim.charged_kwh,
      delivered_kwh: sim.delivered_kwh,
      cycles,
      baseline_bill: baselineBill,
      battery_bill: batteryBill,
      saving_aud: saving,
      savingAud: saving,
      annual_saving_aud: annualSaving,
      annualSavingAud: annualSaving,
      cost_aud: cost,
      total_cost_aud: totalCost,
      payback_years: payback,
      paybackYears: payback
    };
  }

  function dedupeRows(rows) {
    const grouped = new Map();
    const order = [];
    for (const row of rows) {
      const key = readingKey(row);
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
      for (const field of ["estimated_intervals", "missing_intervals"]) {
        if ((row[field] !== null && row[field] !== undefined) || (target[field] !== null && target[field] !== undefined)) {
          target[field] = (Number(target[field]) || 0) + (Number(row[field]) || 0);
        }
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

  function comparePlans(rows, plans, gst, current) {
    let gstRate = gst === null || gst === undefined ? DEFAULT_TARIFF.gst : Number(gst);
    if (!Number.isFinite(gstRate) || gstRate < 0) {
      gstRate = 0;
    }
    const source = plans === null || plans === undefined ? DEFAULT_PLANS : plans;
    const currentBill = current ? estimateBill(rows, { ...current, gst: gstRate }) : null;
    const scored = source.map((plan) => {
      const rates = coerceTariff({ ...plan, gst: gstRate });
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
      return { plans: [], cheapest: null, current_bill: currentBill, switch_saving: 0, switchSaving: 0 };
    }
    const cheapestBill = Math.min(...scored.map((item) => item.bill));
    const cheapestIndex = scored.findIndex((item) => item.bill === cheapestBill);
    scored.forEach((item, index) => {
      item.delta_vs_cheapest = item.bill - cheapestBill;
      item.deltaVsCheapest = item.delta_vs_cheapest;
      item.winner = index === cheapestIndex;
    });
    const switchSaving = currentBill === null ? 0 : Math.max(0, currentBill - cheapestBill);
    return {
      plans: scored,
      cheapest: scored[cheapestIndex].name,
      current_bill: currentBill,
      currentBill,
      switch_saving: switchSaving,
      switchSaving
    };
  }

  function getAnalysis(rows, tariff, household, tou, dedupe, options) {
    const extra = options || {};
    const rates = coerceTariff(tariff);
    let filtered = filterHousehold(rows, household);
    let touApplied = false;
    let touNote = "";
    if (tou) {
      const hasHour = filtered.some(rowHasHour);
      const eligible = filtered.filter((row) => row.tier_source !== "csv" && row.tier_source !== "interval" && rowHasHour(row)).length;
      const intervalRows = filtered.some((row) => row.tier_source === "interval");
      filtered = applyTou(filtered);
      if (!hasHour) {
        touNote = "TOU skipped: no hour on every row.";
      } else if (!eligible && intervalRows) {
        touNote = "TOU windows are already applied to NEM12 interval data.";
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
    const rowsByMonth = new Map();
    const rowsByGroup = new Map();
    for (const row of filtered) {
      if (!rowsByMonth.has(row.month)) {
        rowsByMonth.set(row.month, []);
      }
      rowsByMonth.get(row.month).push(row);
      if (!rowsByGroup.has(row.neighbourhood)) {
        rowsByGroup.set(row.neighbourhood, []);
      }
      rowsByGroup.get(row.neighbourhood).push(row);
    }
    const monthly = aggregateBy(filtered, (row) => row.month).sort((a, b) => compareText(a.key, b.key));
    monthly.forEach((item, index) => {
      item.tariffBill = estimateBill(rowsByMonth.get(item.key) || [], rates);
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
    const groups = aggregateBy(filtered, (row) => row.neighbourhood).sort((a, b) => (b.grid - a.grid) || compareText(a.key, b.key));
    for (const item of groups) {
      item.tariffBill = estimateBill(rowsByGroup.get(item.key) || [], rates);
      item.tariff_bill = item.tariffBill;
      item.kwh_per_household = item.households ? item.grid / item.households : null;
      item.kwhPerHousehold = item.kwh_per_household;
    }
    const totals = getTotals(filtered, rates);
    const plans = comparePlans(filtered, extra.plans === undefined ? null : extra.plans, rates.gst, rates);
    const coverage = calendarCoverage(filtered);
    const whatIf = whatIfPeakShift(filtered, rates, 0.1);
    const whatIfSolar = whatIfSolarSelf(filtered, rates, 0.5);
    const battery = { ...DEFAULT_BATTERY, cost_aud: null, ...(extra.battery || {}) };
    const whatIfBatteryResult = whatIfBattery(filtered, rates, battery.capacity_kwh, battery.efficiency, battery.cost_aud);
    const intervalRows = filtered.filter((row) => row.tier_source === "interval").length;
    return {
      rows: filtered,
      monthly,
      groups,
      daily: dailySeries(filtered),
      anomalies: getAnomalies(filtered),
      recommendations: getRecommendations(totals, rates, plans),
      totals,
      heatmap: weekdayHeatmap(filtered),
      tariff: rates,
      households: householdsOf(filtered),
      household: household || "all",
      plans,
      source: { format: intervalRows ? "nem12" : "csv", interval_rows: intervalRows, hourly: filtered.some(rowHasHour) },
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
      whatIfSolar,
      what_if_battery: whatIfBatteryResult,
      whatIfBattery: whatIfBatteryResult
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
    DEFAULT_BATTERY,
    TIER_SPLIT,
    WEEKDAYS,
    parseCsv,
    parseHourValue,
    looksLikeNem12,
    detectFormat,
    parseNem12,
    parseNem12Details,
    parseEnergyText,
    parseEnergyTextDetails,
    median,
    dailyTotals,
    dailySeries,
    simulateBattery,
    whatIfBattery,
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
