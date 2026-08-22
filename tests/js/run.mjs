/*
 * Tests for the browser analysis code in assets/studio.js.
 * Zero dependencies — run with: node tests/js/run.mjs
 *
 * These target the places where the browser path and the R/SQL path can
 * silently disagree: date parsing, calendar-day handling, and the anomaly rule.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const G = require(path.join(root, "assets", "studio.js"));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message || "not equal"}: got ${a}, expected ${b}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > (tolerance ?? 1e-9)) {
    throw new Error(`${message || "not close"}: got ${actual}, expected ~${expected}`);
  }
}

/* ------------------------------------------------------------- CSV parsing */

test("parseCsv handles quotes, embedded commas and CRLF", () => {
  const rows = G.parseCsv('a,b,c\r\n1,"two, and a half",3\r\n"say ""hi""",5,6\r\n');
  assertEqual(rows, [
    ["a", "b", "c"],
    ["1", "two, and a half", "3"],
    ['say "hi"', "5", "6"]
  ]);
});

test("parseCsv drops fully blank lines", () => {
  const rows = G.parseCsv("a,b\n1,2\n\n\n3,4\n");
  assertEqual(rows.length, 3);
});

test("normaliseKey matches the R column normaliser", () => {
  assertEqual(G.normaliseKey("  Grid Import (kWh) "), "grid_import_kwh");
  assertEqual(G.normaliseKey("Off-Peak"), "off_peak");
});

test("toNumber strips currency and separators", () => {
  assertEqual(G.toNumber("$1,234.50"), 1234.5);
  assertEqual(G.toNumber(""), 0);
  assertEqual(G.toNumber("not a number"), 0);
  assertEqual(G.optionalNumber(""), null);
  assertEqual(G.optionalNumber("12"), 12);
});

/* ------------------------------------------------------------------- dates */

test("isoDay reports the local calendar day, not a UTC instant", () => {
  // toISOString() on a local-midnight Date shifts back a day everywhere ahead
  // of UTC, which mislabelled every row of the anomaly table in Australia.
  assertEqual(G.isoDay(new Date(2025, 0, 2)), "2025-01-02");
  assertEqual(G.isoDay(new Date(2025, 11, 31)), "2025-12-31");
  assertEqual(G.isoDay(G.parseDate("2025-01-02")), "2025-01-02");
});

test("monthKey and isoDay agree on the same date", () => {
  const date = G.parseDate("2025-03-01");
  assertEqual(G.monthKey(date), "2025-03");
  assertEqual(G.isoDay(date), "2025-03-01");
});

test("makeDate rejects impossible calendar days", () => {
  assertEqual(G.makeDate(2025, 2, 31), null, "31 February must not roll into March");
  assertEqual(G.makeDate(2025, 13, 1), null);
  assertEqual(G.makeDate(2025, 0, 1), null);
  assert(G.makeDate(2024, 2, 29) !== null, "2024 is a leap year");
  assertEqual(G.makeDate(2025, 2, 29), null, "2025 is not");
});

test("detectDateLayout picks one format for the whole column", () => {
  // 13 can only be a day, so the entire column is day-first — including the
  // ambiguous first value, which used to be read as 2 January.
  const detection = G.detectDateLayout(["1/2/2024", "13/2/2024", "28/2/2024"]);
  assertEqual(detection.layout.name, "day-first");
  assertEqual(G.isoDay(G.parseDate("1/2/2024", detection.layout)), "2024-02-01");
});

test("detectDateLayout prefers month-first only when day-first cannot fit", () => {
  const detection = G.detectDateLayout(["2/13/2024", "3/14/2024", "1/20/2024"]);
  assertEqual(detection.layout.name, "month-first");
  assertEqual(G.isoDay(G.parseDate("2/13/2024", detection.layout)), "2024-02-13");
});

test("detectDateLayout flags a genuinely ambiguous column", () => {
  assertEqual(G.detectDateLayout(["01/02/2024", "03/04/2024"]).ambiguous, true);
  assertEqual(G.detectDateLayout(["2024-01-02", "2024-03-04"]).ambiguous, false);
  assertEqual(G.detectDateLayout(["13/02/2024", "28/04/2024"]).ambiguous, false);
});

test("ISO dates win over the ambiguous forms", () => {
  const detection = G.detectDateLayout(["2024-01-02", "2024-03-04"]);
  assertEqual(detection.layout.name, "iso");
  assertEqual(G.isoDay(G.parseDate("2024-01-02", detection.layout)), "2024-01-02");
});

test("two-digit years are read as 20xx", () => {
  assertEqual(G.isoDay(G.parseDate("05/06/24")), "2024-06-05");
});

