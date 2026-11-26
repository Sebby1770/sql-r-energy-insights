-- Unusual household-days: the same rule as get_anomalies() in
-- gridscope/analysis.py (and assets/analysis.js), so the R report, the Python
-- CLI and the browser studio flag the same days with the same scores.
-- tests/test_analysis.R checks that against the Python engine.
--
--   1. Readings are rolled up to one total per household per day.
--   2. Each day's baseline window is the same household's days within +/- 15
--      calendar days, so July is compared with July rather than the whole
--      year. A window with fewer than 7 days falls back to the household's
--      whole history.
--   3. Household with >= 4 days, window >= 7 days and window MAD > 0:
--        modified z = 0.6745 * (kWh - window median) / window MAD
--      (Iglewicz-Hoaglin), flagged at |z| >= 3.5.            method 'mad'
--   4. Otherwise, household with >= 4 days: a ratio rule against the window
--      median (high_spike at >= 1.5x, low_dip at <= 0.5x).  method 'ratio'
--   5. Otherwise the same ratio rule against the median of every
--      household-day in the file.                    baseline 'global'
--
-- Medians average the middle two values when the count is even. The median
-- and MAD are not dragged around by the spikes being hunted, unlike a mean,
-- and scoring each household against itself stops a large house reading as
-- permanently "high" next to a small one.

WITH daily AS (
    SELECT
        household_id,
        day,
        julianday(day) AS day_number,
        SUM(grid_import_kwh) AS grid_import_kwh,
        SUM(consumed_kwh) AS consumed_kwh,
        SUM(estimated_bill) AS estimated_bill,
        MIN(reading_order) AS first_reading
    FROM user_daily_profile
    GROUP BY household_id, day
),
household_sizes AS (
    SELECT household_id, COUNT(*) AS household_days
    FROM daily
    GROUP BY household_id
),
global_ranked AS (
    SELECT
        grid_import_kwh,
        ROW_NUMBER() OVER (ORDER BY grid_import_kwh) AS position,
        COUNT(*) OVER () AS observations
    FROM daily
),
global_median AS (
    SELECT COALESCE(AVG(grid_import_kwh), 0) AS median_kwh
    FROM global_ranked
    WHERE position IN ((observations + 1) / 2, (observations + 2) / 2)
),
seasonal_counts AS (
    SELECT
        a.household_id,
        a.day,
        a.day_number,
        COUNT(*) AS seasonal_days
    FROM daily AS a
    JOIN daily AS b
        ON b.household_id = a.household_id
       AND ABS(b.day_number - a.day_number) <= 15
    GROUP BY a.household_id, a.day, a.day_number
),
window_members AS (
    -- The days each household-day is compared against (itself included).
    SELECT
        s.household_id,
        s.day,
        b.grid_import_kwh AS member_kwh
    FROM seasonal_counts AS s
    JOIN daily AS b
        ON b.household_id = s.household_id
       AND (s.seasonal_days < 7 OR ABS(b.day_number - s.day_number) <= 15)
),
window_ranked AS (
    SELECT
        household_id,
        day,
        member_kwh,
        ROW_NUMBER() OVER (PARTITION BY household_id, day ORDER BY member_kwh) AS position,
        COUNT(*) OVER (PARTITION BY household_id, day) AS window_days
    FROM window_members
),
window_median AS (
    SELECT
        household_id,
        day,
        AVG(member_kwh) AS median_kwh,
        MAX(window_days) AS window_days
    FROM window_ranked
    WHERE position IN ((window_days + 1) / 2, (window_days + 2) / 2)
    GROUP BY household_id, day
),
window_deviations AS (
    SELECT
        w.household_id,
        w.day,
        ABS(w.member_kwh - m.median_kwh) AS deviation,
        ROW_NUMBER() OVER (
            PARTITION BY w.household_id, w.day
            ORDER BY ABS(w.member_kwh - m.median_kwh)
        ) AS position,
        m.window_days
    FROM window_members AS w
    JOIN window_median AS m
        ON m.household_id = w.household_id
       AND m.day = w.day
),
window_mad AS (
    SELECT
        household_id,
        day,
        AVG(deviation) AS mad_kwh
    FROM window_deviations
    WHERE position IN ((window_days + 1) / 2, (window_days + 2) / 2)
    GROUP BY household_id, day
),
baselines AS (
    SELECT
        d.day,
        r.neighbourhood,
        d.household_id,
        d.grid_import_kwh,
        d.consumed_kwh,
        d.estimated_bill,
        h.household_days,
        m.window_days,
        -- The MAD is only defined for a window of at least 7 days.
        CASE WHEN m.window_days >= 7 THEN a.mad_kwh END AS mad_kwh,
        CASE WHEN h.household_days >= 4 THEN 'household' ELSE 'global' END AS baseline,
        CASE WHEN h.household_days >= 4 THEN m.median_kwh ELSE g.median_kwh END AS baseline_kwh
    FROM daily AS d
    JOIN user_daily_profile AS r ON r.reading_order = d.first_reading
    JOIN household_sizes AS h ON h.household_id = d.household_id
    JOIN window_median AS m ON m.household_id = d.household_id AND m.day = d.day
    JOIN window_mad AS a ON a.household_id = d.household_id AND a.day = d.day
    CROSS JOIN global_median AS g
),
scored AS (
    SELECT
        *,
        CASE
            WHEN household_days >= 4 AND window_days >= 7 AND mad_kwh > 0 THEN 'mad'
            ELSE 'ratio'
        END AS method,
        CASE
            WHEN household_days >= 4 AND window_days >= 7 AND mad_kwh > 0
            THEN 0.6745 * (grid_import_kwh - baseline_kwh) / mad_kwh
        END AS modified_z
    FROM baselines
),
classified AS (
    SELECT
        *,
        CASE
            WHEN method = 'mad' AND modified_z >= 3.5 THEN 'high_spike'
            WHEN method = 'mad' AND modified_z <= -3.5 THEN 'low_dip'
            WHEN method = 'ratio' AND baseline_kwh > 0
                 AND grid_import_kwh >= baseline_kwh * 1.5 THEN 'high_spike'
            WHEN method = 'ratio' AND baseline_kwh > 0
                 AND grid_import_kwh <= baseline_kwh * 0.5 THEN 'low_dip'
        END AS anomaly_type
    FROM scored
)
SELECT
    day,
    neighbourhood,
    household_id,
    ROUND(grid_import_kwh, 3) AS grid_import_kwh,
    ROUND(consumed_kwh, 3) AS consumed_kwh,
    ROUND(estimated_bill, 2) AS estimated_bill,
    baseline,
    -- Unrounded so the scores can be compared with the Python engine; the
    -- report and output/tables/user_anomalies.csv round them for display.
    baseline_kwh,
    ROUND(CASE WHEN baseline_kwh > 0 THEN grid_import_kwh / baseline_kwh * 100 ELSE 0 END, 1)
        AS pct_of_average,
    method,
    modified_z,
    anomaly_type
FROM classified
WHERE anomaly_type IS NOT NULL
ORDER BY ABS(grid_import_kwh - baseline_kwh) DESC, day, household_id;
