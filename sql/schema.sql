PRAGMA foreign_keys = ON;

DROP VIEW IF EXISTS daily_load_profile;
DROP TABLE IF EXISTS meter_readings;
DROP TABLE IF EXISTS weather_daily;
DROP TABLE IF EXISTS households;
DROP TABLE IF EXISTS plans;

CREATE TABLE plans (
    plan_id INTEGER PRIMARY KEY,
    plan_name TEXT NOT NULL UNIQUE,
    daily_supply_charge REAL NOT NULL CHECK (daily_supply_charge >= 0),
    peak_rate REAL NOT NULL CHECK (peak_rate >= 0),
    shoulder_rate REAL NOT NULL CHECK (shoulder_rate >= 0),
    offpeak_rate REAL NOT NULL CHECK (offpeak_rate >= 0)
);

CREATE TABLE households (
    household_id INTEGER PRIMARY KEY,
    neighbourhood TEXT NOT NULL,
    home_type TEXT NOT NULL CHECK (home_type IN ('apartment', 'townhouse', 'detached')),
    residents INTEGER NOT NULL CHECK (residents > 0),
    solar_kw REAL NOT NULL DEFAULT 0 CHECK (solar_kw >= 0),
    plan_id INTEGER NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
);

CREATE TABLE weather_daily (
    day TEXT PRIMARY KEY,
    season TEXT NOT NULL CHECK (season IN ('summer', 'autumn', 'winter', 'spring')),
    avg_temp_c REAL NOT NULL,
    max_temp_c REAL NOT NULL,
    cooling_degree_days REAL NOT NULL,
    heating_degree_days REAL NOT NULL
);

CREATE TABLE meter_readings (
    reading_id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    peak_kwh REAL NOT NULL CHECK (peak_kwh >= 0),
    shoulder_kwh REAL NOT NULL CHECK (shoulder_kwh >= 0),
    offpeak_kwh REAL NOT NULL CHECK (offpeak_kwh >= 0),
    solar_export_kwh REAL NOT NULL CHECK (solar_export_kwh >= 0),
    grid_import_kwh REAL NOT NULL CHECK (grid_import_kwh >= 0),
    estimated_bill REAL NOT NULL,
    UNIQUE (household_id, day),
    FOREIGN KEY (household_id) REFERENCES households(household_id),
    FOREIGN KEY (day) REFERENCES weather_daily(day)
);

CREATE VIEW daily_load_profile AS
SELECT
    m.day,
    w.season,
    h.neighbourhood,
    h.home_type,
    p.plan_name,
    SUM(m.peak_kwh) AS peak_kwh,
    SUM(m.shoulder_kwh) AS shoulder_kwh,
    SUM(m.offpeak_kwh) AS offpeak_kwh,
    SUM(m.solar_export_kwh) AS solar_export_kwh,
    SUM(m.grid_import_kwh) AS grid_import_kwh,
    SUM(m.estimated_bill) AS estimated_bill
FROM meter_readings AS m
JOIN households AS h ON h.household_id = m.household_id
JOIN plans AS p ON p.plan_id = h.plan_id
JOIN weather_daily AS w ON w.day = m.day
GROUP BY
    m.day,
    w.season,
    h.neighbourhood,
    h.home_type,
    p.plan_name;