/* -------------------------------------------------------------- normalise */

function csv(rows) {
  return rows.map((row) => row.join(",")).join("\n");
}

test("normaliseRows requires a date column", () => {
  let threw = false;
  try {
    G.normaliseRows(csv([["foo", "bar"], ["1", "2"]]));
  } catch (err) {
    threw = true;
    assert(err.message.includes("date column"), err.message);
  }
  assert(threw, "expected a throw");
});

test("normaliseRows requires an energy column", () => {
  let threw = false;
  try {
    G.normaliseRows(csv([["day"], ["2025-01-01"]]));
  } catch (err) {
    threw = true;
    assert(err.message.includes("energy columns"), err.message);
  }
  assert(threw, "expected a throw");
});

test("normaliseRows reports how many rows it skipped", () => {
  const rows = G.normaliseRows(
    csv([
      ["day", "grid_import_kwh"],
      ["2025-01-01", "10"],
      ["not-a-date", "12"],
      ["2025-01-03", "11"]
    ])
  );
  assertEqual(rows.length, 2);
  assert(
    rows.notes.some((note) => note.includes("1 row(s) were skipped")),
    `notes were: ${JSON.stringify(rows.notes)}`
  );
});

test("a total-only file is marked as an estimated tier split", () => {
  const rows = G.normaliseRows(
    csv([
      ["day", "total_kwh"],
      ["2025-01-01", "20"],
      ["2025-01-02", "22"]
    ])
  );
  assertEqual(rows.tierSource, "estimated");
  assert(
    rows.notes.some((note) => note.includes("estimated")),
    "the estimate should be stated in the notes"
  );
  // Split matches ESTIMATED_TIER_SHARES and the R pipeline.
  assertClose(rows[0].peak, 20 * G.ESTIMATED_TIER_SHARES.peak, 1e-9);
  assertClose(rows[0].shoulder, 20 * G.ESTIMATED_TIER_SHARES.shoulder, 1e-9);
  assertClose(rows[0].offpeak, 20 * G.ESTIMATED_TIER_SHARES.offpeak, 1e-9);
});

test("a tiered file is marked as measured and carries no estimate note", () => {
  const rows = G.normaliseRows(
    csv([
      ["day", "peak_kwh", "shoulder_kwh", "offpeak_kwh"],
      ["2025-01-01", "8", "6", "4"]
    ])
  );
  assertEqual(rows.tierSource, "measured");
  assertEqual(rows.notes.length, 0);
  assertClose(rows[0].consumed, 18, 1e-9);
});

test("grid import is derived from consumption minus solar when absent", () => {
  const rows = G.normaliseRows(
    csv([
      ["day", "peak_kwh", "shoulder_kwh", "offpeak_kwh", "solar_export_kwh"],
      ["2025-01-01", "8", "6", "4", "5"]
    ])
  );
  assertClose(rows[0].grid, 13, 1e-9);
});

test("grid import never goes negative", () => {
  const rows = G.normaliseRows(
    csv([
      ["day", "peak_kwh", "shoulder_kwh", "offpeak_kwh", "solar_export_kwh"],
      ["2025-01-01", "1", "1", "1", "50"]
    ])
  );
  assertEqual(rows[0].grid, 0);
});

/* --------------------------------------------------------------- anomalies */

test("median handles odd and even lengths", () => {
  assertEqual(G.median([3, 1, 2]), 2);
  assertEqual(G.median([4, 1, 3, 2]), 2.5);
  assertEqual(G.median([]), 0);
});

function series(household, values, startDay = 1) {
  return values.map((value, index) => ({
    date: new Date(2025, 0, startDay + index),
    month: "2025-01",
    household,
    neighbourhood: "Test",
    peak: value * 0.4,
    shoulder: value * 0.35,
    offpeak: value * 0.25,
    solar: 0,
    grid: value,
    bill: null,
    consumed: value
  }));
}

test("a steady household with one spike yields exactly one anomaly", () => {
  const rows = series("H-1", [10, 10.5, 9.8, 10.2, 10.1, 9.9, 10.3, 40, 10.0, 9.7]);
  const anomalies = G.getAnomalies(rows);
  assertEqual(anomalies.length, 1);
  assertEqual(anomalies[0].anomalyType, "high_spike");
  assertEqual(anomalies[0].grid, 40);
  assertEqual(anomalies[0].method, "modified_z");
});

