-- =============================================================
-- LEAD CENTER — robust duplicate prevention (replaces the original rule)
-- Paste this whole script into the Supabase SQL Editor and run it.
-- Safe to run more than once. Run AFTER supabase_leads_table.sql.
--
-- WHY THIS REPLACES THE ORIGINAL RULE
-- The first version matched duplicates on all eight fields INCLUDING the
-- exact created_at timestamp. That only works while every export parses
-- byte-identically forever — one timezone shift, Excel version change or
-- export tweak and duplicates pour in silently. Since this spreadsheet is
-- re-uploaded weekly/monthly with overlapping rows, that was the wrong
-- foundation.
--
-- The new rule: same EMAIL + same MESSAGE + same CALENDAR DAY (UTC).
-- Stable across all of the above, while still letting the same person send a
-- genuinely new enquiry on a later day.
--
-- Email is lower-cased and message whitespace is collapsed before matching,
-- so trivial formatting differences between exports don't slip a duplicate
-- through. Rows with no email AND no message get a NULL key — Postgres lets
-- NULLs repeat in a unique index, so a bare manual entry is never treated as
-- a duplicate of another.
--
-- WHY A TRIGGER AND NOT A GENERATED COLUMN
-- The obvious shape for dedup_key is `GENERATED ALWAYS AS (...) STORED`, but
-- Postgres rejects that here with "42P17: generation expression is not
-- immutable". Getting a UTC calendar day out of a timestamptz needs
-- `AT TIME ZONE 'UTC'`, which resolves to the timezone() function — marked
-- STABLE, not IMMUTABLE, because timezone definitions can change between
-- releases. Generated columns only accept strictly immutable expressions.
-- A BEFORE trigger has no such restriction, so the key is maintained there
-- instead. The unique index below is identical either way, so duplicate
-- prevention is just as strict.
--
-- This script REFUSES TO COMMIT if its own built-in test fails (see Step 6),
-- so a partial migration is never left behind.
-- =============================================================

-- ---------- Step 1: the key builder, used by both the trigger and backfill --
-- One definition, so the stored key and the backfill can never disagree.
-- Mirrors leadDedupKey() in src/lib/leadDedup.js exactly.
CREATE OR REPLACE FUNCTION leads_build_dedup_key(
  p_email TEXT,
  p_message TEXT,
  p_created_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_email, '')) = ''
     AND btrim(coalesce(p_message, '')) = ''
    THEN NULL
    ELSE lower(btrim(coalesce(p_email, '')))
      || '|' || regexp_replace(btrim(coalesce(p_message, '')), '\s+', ' ', 'g')
      || '|' || to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  END
$$;

-- ---------- Step 2: see what the NEW rule considers duplicates -------------
-- Run this and eyeball it BEFORE running Step 3 onwards. These are rows
-- already in the table that the new rule would collapse together; Step 5
-- keeps the OLDEST of each group and deletes the rest.
-- (If Lead Center is currently empty this returns 0 rows, which is fine.)
SELECT
  lower(btrim(email))                     AS email,
  left(regexp_replace(btrim(message), '\s+', ' ', 'g'), 60) AS message_start,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')      AS utc_day,
  count(*)                                AS copies
FROM leads
WHERE leads_build_dedup_key(email, message, created_at) IS NOT NULL
GROUP BY 1, regexp_replace(btrim(message), '\s+', ' ', 'g'), 3
HAVING count(*) > 1
ORDER BY copies DESC, email;

-- ---------- Steps 3-6: the migration itself --------------------------------
BEGIN;

-- Step 3: retire the old, fragile exact-match index.
DROP INDEX IF EXISTS leads_exact_duplicate_idx;

-- Step 4: the key column, plus the trigger that keeps it current.
ALTER TABLE leads DROP COLUMN IF EXISTS dedup_key;
ALTER TABLE leads ADD COLUMN dedup_key TEXT;

CREATE OR REPLACE FUNCTION leads_sync_dedup_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.dedup_key := leads_build_dedup_key(NEW.email, NEW.message, NEW.created_at);
  RETURN NEW;
END;
$$;

-- BEFORE, so the value is in place before the unique index is checked —
-- which is what lets INSERT ... ON CONFLICT (dedup_key) work from the app.
DROP TRIGGER IF EXISTS leads_dedup_key_trg ON leads;
CREATE TRIGGER leads_dedup_key_trg
  BEFORE INSERT OR UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_sync_dedup_key();

-- Backfill anything already in the table.
UPDATE leads SET dedup_key = leads_build_dedup_key(email, message, created_at);

-- Step 5: collapse any pre-existing duplicates, keeping the oldest row of
-- each group. Without this the unique index below cannot be created.
DELETE FROM leads a
USING leads b
WHERE a.dedup_key IS NOT NULL
  AND a.dedup_key = b.dedup_key
  AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));

-- Step 6: the real enforcement. Unlike a check in the app, this holds even if
-- two people import the same file at the same moment.
DROP INDEX IF EXISTS leads_dedup_idx;
CREATE UNIQUE INDEX leads_dedup_idx ON leads (dedup_key);

-- Step 7: prove it actually works before committing. Inserts the same
-- enquiry twice — different time of day, different email case, extra spaces —
-- and the second must be silently skipped. Also proves ON CONFLICT
-- (dedup_key) resolves against the trigger-populated value, which is what
-- the app's import relies on. If any of that is wrong this raises and the
-- whole script rolls back, changing nothing.
DO $$
DECLARE
  v_count INT;
  v_key   TEXT;
BEGIN
  INSERT INTO leads (name, email, message, created_at)
    VALUES ('__dedup_selftest__', 'selftest@example.invalid', 'self test message', '2001-01-01T09:00:00Z');

  SELECT dedup_key INTO v_key FROM leads WHERE name = '__dedup_selftest__';
  IF v_key IS DISTINCT FROM 'selftest@example.invalid|self test message|2001-01-01' THEN
    RAISE EXCEPTION 'Dedup self-test FAILED: key was %, expected selftest@example.invalid|self test message|2001-01-01. Rolling back.', v_key;
  END IF;

  INSERT INTO leads (name, email, message, created_at)
    VALUES ('__dedup_selftest__', 'SELFTEST@example.invalid', 'self  test   message', '2001-01-01T21:45:00Z')
    ON CONFLICT (dedup_key) DO NOTHING;

  SELECT count(*) INTO v_count FROM leads WHERE name = '__dedup_selftest__';
  DELETE FROM leads WHERE name = '__dedup_selftest__';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Dedup self-test FAILED: expected 1 row after inserting the same enquiry twice, got %. Rolling back — nothing was changed.', v_count;
  END IF;

  RAISE NOTICE 'Dedup self-test passed: duplicate correctly skipped (different time of day, different email case, extra spaces).';
END $$;

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: leads_dedup_idx present, leads_exact_duplicate_idx gone.
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'leads'
ORDER BY indexname;

-- Expect: 0 — no duplicates remain under the new rule.
SELECT count(*) AS duplicate_groups_remaining FROM (
  SELECT dedup_key FROM leads WHERE dedup_key IS NOT NULL
  GROUP BY dedup_key HAVING count(*) > 1
) dupes;
