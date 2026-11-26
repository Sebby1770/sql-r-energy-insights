DROP VIEW IF EXISTS user_daily_profile;
DROP TABLE IF EXISTS user_readings;

-- Column order matters: sqlite's .import maps CSV columns by position, so it
-- must match the frame written by normalise_user_csv() in R/run_analysis.R.
CREATE TABLE user_readings (
    day TEXT NOT NULL,
    household_id TEXT,
    neighbourhood TEXT,
    peak_kwh REAL NOT NULL DEFAULT 0,
    shoulder_kwh REAL NOT NULL DEFAULT 0,
    offpeak_kwh REAL NOT NULL DEFAULT 0,
    solar_export_kwh REAL NOT NULL DEFAULT 0,
    grid_import_kwh REAL NOT NULL DEFAULT 0,
    estimated_bill REAL,
    -- 'measured' when the file supplied peak/shoulder/offpeak columns,
    -- 'estimated' when they were modelled from a single total. Anything
    -- derived from the tier split is an assumption in the second case.
    tier_source TEXT NOT NULL DEFAULT 'measured'
);

CREATE INDEX idx_user_readings_household_day ON user_readings (household_id, day);

CREATE VIEW user_daily_profile AS
SELECT
    -- File order, so per-day roll-ups can take the first reading's labels the
    -- way the Python engine does.
    rowid AS reading_order,
    day,
    COALESCE(NULLIF(neighbourhood, ''), 'Ungrouped') AS neighbourhood,
    COALESCE(NULLIF(household_id, ''), 'Unknown') AS household_id,
    peak_kwh,
    shoulder_kwh,
    offpeak_kwh,
    solar_export_kwh,
    grid_import_kwh,
    peak_kwh + shoulder_kwh + offpeak_kwh AS consumed_kwh,
    estimated_bill,
    tier_source
FROM user_readings;
