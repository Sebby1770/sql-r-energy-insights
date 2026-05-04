SELECT
    'Peak' AS load_type,
    ROUND(SUM(peak_kwh), 1) AS kwh
FROM user_daily_profile
UNION ALL
SELECT
    'Shoulder' AS load_type,
    ROUND(SUM(shoulder_kwh), 1) AS kwh
FROM user_daily_profile
UNION ALL
SELECT
    'Off-peak' AS load_type,
    ROUND(SUM(offpeak_kwh), 1) AS kwh
FROM user_daily_profile
UNION ALL
SELECT
    'Solar export' AS load_type,
    ROUND(SUM(solar_export_kwh), 1) AS kwh
FROM user_daily_profile;
