WITH monthly AS (
    SELECT
        strftime('%Y-%m', day) AS month,
        SUM(grid_import_kwh) AS grid_import_kwh,
        SUM(solar_export_kwh) AS solar_export_kwh,
        SUM(consumed_kwh) AS consumed_kwh,
        SUM(peak_kwh) AS peak_kwh,
        SUM(shoulder_kwh) AS shoulder_kwh,
        SUM(offpeak_kwh) AS offpeak_kwh,
        SUM(COALESCE(estimated_bill, 0)) AS estimated_bill,
        COUNT(estimated_bill) AS bill_rows
    FROM user_daily_profile
    GROUP BY strftime('%Y-%m', day)
),
with_trend AS (
    SELECT
        month,
        grid_import_kwh,
        solar_export_kwh,
        consumed_kwh,
        peak_kwh,
        shoulder_kwh,
        offpeak_kwh,
        CASE WHEN bill_rows = 0 THEN NULL ELSE estimated_bill END AS estimated_bill,
        LAG(grid_import_kwh) OVER (ORDER BY month) AS previous_import_kwh
    FROM monthly
)
SELECT
    month,
    ROUND(grid_import_kwh, 1) AS grid_import_kwh,
    ROUND(solar_export_kwh, 1) AS solar_export_kwh,
    ROUND(consumed_kwh, 1) AS consumed_kwh,
    ROUND(peak_kwh, 1) AS peak_kwh,
    ROUND(shoulder_kwh, 1) AS shoulder_kwh,
    ROUND(offpeak_kwh, 1) AS offpeak_kwh,
    ROUND(estimated_bill, 2) AS estimated_bill,
    ROUND(grid_import_kwh - previous_import_kwh, 1) AS month_over_month_import_kwh
FROM with_trend
ORDER BY month;
