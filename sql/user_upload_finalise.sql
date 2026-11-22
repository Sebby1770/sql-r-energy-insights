-- Run after `.import` has loaded user_readings.
--
-- sqlite's CSV import stores an empty field as the empty *string*, not NULL.
-- For estimated_bill that meant COUNT(estimated_bill) counted blank cells and
-- SUM() turned "no bill supplied" into a $0.00 bill. Blank means missing.
UPDATE user_readings
SET estimated_bill = NULL
WHERE typeof(estimated_bill) = 'text' AND TRIM(estimated_bill) = '';
