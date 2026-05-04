SELECT
    COUNT(*) AS records,
    COUNT(DISTINCT day) AS days,
    COUNT(DISTINCT household_id) AS households,
    MIN(day) AS first_day,
    MAX(day) AS last_day,
    ROUND(SUM(grid_import_kwh), 1) AS grid_import_kwh,
    ROUND(SUM(solar_export_kwh), 1) AS solar_export_kwh,
    ROUND(SUM(consumed_kwh), 1) AS consumed_kwh,
    ROUND(100.0 * SUM(solar_export_kwh) / NULLIF(SUM(consumed_kwh), 0), 1) AS solar_export_pct,
    ROUND(100.0 * SUM(peak_kwh) / NULLIF(SUM(consumed_kwh), 0), 1) AS peak_share_pct
FROM user_daily_profile;
