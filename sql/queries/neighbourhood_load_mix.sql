SELECT
    neighbourhood,
    ROUND(SUM(peak_kwh), 1) AS peak_kwh,
    ROUND(SUM(shoulder_kwh), 1) AS shoulder_kwh,
    ROUND(SUM(offpeak_kwh), 1) AS offpeak_kwh,
    ROUND(SUM(solar_export_kwh), 1) AS solar_export_kwh,
    ROUND(SUM(estimated_bill), 2) AS estimated_bill
FROM daily_load_profile
GROUP BY neighbourhood
ORDER BY grid_import_kwh DESC;
