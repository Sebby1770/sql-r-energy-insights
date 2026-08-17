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
  const GS = () => {
    if (!window.GridScope) {
      throw new Error("assets/analysis.js must load before studio.js");
    }
    return window.GridScope;
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const state = {
    primaryRows: null,
    compareRows: null,
    label: "",
    household: "all",
    latestAnalysis: null
  };

  function readTariff() {
    const defaults = GS().DEFAULT_TARIFF;
    const num = (id, fallback) => {
      const el = document.getElementById(id);
      if (!el) {
        return fallback;
      }
      const parsed = Number(el.value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      peak: num("tariff-peak", defaults.peak),
      shoulder: num("tariff-shoulder", defaults.shoulder),
      offpeak: num("tariff-offpeak", defaults.offpeak),
      export_credit: num("tariff-export", defaults.export_credit)
    };
  }

  function applyTariffToForm(tariff) {
    const rates = GS().coerceTariff(tariff);
    const mapping = {
      "tariff-peak": rates.peak,
      "tariff-shoulder": rates.shoulder,
      "tariff-offpeak": rates.offpeak,
      "tariff-export": rates.export_credit
    };
    for (const [id, value] of Object.entries(mapping)) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) {
        el.value = Number(value).toFixed(2);
      }
    }
  }

  function currentRows() {
    return GS().filterHousehold(state.primaryRows || [], state.household);
  }

  function currentCompareRows() {
    if (!state.compareRows) {
      return null;
    }
    if (state.household === "all") {
      return state.compareRows;
    }
    const filtered = GS().filterHousehold(state.compareRows, state.household);
    return filtered.length ? filtered : state.compareRows;
  }

  function metric(label, value) {
    return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function deltaClass(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 1e-9) {
      return "";
    }
    return value > 0 ? "delta-up" : "delta-down";
  }

  function deltaMetric(label, value, formatted) {
    return `<div class="metric"><span>${escapeHtml(label)}</span><strong class="${deltaClass(value)}">${escapeHtml(formatted)}</strong></div>`;
  }

  function renderMetrics(analysis) {
    const totals = analysis.totals;
    const target = $("#personal-metrics");
    if (!target) {
      return;
    }
    target.innerHTML = [
      metric("Records", GS().formatNumber(totals.records, 0)),
      metric("Days covered", GS().formatNumber(totals.days, 0)),
      metric("Households", GS().formatNumber(totals.households, 0)),
      metric("Grid import", `${GS().formatNumber(totals.grid)} kWh`),
      metric("Solar export", `${GS().formatNumber(totals.solar)} kWh`),
      metric("CSV cost", GS().formatMoney(totals.bill)),
      metric("Tariff bill", GS().formatMoney(totals.tariffBill))
    ].join("");
  }

  function renderCompare(comparison) {
    const target = $("#compare-metrics");
    if (!target) {
      return;
    }
    if (!comparison) {
      target.hidden = true;
      target.innerHTML = "";
      return;
    }
    target.hidden = false;
    const signedKwh = `${comparison.deltaKwh > 0 ? "+" : ""}${GS().formatNumber(comparison.deltaKwh)} kWh`;
    const signedBill = `${comparison.deltaBill > 0 ? "+" : ""}${GS().formatMoney(comparison.deltaBill)}`;
    target.innerHTML = [
      deltaMetric("Δ grid import", comparison.deltaKwh, signedKwh),
      deltaMetric("Δ tariff bill", comparison.deltaBill, signedBill),
      metric("Shared days", GS().formatNumber(comparison.sharedDays, 0)),
      deltaMetric("Shared-day Δ kWh", comparison.sharedDeltaKwh, `${comparison.sharedDeltaKwh > 0 ? "+" : ""}${GS().formatNumber(comparison.sharedDeltaKwh)} kWh`)
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
        <text x="0" y="${y + 15}" font-size="13" fill="currentColor">${escapeHtml(group.key)}</text>
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
    const visible = anomalies.slice(0, 10);
    const barWidth = Math.max(12, (width - pad.left - pad.right - gap * (visible.length - 1)) / visible.length);
    const bars = visible.map((item, index) => {
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
    if (monthly.length === 0) {
      return emptyChart("No monthly data.");
    }

    const width = 760;
    const height = 310;
    const pad = { top: 30, right: 18, bottom: 54, left: 58 };
    const maxValue = Math.max(...monthly.map((item) => Math.abs(item.tariffBill || 0)), 1);
    const gap = 12;
    const barWidth = Math.max(14, (width - pad.left - pad.right - gap * (monthly.length - 1)) / monthly.length);
    const bars = monthly.map((item, index) => {
      const x = pad.left + index * (barWidth + gap);
      const value = item.tariffBill || 0;
      const barHeight = (Math.abs(value) / maxValue) * (height - pad.top - pad.bottom);
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

  function mixColor(t) {
    const clamp = Math.max(0, Math.min(1, t));
    const from = [226, 232, 240];
    const to = [239, 68, 68];
    const channel = (index) => Math.round(from[index] + (to[index] - from[index]) * clamp);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  function drawHeatmap(heatmap) {
    if (!heatmap || !heatmap.buckets.length) {
      return emptyChart("No heatmap data.");
    }

    const cellW = 36;
    const cellH = 28;
    const left = 52;
    const top = 36;
    const width = Math.max(760, left + heatmap.buckets.length * cellW + 24);
    const height = top + heatmap.weekdays.length * cellH + 36;
    const maxGrid = heatmap.maxGrid || heatmap.max_grid || 1;

    const header = heatmap.buckets.map((bucket, index) => (
      `<text x="${left + index * cellW + cellW / 2}" y="20" text-anchor="middle" font-size="10" fill="${colors.muted}">${escapeHtml(String(bucket))}</text>`
    )).join("");

    const body = heatmap.weekdays.map((weekday, rowIndex) => {
      const label = `<text x="4" y="${top + rowIndex * cellH + 18}" font-size="12" fill="currentColor">${escapeHtml(weekday)}</text>`;
      const cells = heatmap.buckets.map((bucket, colIndex) => {
        const cell = heatmap.cells.find((item) => item.weekday === weekday && item.bucket === bucket);
        const grid = cell ? cell.grid : 0;
        const fill = grid <= 0 ? "rgba(148, 163, 184, 0.18)" : mixColor(grid / maxGrid);
        return `<rect x="${left + colIndex * cellW + 2}" y="${top + rowIndex * cellH + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${fill}"><title>${escapeHtml(weekday)} ${escapeHtml(String(bucket))}: ${GS().formatNumber(grid)} kWh</title></rect>`;
      }).join("");
      return label + cells;
    }).join("");

    return svgFrame(width, height, `${header}${body}`);
  }

  function makeInsights(analysis) {
    const monthly = analysis.monthly;
    const totals = analysis.totals;
    if (!monthly.length) {
      return ["No dated rows to summarise."];
    }
    const highest = monthly.reduce((best, item) => (item.grid > best.grid ? item : best), monthly[0]);
    const lowest = monthly.reduce((best, item) => (item.grid < best.grid ? item : best), monthly[0]);
    const solarOffset = totals.consumed > 0 ? (totals.solar / totals.consumed) * 100 : 0;
    const peakShare = totals.consumed > 0 ? (totals.peak / totals.consumed) * 100 : 0;
    const billInsight = totals.bill === null
      ? `No bill column was supplied. Tariff bill is ${GS().formatMoney(totals.tariffBill)}.`
      : `Estimated CSV spend is ${GS().formatMoney(totals.bill)}. Tariff bill is ${GS().formatMoney(totals.tariffBill)}.`;

    return [
      `Highest grid import month: ${highest.key} at ${GS().formatNumber(highest.grid)} kWh.`,
      `Lowest grid import month: ${lowest.key} at ${GS().formatNumber(lowest.grid)} kWh.`,
      `Solar exports equal ${GS().formatNumber(solarOffset)}% of recorded consumption.`,
      `Peak usage is ${GS().formatNumber(peakShare)}% of recorded consumption.`,
      billInsight
    ];
  }

  function renderInsights(analysis) {
    const target = $("#personal-insights");
    if (!target) {
      return;
    }
    target.innerHTML = makeInsights(analysis)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }

  function renderTable(container, rows, columns) {
    if (!container) {
      return;
    }
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
      { key: "grid", label: "Grid import", format: (value) => `${GS().formatNumber(value)} kWh` },
      { key: "solar", label: "Solar export", format: (value) => `${GS().formatNumber(value)} kWh` },
      { key: "consumed", label: "Consumed", format: (value) => `${GS().formatNumber(value)} kWh` },
      { key: "bill", label: "CSV cost", format: (value) => GS().formatMoney(value) },
      { key: "tariffBill", label: "Tariff bill", format: (value) => GS().formatMoney(value) }
    ]);

    renderTable($("#group-table"), analysis.groups, [
      { key: "key", label: "Group", format: (value) => value },
      { key: "records", label: "Records", format: (value) => GS().formatNumber(value, 0) },
      { key: "households", label: "Households", format: (value) => GS().formatNumber(value, 0) },
      { key: "grid", label: "Grid import", format: (value) => `${GS().formatNumber(value)} kWh` },
      { key: "solar", label: "Solar export", format: (value) => `${GS().formatNumber(value)} kWh` }
    ]);

    renderTable($("#anomaly-table"), analysis.anomalies, [
      { key: "day", label: "Day", format: (value) => value },
      { key: "neighbourhood", label: "Group", format: (value) => value },
      { key: "grid", label: "Grid import", format: (value) => `${GS().formatNumber(value)} kWh` },
      { key: "pctOfAverage", label: "% of average", format: (value) => `${GS().formatNumber(value)}%` },
      { key: "anomalyType", label: "Type", format: (value) => value }
    ]);
  }

  function syncHouseholdFilter(allRows) {
    const wrap = $("#household-filter-wrap");
    const select = $("#household-filter");
    if (!wrap || !select) {
      return;
    }
    const households = GS().householdsOf(allRows);
    if (households.length <= 1) {
      wrap.hidden = true;
      state.household = "all";
      return;
    }
    wrap.hidden = false;
    const current = state.household;
    const options = ["<option value=\"all\">All households</option>"]
      .concat(households.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`));
    select.innerHTML = options.join("");
    select.value = households.includes(current) ? current : "all";
    state.household = select.value;
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportAnalysis() {
    if (!state.latestAnalysis) {
      return;
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      household: state.household,
      tariff: state.latestAnalysis.tariff,
      totals: state.latestAnalysis.totals,
      monthly: state.latestAnalysis.monthly,
      groups: state.latestAnalysis.groups,
      anomalies: state.latestAnalysis.anomalies,
      recommendations: state.latestAnalysis.recommendations,
      heatmap: state.latestAnalysis.heatmap
    };
    downloadText("energy-analysis.json", JSON.stringify(payload, null, 2), "application/json");
  }

  function exportCsv() {
    if (!state.latestAnalysis) {
      return;
    }
    const table = GS().analysisTable(state.latestAnalysis);
    const suffix = state.household === "all" ? "" : `-${state.household}`;
    downloadText(`energy-analysis${suffix}.csv`, GS().tableToCsv(table), "text/csv");
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

  function setStatus(tone, message) {
    const status = $("#upload-status");
    if (!status) {
      return;
    }
    status.dataset.tone = tone;
    status.textContent = message;
  }

  function refreshView() {
    if (!state.primaryRows) {
      return;
    }
    const analysis = GS().getAnalysis(currentRows(), readTariff(), "all");
    state.latestAnalysis = analysis;
    const results = $("#personal-results");
    if (results) {
      results.hidden = false;
    }
    renderMetrics(analysis);
    renderInsights(analysis);
    const monthlyChart = $("#monthly-chart");
    const mixChart = $("#mix-chart");
    const costChart = $("#cost-chart");
    const anomalyChart = $("#anomaly-chart");
    const heatmapChart = $("#heatmap-chart");
    const heatmapNote = $("#heatmap-note");
    if (monthlyChart) {
      monthlyChart.innerHTML = drawMonthlyChart(analysis.monthly);
    }
    if (mixChart) {
      mixChart.innerHTML = drawLoadMix(analysis.groups);
    }
    if (costChart) {
      costChart.innerHTML = drawCostChart(analysis.monthly);
    }
    if (anomalyChart) {
      anomalyChart.innerHTML = drawAnomalyChart(analysis.anomalies);
    }
    if (heatmapChart) {
      heatmapChart.innerHTML = drawHeatmap(analysis.heatmap);
    }
    if (heatmapNote) {
      heatmapNote.textContent = analysis.heatmap.axis === "hour"
        ? "Grid import by weekday and hour of day."
        : "Grid import by weekday and month.";
    }
    renderTables(analysis);
    renderRecommendations(analysis.recommendations);

    const compareRows = currentCompareRows();
    if (compareRows) {
      try {
        renderCompare(GS().compareDatasets(currentRows(), compareRows, readTariff()));
      } catch (error) {
        renderCompare(null);
        setStatus("error", error.message);
      }
    } else {
      renderCompare(null);
    }

    ["export-analysis", "export-csv"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) {
        button.disabled = false;
      }
    });
  }

  function handlePrimaryText(text, label) {
    try {
      const rows = GS().normaliseRows(text);
      state.primaryRows = rows;
      state.label = label;
      state.household = "all";
      syncHouseholdFilter(rows);
      setStatus("ok", `${label}: ${rows.length} records analysed.`);
      refreshView();
    } catch (error) {
      const results = $("#personal-results");
      if (results) {
        results.hidden = true;
      }
      setStatus("error", error.message);
    }
  }

  function handleCompareText(text, label) {
    try {
      if (!state.primaryRows) {
        setStatus("error", "Load a primary CSV before comparing.");
        return;
      }
      state.compareRows = GS().normaliseRows(text);
      setStatus("ok", `${state.label} vs ${label}: compare ready.`);
      refreshView();
    } catch (error) {
      state.compareRows = null;
      renderCompare(null);
      setStatus("error", error.message);
    }
  }

  function readFile(file, onText) {
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result || ""));
    reader.onerror = () => {
      setStatus("error", "The file could not be read.");
    };
    reader.readAsText(file);
  }

  function init() {
    const input = $("#energy-csv");
    const sample = $("#load-sample");
    if (!input || !sample) {
      return;
    }

    applyTheme(localStorage.getItem("gridscope-theme") === "dark" ? "dark" : "light");

    const themeToggle = $("#theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        const nextTheme = document.body.classList.contains("theme-dark") ? "light" : "dark";
        applyTheme(nextTheme);
      });
    }

    const exportButton = $("#export-analysis");
    if (exportButton) {
      exportButton.addEventListener("click", exportAnalysis);
    }
    const exportCsvButton = $("#export-csv");
    if (exportCsvButton) {
      exportCsvButton.addEventListener("click", exportCsv);
    }

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        return;
      }
      readFile(file, (text) => handlePrimaryText(text, file.name));
    });

    sample.addEventListener("click", () => handlePrimaryText(sampleCsv, "Sample data"));

    const compareInput = $("#compare-csv");
    if (compareInput) {
      compareInput.addEventListener("change", () => {
        const file = compareInput.files && compareInput.files[0];
        if (!file) {
          return;
        }
        readFile(file, (text) => handleCompareText(text, file.name));
      });
    }

    const compareSample = $("#compare-sample");
    if (compareSample) {
      compareSample.addEventListener("click", () => handleCompareText(sampleCsv, "Sample data"));
    }

    const householdFilter = $("#household-filter");
    if (householdFilter) {
      householdFilter.addEventListener("change", () => {
        state.household = householdFilter.value || "all";
        refreshView();
      });
    }

    ["tariff-peak", "tariff-shoulder", "tariff-offpeak", "tariff-export"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", refreshView);
      }
    });

    const boot = window.GRIDSCOPE_BOOTSTRAP;
    if (boot && boot.tariff) {
      applyTariffToForm(boot.tariff);
    }
    if (boot && boot.csv) {
      handlePrimaryText(boot.csv, boot.label || "Embedded data");
      if (boot.household && boot.household !== "all") {
        state.household = boot.household;
        syncHouseholdFilter(state.primaryRows || []);
        refreshView();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
}());