test("household size differences are not treated as anomalies", () => {
  // The old rule compared everything to one global mean, so the big house was
  // permanently "high" and the small one permanently "low".
  const rows = [
    ...series("big", [40, 41, 39, 40.5, 39.5, 40.2, 40.1]),
    ...series("small", [5, 5.2, 4.9, 5.1, 5.0, 4.8, 5.05])
  ];
  assertEqual(G.getAnomalies(rows), []);
});

test("a low dip is caught too", () => {
  const rows = series("H-1", [20, 20.4, 19.7, 20.2, 20.1, 19.9, 20.3, 0.5, 20.0, 19.8]);
  const anomalies = G.getAnomalies(rows);
  assertEqual(anomalies.length, 1);
  assertEqual(anomalies[0].anomalyType, "low_dip");
});

test("the mean-based rule would have been fooled by an extreme outlier", () => {
  // One enormous day drags a mean far enough that the genuine second spike
  // falls under the old 1.5x threshold. The median barely moves.
  const values = [10, 10, 10, 10, 10, 10, 10, 10, 200, 25];
  const rows = series("H-1", values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert(25 < mean * 1.5, "the 25 kWh day hides under the inflated mean");

  const flagged = G.getAnomalies(rows).map((row) => row.grid).sort((a, b) => a - b);
  assertEqual(flagged, [25, 200], "both spikes should be found");
});

test("short histories fall back to a ratio rule against the household median", () => {
  const rows = series("H-1", [10, 10, 30]); // 3 rows, below MIN_OBSERVATIONS_FOR_Z
  const anomalies = G.getAnomalies(rows);
  assertEqual(anomalies.length, 1);
  assertEqual(anomalies[0].method, "ratio");
  assertEqual(anomalies[0].grid, 30);
});

test("a perfectly flat series produces no anomalies and does not divide by zero", () => {
  const rows = series("H-1", [10, 10, 10, 10, 10, 10, 10]);
  assertEqual(G.getAnomalies(rows), []);
});

test("anomaly days carry the correct calendar date", () => {
  const rows = series("H-1", [10, 10.5, 9.8, 10.2, 10.1, 9.9, 10.3, 40, 10.0, 9.7]);
  const anomaly = G.getAnomalies(rows)[0];
  assertEqual(anomaly.day, "2025-01-08", "8th spike is the 8th of January");
});

test("anomalies are sorted by how extreme they are", () => {
  const rows = series("H-1", [10, 10, 10, 10, 10, 10, 10, 60, 30, 10]);
  const anomalies = G.getAnomalies(rows);
  assert(anomalies.length >= 2, "expected at least two");
  assert(anomalies[0].grid > anomalies[1].grid, "most extreme first");
});

test("no rows means no anomalies rather than a crash", () => {
  assertEqual(G.getAnomalies([]), []);
});

/* ---------------------------------------------------------------- analysis */

test("getAnalysis counts distinct days by calendar date", () => {
  const rows = [
    ...series("a", [10, 11]),
    ...series("b", [12, 13]) // same two dates, different household
  ];
  const analysis = G.getAnalysis(rows);
  assertEqual(analysis.totals.records, 4);
  assertEqual(analysis.totals.days, 2);
  assertEqual(analysis.totals.households, 2);
});

test("bills stay null when no bill column was supplied", () => {
  const analysis = G.getAnalysis(series("a", [10, 11]));
  assertEqual(analysis.totals.bill, null);
  assert(
    G.makeInsights(analysis).some((line) => line.includes("No bill column")),
    "the missing bill column should be stated"
  );
});

test("recommendations respond to the numbers", () => {
  const high = G.getRecommendations({ consumed: 100, peak: 50, solar: 30, bill: 3000, days: 100 });
  const labels = high.map((item) => item.opportunity);
  assert(labels.includes("Shift peak usage"), "50% peak share should be flagged");
  assert(labels.includes("Increase solar self-consumption"), "30% solar should be flagged");

  const calm = G.getRecommendations({ consumed: 100, peak: 20, solar: 2, bill: null, days: 100 });
  assertEqual(calm.length, 0, "nothing to say about a well-balanced profile");
});

test("escapeHtml neutralises markup in user data", () => {
  assertEqual(G.escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("the bundled sample CSV parses cleanly", () => {
  const rows = G.normaliseRows(G.sampleCsv);
  assert(rows.length > 0, "sample produced no rows");
  assertEqual(rows.notes.length, 0, `sample should parse without notes: ${rows.notes}`);
});

/* ------------------------------------------------------------------ report */

if (failures.length) {
  console.error(`\n${failures.length} failing, ${passed} passing\n`);
  failures.forEach(({ name, err }) => {
    console.error(`  ✗ ${name}\n    ${err.message}`);
  });
  process.exit(1);
}

console.log(`${passed} passing`);
