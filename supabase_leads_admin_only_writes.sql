-- =============================================================
-- LEAD CENTER — who can do what
-- Paste this whole script into the Supabase SQL Editor and run it.
-- Safe to run more than once. Run AFTER supabase_leads_table.sql,
-- supabase_leads_conversion_tracking.sql and supabase_leads_dedup.sql.
--
-- THE RULE
--   Everyone with a linked employee record  : read every enquiry, and set its
--                                             conversion status (Converted /
--                                             Not Converted + reason)
--   Admins only                             : import, add, delete
--
-- WHY THIS EXISTS EVEN THOUGH THE APP HIDES THE BUTTONS
-- Hidden buttons are presentation only. The anon key is public and compiled
-- into the deployed site, so a signed-in member could otherwise call the REST
-- API straight from the browser console and delete the whole lead table.
-- These policies are the part that actually prevents it.
--
-- THE COLUMN-LEVEL GRANT IS THE IMPORTANT BIT
-- "Members may set the status" must not become "members may rewrite anything".
-- An RLS policy filters which ROWS a statement may touch, not which COLUMNS —
-- so a plain `GRANT UPDATE ON leads` would let a member change a contact's
-- name, email, message or date via the API. Granting UPDATE on just the two
-- status columns is what constrains it, and Postgres enforces that per-column
-- privilege independently of the row policy.
--
-- Export is not represented here: exporting is only reading, so the database
-- cannot tell it apart from viewing. That restriction lives in the app (the
-- button is admin-only) and is a workflow guardrail, not a security boundary.
-- =============================================================
BEGIN;

-- ---------- Table privileges ----------------------------------------------
-- Reset UPDATE first: a previously granted table-wide UPDATE would otherwise
-- sit alongside the narrow column grant and keep every column writable.
REVOKE UPDATE ON leads FROM authenticated;
GRANT SELECT, INSERT, DELETE ON leads TO authenticated;
GRANT UPDATE (converted, converted_reason) ON leads TO authenticated;

-- ---------- Row policies ---------------------------------------------------
-- SELECT: any linked employee. This is the read access members keep.
DROP POLICY IF EXISTS leads_select_authenticated ON leads;
CREATE POLICY leads_select_authenticated ON leads
  FOR SELECT TO authenticated
  USING ((select current_employee_id()) IS NOT NULL);

-- UPDATE: any linked employee, but only ever the two columns granted above.
-- The old *_admin version is dropped explicitly — Postgres ORs policies for
-- the same command, so leaving a stale one behind silently widens access.
DROP POLICY IF EXISTS leads_update_authenticated ON leads;
DROP POLICY IF EXISTS leads_update_admin ON leads;
CREATE POLICY leads_update_authenticated ON leads
  FOR UPDATE TO authenticated
  USING ((select current_employee_id()) IS NOT NULL)
  WITH CHECK ((select current_employee_id()) IS NOT NULL);

-- INSERT / DELETE: admins only.
DROP POLICY IF EXISTS leads_insert_authenticated ON leads;
DROP POLICY IF EXISTS leads_insert_admin ON leads;
CREATE POLICY leads_insert_admin ON leads
  FOR INSERT TO authenticated
  WITH CHECK ((select is_admin()));

DROP POLICY IF EXISTS leads_delete_authenticated ON leads;
DROP POLICY IF EXISTS leads_delete_admin ON leads;
CREATE POLICY leads_delete_admin ON leads
  FOR DELETE TO authenticated
  USING ((select is_admin()));

-- ---------- Keep the dedup trigger out of the way -------------------------
-- leads_sync_dedup_key was BEFORE INSERT OR UPDATE, i.e. it fired on a
-- status-only update too and reassigned NEW.dedup_key — a column members are
-- deliberately not granted. Restricting it to the three columns the key is
-- actually derived from means a status update never touches dedup_key at all,
-- so the narrow grant above cannot collide with the trigger. It still fires
-- whenever any of those three columns appears in a statement, so the key can
-- never go stale.
DROP TRIGGER IF EXISTS leads_dedup_key_trg ON leads;
CREATE TRIGGER leads_dedup_key_trg
  BEFORE INSERT OR UPDATE OF email, message, created_at ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_sync_dedup_key();

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect exactly 4 rows:
--   DELETE  leads_delete_admin
--   INSERT  leads_insert_admin
--   SELECT  leads_select_authenticated
--   UPDATE  leads_update_authenticated
SELECT cmd, policyname FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'leads'
ORDER BY cmd, policyname;

-- Expect exactly two UPDATE rows — converted and converted_reason — and
-- nothing else. If other column names appear here, a table-wide UPDATE grant
-- is still in force and members could rewrite contact details.
SELECT column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'leads'
  AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
ORDER BY column_name;
