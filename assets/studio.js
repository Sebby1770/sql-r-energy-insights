(function () {
  const sampleCsv = `day,household_id,neighbourhood,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh,grid_import_kwh,estimated_bill
2025-01-01,H-101,Northbank,7.2,5.8,3.4,6.1,13.8,5.42
2025-01-02,H-101,Northbank,6.9,5.6,3.1,5.8,13.2,5.19
2025-01-03,H-102,Northbank,8.4,6.3,4.2,0,18.9,6.81
2025-02-01,H-201,East Park,5.9,4.7,3.2,7.4,10.7,4.24
2025-02-02,H-201,East Park,6.1,4.8,3.3,7.2,11.1,4.36
2025-02-03,H-202,East Park,9.2,7,4.8,1.4,19,7.18
2025-03-01,H-301,Harbourview,4.8,4,2.8,5.3,9.4,3.73
2025-03-02,H-301,Harbourview,4.9,4.2,2.7,5,9.7,3.82
2025-03-03,H-302,Harbourview,7.4,5.8,3.9,2.2,16.2,5.88
2025-04-01,H-401,Westfield,5.6,4.9,3.7,3.8,13,4.94
2025-04-02,H-401,Westfield,5.4,4.8,3.6,3.5,12.9,4.89
2025-04-03,H-402,Westfield,8.8,6.6,4.3,0,19.7,7.05
2025-05-01,H-101,Northbank,6.4,5.4,3.9,3.6,15.3,5.62
2025-05-02,H-201,East Park,5.2,4.8,3.8,4.9,12.3,4.58
2025-05-03,H-301,Harbourview,5.8,4.9,3.4,3.1,13.9,5.03
2025-06-01,H-102,Northbank,9,6.8,5.4,0,21.2,7.61
2025-06-02,H-202,East Park,8.7,6.7,5.2,1,20.2,7.38
2025-06-03,H-402,Westfield,9.3,7.2,5.7,0,22.2,7.94`;

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

  function parseDate(value) {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const date = new Date(`${raw.slice(0, 10)}T00:00:00`);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (parts) {
      const first = Number(parts[1]);
      const second = Number(parts[2]);
      const year = Number(parts[3].length === 2 ? `20${parts[3]}` : parts[3]);
      const day = first > 12 ? first : second;
      const month = first > 12 ? second : first;
      const date = new Date(year, month - 1, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
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

    const rows = [];
    for (let i = 1; i < parsed.length; i += 1) {
      const raw = parsed[i];
      const date = parseDate(raw[col.day]);
      if (!date) {
        continue;
      }

      const suppliedTotal = col.total !== -1 ? toNumber(raw[col.total]) : toNumber(raw[col.grid]);
      let peak = col.peak !== -1 ? toNumber(raw[col.peak]) : 0;
      let shoulder = col.shoulder !== -1 ? toNumber(raw[col.shoulder]) : 0;
      let offpeak = col.offpeak !== -1 ? toNumber(raw[col.offpeak]) : 0;

      if (!hasTieredUsage && suppliedTotal > 0) {
        peak = suppliedTotal * 0.44;
        shoulder = suppliedTotal * 0.34;
        offpeak = suppliedTotal * 0.22;
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

  function getAnalysis(rows) {
    const monthly = aggregateBy(rows, (row) => row.month).sort((a, b) => a.key.localeCompare(b.key));
    const groups = aggregateBy(rows, (row) => row.neighbourhood).sort((a, b) => b.grid - a.grid);
    const billRows = rows.filter((row) => row.bill !== null).length;

    return {
      rows,
      monthly,
      groups,
      totals: {
        records: rows.length,
        days: new Set(rows.map((row) => row.date.toISOString().slice(0, 10))).size,
        households: new Set(rows.map((row) => row.household)).size,
        grid: sum(rows, "grid"),
        solar: sum(rows, "solar"),
        consumed: sum(rows, "consumed"),
        peak: sum(rows, "peak"),
        shoulder: sum(rows, "shoulder"),
        offpeak: sum(rows, "offpeak"),
        bill: billRows > 0 ? rows.reduce((total, row) => total + (row.bill || 0), 0) : null
      }
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
  }

  function renderAnalysis(rows, label) {
    const analysis = getAnalysis(rows);
    $("#personal-results").hidden = false;
    $("#upload-status").dataset.tone = "ok";
    $("#upload-status").textContent = `${label}: ${analysis.totals.records} records analysed.`;
    renderMetrics(analysis);
    renderInsights(analysis);
    $("#monthly-chart").innerHTML = drawMonthlyChart(analysis.monthly);
    $("#mix-chart").innerHTML = drawLoadMix(analysis.groups);
    $("#cost-chart").innerHTML = drawCostChart(analysis.monthly);
    renderTables(analysis);
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
    if (!input || !sample) {
      return;
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

    sample.addEventListener("click", () => handleText(sampleCsv, "Sample data"));
  }

  document.addEventListener("DOMContentLoaded", init);
}());
