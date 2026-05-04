WITH plan_days AS (
    SELECT
        p.plan_name,
        m.household_id,
        m.day,
        m.peak_kwh,
        m.shoulder_kwh,
        m.offpeak_kwh,
        m.solar_export_kwh,
        m.estimated_bill,
        m.peak_kwh + m.shoulder_kwh + m.offpeak_kwh AS consumed_kwh
    FROM meter_readings AS m
    JOIN households AS h ON h.household_id = m.household_id
    JOIN plans AS p ON p.plan_id = h.plan_id
)
SELECT
    plan_name,
    COUNT(DISTINCT household_id) AS households,
    ROUND(AVG(estimated_bill), 2) AS avg_daily_bill,
    ROUND(SUM(estimated_bill), 2) AS annual_revenue,
    ROUND(100.0 * SUM(peak_kwh) / SUM(consumed_kwh), 1) AS peak_share_pct,
    ROUND(100.0 * SUM(solar_export_kwh) / SUM(consumed_kwh), 1) AS solar_export_share_pct
FROM plan_days
GROUP BY plan_name
ORDER BY avg_daily_bill;
