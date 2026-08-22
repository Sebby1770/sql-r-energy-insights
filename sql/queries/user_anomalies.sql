-- Unusual usage days, using a robust per-household baseline.
--
-- The previous version compared every household-day row against the mean of
-- *all* rows and flagged anything outside ±50% of it. That had two problems:
--
--   1. The mean is dragged by the very spikes it is meant to detect, so one
--      extreme day raises the bar and hides the others.
--   2. With several households in one file, a large house was permanently
--      "high" and a small one permanently "low", producing pages of anomalies
--      that were really just differences in house size.
--
-- Instead each household is compared against its own median, scaled by its own
-- median absolute deviation (MAD) — the Iglewicz-Hoaglin modified z-score,
-- flagged at |z| >= 3.5. Households with too little history, or with a MAD of
-- zero (a perfectly flat series), fall back to the old ±50%-of-median rule so
-- the query still returns something sensible for small files.

WITH daily AS (
    -- One row per household per day; a file with multiple readings for the
    -- same household-day is summed rather than compared row by row.
    SELECT
        day,
        household_id,
        MIN(neighbourhood) AS neighbourhood,
        SUM(grid_import_kwh) AS grid_import_kwh,
        SUM(consumed_kwh) AS consumed_kwh,
        SUM(estimated_bill) AS estimated_bill
    FROM user_daily_profile
    GROUP BY day, household_id
),
ranked AS (
    SELECT
        household_id,
        grid_import_kwh,
        ROW_NUMBER() OVER (PARTITION BY household_id ORDER BY grid_import_kwh) AS position,
        COUNT(*) OVER (PARTITION BY household_id) AS observations
    FROM daily
),
household_median AS (
    -- Average of the middle one (odd n) or middle two (even n) values.
    SELECT
        household_id,
        AVG(grid_import_kwh) AS median_kwh,
        MAX(observations) AS observations
    FROM ranked
    WHERE position IN ((observations + 1) / 2, (observations + 2) / 2)
    GROUP BY household_id
),
deviations AS (
    SELECT
        d.household_id,
        ABS(d.grid_import_kwh - m.median_kwh) AS deviation,
        ROW_NUMBER() OVER (
            PARTITION BY d.household_id ORDER BY ABS(d.grid_import_kwh - m.median_kwh)
        ) AS position,
        COUNT(*) OVER (PARTITION BY d.household_id) AS observations
    FROM daily AS d
    JOIN household_median AS m ON m.household_id = d.household_id
),
household_mad AS (
    SELECT
        household_id,
        AVG(deviation) AS mad
    FROM deviations
    WHERE position IN ((observations + 1) / 2, (observations + 2) / 2)
    GROUP BY household_id
),
scored AS (
    SELECT
        d.day,
        d.neighbourhood,
        d.household_id,
        d.grid_import_kwh,
        d.consumed_kwh,
        d.estimated_bill,
        m.median_kwh,
        m.observations,
        a.mad,
        -- 0.6745 rescales the MAD so the score matches a standard deviation
        -- for normally distributed data.
        CASE
            WHEN a.mad > 0 AND m.observations >= 5
            THEN 0.6745 * (d.grid_import_kwh - m.median_kwh) / a.mad
            ELSE NULL
        END AS modified_z
    FROM daily AS d
    JOIN household_median AS m ON m.household_id = d.household_id
    LEFT JOIN household_mad AS a ON a.household_id = d.household_id
)
SELECT
    day,
    neighbourhood,
    household_id,
    ROUND(grid_import_kwh, 1) AS grid_import_kwh,
    ROUND(consumed_kwh, 1) AS consumed_kwh,
    ROUND(estimated_bill, 2) AS estimated_bill,
    ROUND(median_kwh, 1) AS household_median_kwh,
    ROUND(100.0 * grid_import_kwh / NULLIF(median_kwh, 0), 1) AS pct_of_average,
    ROUND(modified_z, 2) AS modified_z,
    CASE WHEN modified_z IS NULL THEN 'ratio' ELSE 'modified_z' END AS method,
    CASE
        WHEN modified_z >= 3.5 THEN 'high_spike'
        WHEN modified_z <= -3.5 THEN 'low_dip'
        WHEN modified_z IS NULL AND grid_import_kwh >= median_kwh * 1.5 THEN 'high_spike'
        WHEN modified_z IS NULL AND grid_import_kwh <= median_kwh * 0.5 THEN 'low_dip'
        ELSE 'normal'
    END AS anomaly_type
FROM scored
WHERE (modified_z IS NOT NULL AND ABS(modified_z) >= 3.5)
   OR (
        modified_z IS NULL
        AND (grid_import_kwh >= median_kwh * 1.5 OR grid_import_kwh <= median_kwh * 0.5)
      )
ORDER BY ABS(COALESCE(modified_z, grid_import_kwh - median_kwh)) DESC, day;
