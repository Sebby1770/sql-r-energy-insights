DROP VIEW IF EXISTS user_daily_profile;
DROP TABLE IF EXISTS user_readings;

CREATE TABLE user_readings (
    day TEXT NOT NULL,
    household_id TEXT,
    neighbourhood TEXT,
    peak_kwh REAL NOT NULL DEFAULT 0,
    shoulder_kwh REAL NOT NULL DEFAULT 0,
    offpeak_kwh REAL NOT NULL DEFAULT 0,
    solar_export_kwh REAL NOT NULL DEFAULT 0,
    grid_import_kwh REAL NOT NULL DEFAULT 0,
    estimated_bill REAL
);

CREATE VIEW user_daily_profile AS
SELECT
    day,
    COALESCE(NULLIF(neighbourhood, ''), 'Ungrouped') AS neighbourhood,
    COALESCE(NULLIF(household_id, ''), 'Unknown') AS household_id,
    peak_kwh,
    shoulder_kwh,
    offpeak_kwh,
    solar_export_kwh,
    grid_import_kwh,
    peak_kwh + shoulder_kwh + offpeak_kwh AS consumed_kwh,
    estimated_bill
FROM user_readings;
