-- =============================================================
-- LEAD CENTER — one-time fix for dates corrupted by the Excel-date import bug
-- Paste this whole script into the Supabase SQL Editor. Run Step 1 first and
-- check a few rows look right before running Step 2.
--
-- What happened: Excel stores a date as a plain number — days since
-- 1899-12-30. The importer read that raw number and passed it straight to
-- JavaScript's Date constructor, which treats a bare number as MILLISECONDS
-- since 1970-01-01 instead of days since 1899 — so every imported date
-- landed a few seconds after midnight on 1970-01-01 ("Jan 1, 1970"). This is
-- fixed in the app now; this script repairs the rows that already went in
-- wrong.
--
-- The corrupted timestamp's own seconds-since-1970 value, times 1000, IS the
-- original Excel serial number's whole-day count (that's literally what got
-- misinterpreted as milliseconds) — so it can be converted back using
-- Excel's real epoch (serial 25569 = 1970-01-01) instead of the wrong one.
--
-- One honest limitation: this recovers the correct CALENDAR DATE, but not
-- the original time-of-day. That part isn't a limitation of this script —
-- it was already gone before the row was ever written. JavaScript's Date
-- constructor floors a fractional input to a whole number of milliseconds,
-- so the very first (buggy) conversion silently discarded the fractional
-- part of the serial number — which is exactly where the time-of-day lived.
-- There's no way to get it back. This app never displays or filters by
-- time-of-day anywhere (only date/month/year), so in practice this changes
-- nothing you can see or rely on — every recovered row lands at 00:00 UTC on
-- the correct day.
-- =============================================================

-- ---------- Step 1: preview — check a few rows before touching anything ----
SELECT
  name,
  created_at AS wrong_date,
  to_timestamp((EXTRACT(EPOCH FROM created_at) * 1000 - 25569) * 86400) AS recovered_date
FROM leads
WHERE created_at < '2000-01-01'
ORDER BY name
LIMIT 10;

-- ---------- Step 2: once recovered_date above looks right, apply it --------
BEGIN;

UPDATE leads
SET created_at = to_timestamp((EXTRACT(EPOCH FROM created_at) * 1000 - 25569) * 86400)
WHERE created_at < '2000-01-01';

COMMIT;

-- ---------- Step 3: confirm none are left un-fixed --------------------------
-- Expect: 0.
SELECT count(*) FROM leads WHERE created_at < '2000-01-01';
