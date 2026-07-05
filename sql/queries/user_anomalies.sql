WITH daily_totals AS (
    SELECT
        day,
        neighbourhood,
        household_id,
        grid_import_kwh,
        consumed_kwh,
        estimated_bill
    FROM user_daily_profile
),
stats AS (
    SELECT
        AVG(grid_import_kwh) AS avg_grid_import_kwh,
        MAX(grid_import_kwh) AS max_grid_import_kwh
    FROM daily_totals
)
SELECT
    d.day,
    d.neighbourhood,
    d.household_id,
    ROUND(d.grid_import_kwh, 1) AS grid_import_kwh,
    ROUND(d.consumed_kwh, 1) AS consumed_kwh,
    ROUND(d.estimated_bill, 2) AS estimated_bill,
    ROUND(100.0 * d.grid_import_kwh / NULLIF(s.avg_grid_import_kwh, 0), 1) AS pct_of_average,
    CASE
        WHEN d.grid_import_kwh >= s.avg_grid_import_kwh * 1.5 THEN 'high_spike'
        WHEN d.grid_import_kwh <= s.avg_grid_import_kwh * 0.5 THEN 'low_dip'
        ELSE 'normal'
    END AS anomaly_type
FROM daily_totals AS d
CROSS JOIN stats AS s
WHERE d.grid_import_kwh >= s.avg_grid_import_kwh * 1.5
   OR d.grid_import_kwh <= s.avg_grid_import_kwh * 0.5
ORDER BY ABS(d.grid_import_kwh - s.avg_grid_import_kwh) DESC, d.day;