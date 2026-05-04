PRAGMA foreign_keys = ON;

INSERT INTO plans (plan_id, plan_name, daily_supply_charge, peak_rate, shoulder_rate, offpeak_rate) VALUES
    (1, 'Flex Saver', 1.05, 0.42, 0.29, 0.19),
    (2, 'Solar Plus', 1.20, 0.39, 0.27, 0.17),
    (3, 'Flat Comfort', 1.00, 0.34, 0.34, 0.34);

INSERT INTO households (household_id, neighbourhood, home_type, residents, solar_kw, plan_id) VALUES
    (1, 'Northbank', 'apartment', 1, 0.0, 1),
    (2, 'Northbank', 'apartment', 2, 0.0, 3),
    (3, 'Northbank', 'townhouse', 3, 3.5, 2),
    (4, 'Northbank', 'detached', 4, 5.8, 2),
    (5, 'East Park', 'apartment', 2, 0.0, 1),
    (6, 'East Park', 'townhouse', 2, 2.2, 2),
    (7, 'East Park', 'detached', 5, 6.4, 2),
    (8, 'East Park', 'detached', 3, 4.0, 3),
    (9, 'Harbourview', 'apartment', 1, 0.0, 3),
    (10, 'Harbourview', 'townhouse', 4, 1.8, 1),
    (11, 'Harbourview', 'detached', 4, 5.0, 2),
    (12, 'Harbourview', 'detached', 6, 7.2, 2),
    (13, 'Westfield', 'apartment', 2, 0.0, 1),
    (14, 'Westfield', 'townhouse', 3, 2.5, 3),
    (15, 'Westfield', 'detached', 4, 4.8, 2),
    (16, 'Westfield', 'detached', 5, 6.0, 2);

WITH RECURSIVE date_range(day) AS (
    SELECT date('2025-01-01')
    UNION ALL
    SELECT date(day, '+1 day')
    FROM date_range
    WHERE day < date('2025-12-31')
),
date_features AS (
    SELECT
        day,
        CAST(strftime('%m', day) AS INTEGER) AS month_number,
        CAST(julianday(day) - julianday('2025-01-01') AS INTEGER) AS day_index
    FROM date_range
),
weather_calc AS (
    SELECT
        day,
        CASE
            WHEN month_number IN (12, 1, 2) THEN 'summer'
            WHEN month_number IN (3, 4, 5) THEN 'autumn'
            WHEN month_number IN (6, 7, 8) THEN 'winter'
            ELSE 'spring'
        END AS season,
        ROUND(
            CASE
                WHEN month_number IN (12, 1, 2) THEN 25.8
                WHEN month_number IN (3, 4, 5) THEN 18.2
                WHEN month_number IN (6, 7, 8) THEN 10.6
                ELSE 19.4
            END + (((day_index * 17) % 13) - 6) * 0.28,
            1
        ) AS avg_temp_c,
        day_index
    FROM date_features
)
INSERT INTO weather_daily (
    day,
    season,
    avg_temp_c,
    max_temp_c,
    cooling_degree_days,
    heating_degree_days
)
SELECT
    day,
    season,
    avg_temp_c,
    ROUND(avg_temp_c + 5.2 + ((day_index * 7) % 6) * 0.4, 1) AS max_temp_c,
    ROUND(MAX(0, avg_temp_c - 24), 1) AS cooling_degree_days,
    ROUND(MAX(0, 18 - avg_temp_c), 1) AS heating_degree_days
FROM weather_calc;

WITH daily_inputs AS (
    SELECT
        day,
        season,
        cooling_degree_days,
        heating_degree_days,
        CAST(julianday(day) - julianday('2025-01-01') AS INTEGER) AS day_index,
        CAST(strftime('%w', day) AS INTEGER) AS day_of_week
    FROM weather_daily
),
usage_inputs AS (
    SELECT
        h.household_id,
        h.home_type,
        h.residents,
        h.solar_kw,
        p.daily_supply_charge,
        p.peak_rate,
        p.shoulder_rate,
        p.offpeak_rate,
        d.day,
        d.season,
        d.cooling_degree_days,
        d.heating_degree_days,
        CASE h.home_type
            WHEN 'apartment' THEN 0.72
            WHEN 'townhouse' THEN 1.00
            ELSE 1.28
        END AS home_factor,
        CASE
            WHEN d.day_of_week IN (0, 6) THEN 1.09
            ELSE 1.00
        END AS occupancy_factor,
        (((h.household_id * 11 + d.day_index * 7) % 10) - 4) * 0.05 AS day_variation
    FROM households AS h
    CROSS JOIN daily_inputs AS d
    JOIN plans AS p ON p.plan_id = h.plan_id
),
usage_calc AS (
    SELECT
        household_id,
        day,
        daily_supply_charge,
        peak_rate,
        shoulder_rate,
        offpeak_rate,
        ROUND(MAX(
            1.20,
            (
                residents * 0.68
                + home_factor * 1.65
                + cooling_degree_days * 0.42
                + heating_degree_days * 0.16
            ) * occupancy_factor + day_variation
        ), 2) AS peak_kwh,
        ROUND(MAX(
            1.00,
            (
                residents * 0.82
                + home_factor * 1.22
                + cooling_degree_days * 0.22
                + heating_degree_days * 0.28
            ) * occupancy_factor + day_variation
        ), 2) AS shoulder_kwh,
        ROUND(MAX(
            0.85,
            (
                residents * 0.55
                + home_factor * 0.95
                + heating_degree_days * 0.20
            ) * occupancy_factor + day_variation
        ), 2) AS offpeak_kwh,
        ROUND(MAX(
            0,
            solar_kw
            * CASE season
                WHEN 'summer' THEN 3.15
                WHEN 'spring' THEN 2.62
                WHEN 'autumn' THEN 2.18
                ELSE 1.35
            END
            - residents * 0.48
            + day_variation
        ), 2) AS solar_export_kwh
    FROM usage_inputs
)
INSERT INTO meter_readings (
    household_id,
    day,
    peak_kwh,
    shoulder_kwh,
    offpeak_kwh,
    solar_export_kwh,
    grid_import_kwh,
    estimated_bill
)
SELECT
    household_id,
    day,
    peak_kwh,
    shoulder_kwh,
    offpeak_kwh,
    solar_export_kwh,
    ROUND(MAX(0.50, peak_kwh + shoulder_kwh + offpeak_kwh - solar_export_kwh * 0.42), 2) AS grid_import_kwh,
    ROUND(
        daily_supply_charge
        + peak_kwh * peak_rate
        + shoulder_kwh * shoulder_rate
        + offpeak_kwh * offpeak_rate
        - solar_export_kwh * 0.06,
        2
    ) AS estimated_bill
FROM usage_calc;
