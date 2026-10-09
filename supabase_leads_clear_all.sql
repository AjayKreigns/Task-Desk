-- =============================================================
-- LEAD CENTER — delete every enquiry (fresh start)
-- Paste into the Supabase SQL Editor. Run Step 1 first, then Step 2.
--
-- THIS PERMANENTLY DELETES ALL ROWS IN THE leads TABLE. There is no undo.
-- The table, its columns, policies and indexes are all left intact — only the
-- data goes, so Lead Center keeps working and you can re-import straight
-- away.
--
-- Why you'd run this: the first 135 rows went in with corrupted dates (every
-- one reading 1970-01-01). Clearing and re-importing with the fixed importer
-- is cleaner than repairing in place, and it recovers the original
-- time-of-day too, which the repair script could not (that data was
-- destroyed before it ever reached the database).
--
-- If you run this, you do NOT need supabase_leads_fix_import_dates.sql at
-- all — there will be nothing left to repair.
-- =============================================================

-- ---------- Step 1: see what you are about to delete ----------------------
-- Sanity-check the count before removing anything.
SELECT count(*) AS rows_that_will_be_deleted FROM leads;

-- ---------- Step 2: delete it ---------------------------------------------
BEGIN;

DELETE FROM leads;

COMMIT;

-- ---------- Verify ---------------------------------------------------------
-- Expect: 0.
SELECT count(*) AS rows_remaining FROM leads;
