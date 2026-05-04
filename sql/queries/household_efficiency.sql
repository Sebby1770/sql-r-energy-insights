WITH annual AS (
    SELECT
        h.household_id,
        h.neighbourhood,
        h.home_type,
        h.residents,
        h.solar_kw,
        SUM(m.peak_kwh + m.shoulder_kwh + m.offpeak_kwh) AS consumed_kwh,
        SUM(m.grid_import_kwh) AS grid_import_kwh,
        SUM(m.solar_export_kwh) AS solar_export_kwh,
        SUM(m.estimated_bill) AS annual_bill
    FROM households AS h
    JOIN meter_readings AS m ON m.household_id = h.household_id
    GROUP BY
        h.household_id,
        h.neighbourhood,
        h.home_type,
        h.residents,
        h.solar_kw
),
ranked AS (
    SELECT
        annual.*,
        ROW_NUMBER() OVER (
            ORDER BY consumed_kwh / residents ASC, annual_bill ASC
        ) AS efficiency_rank
    FROM annual
)
SELECT
    efficiency_rank,
    household_id,
    neighbourhood,
    home_type,
    residents,
    solar_kw,
    ROUND(consumed_kwh, 1) AS consumed_kwh,
    ROUND(grid_import_kwh, 1) AS grid_import_kwh,
    ROUND(solar_export_kwh, 1) AS solar_export_kwh,
    ROUND(consumed_kwh / residents, 1) AS kwh_per_resident,
    ROUND(annual_bill, 2) AS annual_bill,
    ROUND(annual_bill / residents, 2) AS annual_bill_per_resident,
    CASE
        WHEN solar_kw >= 5 THEN 'solar leader'
        WHEN consumed_kwh / residents < 1400 THEN 'lean user'
        WHEN annual_bill / residents > 850 THEN 'high cost'
        ELSE 'steady user'
    END AS insight_segment
FROM ranked
ORDER BY efficiency_rank;
