WITH monthly AS (
    SELECT
        strftime('%Y-%m', day) AS month,
        SUM(grid_import_kwh) AS grid_import_kwh,
        SUM(solar_export_kwh) AS solar_export_kwh,
        SUM(estimated_bill) AS estimated_bill
    FROM meter_readings
    GROUP BY strftime('%Y-%m', day)
),
with_trend AS (
    SELECT
        month,
        grid_import_kwh,
        solar_export_kwh,
        estimated_bill,
        LAG(grid_import_kwh) OVER (ORDER BY month) AS previous_import_kwh
    FROM monthly
)
SELECT
    month,
    ROUND(grid_import_kwh, 1) AS grid_import_kwh,
    ROUND(solar_export_kwh, 1) AS solar_export_kwh,
    ROUND(estimated_bill, 2) AS estimated_bill,
    ROUND(grid_import_kwh - previous_import_kwh, 1) AS month_over_month_import_kwh
FROM with_trend
ORDER BY month;
