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
    ROUND(100.0 * SUM(peak_kwh) / NULLIF(SUM(consumed_kwh), 0), 1) AS peak_share_pct,
    -- 'estimated' means the peak/shoulder/offpeak split was modelled from a
    -- single total column, so peak_share_pct is an assumption, not a reading.
    MIN(tier_source) AS tier_source,
    -- Readings that are negative, or where the tiers do not add up to the
    -- stated grid import plus solar export, are worth surfacing rather than
    -- silently aggregating.
    SUM(CASE WHEN grid_import_kwh < 0 OR consumed_kwh < 0 OR solar_export_kwh < 0 THEN 1 ELSE 0 END) AS negative_rows
FROM user_daily_profile;
