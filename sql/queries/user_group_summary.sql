SELECT
    neighbourhood,
    COUNT(*) AS records,
    COUNT(DISTINCT household_id) AS households,
    ROUND(SUM(grid_import_kwh), 1) AS grid_import_kwh,
    ROUND(SUM(solar_export_kwh), 1) AS solar_export_kwh,
    ROUND(SUM(consumed_kwh), 1) AS consumed_kwh,
    ROUND(100.0 * SUM(peak_kwh) / NULLIF(SUM(consumed_kwh), 0), 1) AS peak_share_pct,
    ROUND(SUM(COALESCE(estimated_bill, 0)), 2) AS estimated_bill
FROM user_daily_profile
GROUP BY neighbourhood
ORDER BY grid_import_kwh DESC;
