-- =============================================================
-- LEAD CENTER — website enquiries table
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Safe to run more than once.
--
-- Shared team resource, not personal data: unlike tasks, every linked
-- employee (member or admin) can read, add and delete every row here — there
-- is no ownership split, matching the app-side request that this be visible
-- and fully usable by all roles.
--
-- Duplicate prevention: SUPERSEDED — see supabase_leads_dedup.sql, which
-- replaces the exact-match index created below. The original rule matched on
-- every field including the exact created_at timestamp, which only held while
-- each export parsed byte-identically; since this sheet is re-uploaded weekly
-- or monthly with overlapping rows, one timezone or format change would have
-- let duplicates through silently. The replacement matches on email + message
-- + UTC calendar day instead. Run this file first, then that one.
--
-- Text columns default to '' rather than allowing NULL so blank fields
-- compare equal — NULL never equals NULL in Postgres, so a nullable column
-- would let the same "blank company" row duplicate indefinitely.
-- =============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  confirm TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dedup rule, enforced where it actually matters — at the database, not
-- just in the app's own pre-check.
CREATE UNIQUE INDEX IF NOT EXISTS leads_exact_duplicate_idx
  ON leads (name, company, email, phone, message, confirm, source_url, created_at);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
-- Never FORCE ROW LEVEL SECURITY — see the note on current_employee_id() in
-- supabase_rls_policies.sql; it would re-arm the infinite-recursion trap that
-- function's SECURITY DEFINER is specifically designed to avoid.

REVOKE ALL ON leads FROM anon;
GRANT SELECT, INSERT, DELETE ON leads TO authenticated;

DROP POLICY IF EXISTS leads_select_authenticated ON leads;
CREATE POLICY leads_select_authenticated ON leads
  FOR SELECT TO authenticated
  USING ((select current_employee_id()) IS NOT NULL);

DROP POLICY IF EXISTS leads_insert_authenticated ON leads;
CREATE POLICY leads_insert_authenticated ON leads
  FOR INSERT TO authenticated
  WITH CHECK ((select current_employee_id()) IS NOT NULL);

DROP POLICY IF EXISTS leads_delete_authenticated ON leads;
CREATE POLICY leads_delete_authenticated ON leads
  FOR DELETE TO authenticated
  USING ((select current_employee_id()) IS NOT NULL);

-- No UPDATE policy — the feature only ever adds or deletes, never edits.

ALTER PUBLICATION supabase_realtime ADD TABLE leads;

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: 3 rows (select/insert/delete only, no update).
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'leads'
ORDER BY cmd;

-- Expect: relforcerowsecurity = false.
SELECT relforcerowsecurity FROM pg_class WHERE relname = 'leads';
