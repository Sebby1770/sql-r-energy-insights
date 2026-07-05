WITH totals AS (
    SELECT
        SUM(peak_kwh) AS peak_kwh,
        SUM(shoulder_kwh) AS shoulder_kwh,
        SUM(offpeak_kwh) AS offpeak_kwh,
        SUM(solar_export_kwh) AS solar_export_kwh,
        SUM(grid_import_kwh) AS grid_import_kwh,
        SUM(consumed_kwh) AS consumed_kwh,
        SUM(estimated_bill) AS estimated_bill,
        COUNT(DISTINCT day) AS days
    FROM user_daily_profile
),
rates AS (
    SELECT
        peak_kwh,
        shoulder_kwh,
        offpeak_kwh,
        solar_export_kwh,
        grid_import_kwh,
        consumed_kwh,
        estimated_bill,
        days,
        100.0 * peak_kwh / NULLIF(consumed_kwh, 0) AS peak_share_pct,
        100.0 * solar_export_kwh / NULLIF(consumed_kwh, 0) AS solar_export_pct,
        estimated_bill / NULLIF(days, 0) AS avg_daily_bill
    FROM totals
)
SELECT
    opportunity,
    detail,
    potential_impact
FROM (
    SELECT
        'Shift peak usage' AS opportunity,
        printf('Peak is %.1f%% of consumption. Moving 10%% of peak into off-peak could reduce demand charges.', peak_share_pct) AS detail,
        CASE
            WHEN peak_share_pct >= 45 THEN 'high'
            WHEN peak_share_pct >= 35 THEN 'medium'
            ELSE 'low'
        END AS potential_impact,
        1 AS sort_order
    FROM rates
    WHERE peak_share_pct >= 35

    UNION ALL

    SELECT
        'Increase solar self-consumption' AS opportunity,
        printf('Solar exports are %.1f%% of consumption. Battery or load shifting could capture more value.', solar_export_pct) AS detail,
        CASE
            WHEN solar_export_pct >= 20 THEN 'high'
            WHEN solar_export_pct >= 10 THEN 'medium'
            ELSE 'low'
        END AS potential_impact,
        2 AS sort_order
    FROM rates
    WHERE solar_export_pct >= 10

    UNION ALL

    SELECT
        'Review estimated spend' AS opportunity,
        printf('Average daily bill is $%.2f across %d days.', avg_daily_bill, days) AS detail,
        CASE
            WHEN avg_daily_bill >= 8 THEN 'high'
            WHEN avg_daily_bill >= 5 THEN 'medium'
            ELSE 'low'
        END AS potential_impact,
        3 AS sort_order
    FROM rates
    WHERE estimated_bill IS NOT NULL AND days > 0
)
ORDER BY sort_order;