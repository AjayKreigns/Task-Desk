-- =============================================================
-- LEAD CENTER — conversion tracking
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Safe to run more than once. Run AFTER supabase_leads_table.sql.
--
-- Adds a "did this enquiry turn into a project" status, separate from the
-- imported "confirm" field (that one is the website contact form's own
-- submission-intent checkbox, always "Yes, this is a project enquiry" on
-- every imported row — not useful as a per-lead status to track). This is a
-- new, independently-editable field: defaults to unset (not "Yes"), and a
-- reason is expected whenever it's set to "No".
-- =============================================================
BEGIN;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_converted_check;
ALTER TABLE leads ADD CONSTRAINT leads_converted_check CHECK (converted IN ('', 'yes', 'no'));

-- Everyone who can already read/add/delete leads can also update the
-- conversion status — same "shared team resource" reasoning as the other
-- three policies in supabase_leads_table.sql.
GRANT UPDATE ON leads TO authenticated;

DROP POLICY IF EXISTS leads_update_authenticated ON leads;
CREATE POLICY leads_update_authenticated ON leads
  FOR UPDATE TO authenticated
  USING ((select current_employee_id()) IS NOT NULL)
  WITH CHECK ((select current_employee_id()) IS NOT NULL);

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: 4 rows now (select/insert/update/delete).
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'leads'
ORDER BY cmd;
