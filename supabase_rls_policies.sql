-- =============================================================
-- STAGE B — the flip: real database access control
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction, but ONLY after:
--   1. supabase_auth_migration.sql (Stage A) has been run — confirmed done.
--   2. At least one employee has role = 'admin' — confirmed done (Ajaykumar).
--
-- On disabling public sign-ups: this dashboard's Auth -> Email settings don't
-- expose a separate "block new signups, keep login working" toggle in the
-- version checked, so this script does NOT depend on finding one. Every
-- SELECT policy below requires current_employee_id() IS NOT NULL, meaning a
-- stranger who self-registers with the public anon key gets zero rows from
-- every table regardless — not linked to anyone, they see nothing at all, not
-- even team member names. If you do later find a way to disable public
-- sign-ups outright, it's still worth doing (an unlinked account existing at
-- all costs your Auth quota and is one more thing to audit), but it is no
-- longer required for the data itself to stay protected.
--
-- WHAT CHANGES FOR REAL USERS after this runs:
--   - A member's login can only ever read THEIR OWN tasks — not the team's.
--     This is what makes Dashboard, Monthly Report, Schedule and Tasks
--     Completed all become "your data only" for a member; no app code needed
--     to change for this, since every chart on those pages is already built
--     purely from the fetched tasks array.
--   - A member can create a task only if it's assigned to themselves, and can
--     edit only tasks assigned to themselves.
--   - Only an admin can delete anything, or add/edit/delete employees and
--     websites.
--   - Admins are unaffected — they still see and manage everything.
--
-- Re-runnable: every statement drops-then-creates, so running this twice is
-- safe and changes nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. Helper functions ---------------------------------------
-- SECURITY DEFINER is not optional here. A policy on `employees` that reads
-- `employees` to find the caller's role would raise 42P17 (infinite
-- recursion) under normal RLS — evaluating the policy requires reading
-- employees, which triggers the policy again. Running the function body as
-- its owner (who owns these tables, and table owners are exempt from RLS)
-- breaks that loop.
--
-- Both are STABLE, and every policy below calls them as `(select fn())`
-- rather than bare `fn()` — that scalar-subquery wrapping is what lets
-- Postgres evaluate the call once per statement (an InitPlan) instead of once
-- per row, which matters once `tasks` has thousands of rows.
--
-- search_path is pinned on both: a SECURITY DEFINER function with a mutable
-- search_path is a privilege-escalation vector.

CREATE OR REPLACE FUNCTION current_employee_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    -- The authoritative link, set by Stage A's trigger/backfill.
    (SELECT e.id FROM employees e WHERE e.user_id = auth.uid() LIMIT 1),
    -- Fallback for a login created before Stage A existed, or before the
    -- backfill ran for it. NULLIF(...,'') means an empty email claim can
    -- never accidentally match a blank employee row.
    (SELECT e.id FROM employees e
      WHERE e.user_id IS NULL
        AND e.email = NULLIF(lower(btrim(auth.jwt() ->> 'email')), '')
      LIMIT 1)
  );
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT e.role = 'admin' FROM employees e WHERE e.id = current_employee_id()),
    false);
$$;

REVOKE ALL ON FUNCTION current_employee_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_employee_id() TO authenticated;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

-- ---------- 2. Remove the "Allow all" policies -------------------------
DROP POLICY IF EXISTS "Allow all on employees" ON employees;
DROP POLICY IF EXISTS "Allow all on websites" ON websites;
DROP POLICY IF EXISTS "Allow all on tasks" ON tasks;

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Never run FORCE ROW LEVEL SECURITY on these three tables — it removes the
-- table-owner exemption the SECURITY DEFINER functions above depend on, and
-- re-arms the infinite-recursion problem described above.

-- ---------- 3. Belt-and-braces: strip anon's table privileges ----------
-- RLS alone already denies anon (no policy below grants that role anything),
-- but revoking the underlying GRANT means a future accidental "TO public"
-- policy still could not expose data through the anon key.
REVOKE ALL ON employees FROM anon;
REVOKE ALL ON websites FROM anon;
REVOKE ALL ON tasks FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON websites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO authenticated;

-- ---------- 4. employees -----------------------------------------------
-- Readable by anyone with a LINKED employee record — every real member and
-- admin, since that's exactly what current_employee_id() being non-null
-- means. Task rows reference assigned_to by id, and every screen needs to
-- turn that into a name, so this can't be admin-only.
--
-- Deliberately NOT bare `true`, though. This project's dashboard doesn't
-- expose a separate "disable new signups, keep login" toggle in this
-- version, so a stranger could still self-register with the public anon key
-- even after this script runs — they would never see a linked identity, but
-- with `true` here they could still read every employee's name and email.
-- Requiring current_employee_id() IS NOT NULL closes that off entirely: a
-- signed-up-but-unlinked stranger gets zero rows from every table, not just
-- tasks. If you do later find and disable public signups in the dashboard,
-- this remains correct and costs nothing extra for real users.
DROP POLICY IF EXISTS employees_select_authenticated ON employees;
CREATE POLICY employees_select_authenticated ON employees
  FOR SELECT TO authenticated USING ((select current_employee_id()) IS NOT NULL);

DROP POLICY IF EXISTS employees_insert_admin ON employees;
CREATE POLICY employees_insert_admin ON employees
  FOR INSERT TO authenticated WITH CHECK ((select is_admin()));

-- Deliberately admin-only, including a member's OWN row: email is the link
-- back to a login, so letting a member edit it would let them re-point their
-- identity at someone else's address.
DROP POLICY IF EXISTS employees_update_admin ON employees;
CREATE POLICY employees_update_admin ON employees
  FOR UPDATE TO authenticated
  USING ((select is_admin()))
  WITH CHECK ((select is_admin()));

DROP POLICY IF EXISTS employees_delete_admin ON employees;
CREATE POLICY employees_delete_admin ON employees
  FOR DELETE TO authenticated USING ((select is_admin()));

-- ---------- 5. websites (managed only from the admin Settings tab) -----
-- Same reasoning as employees above: requires a linked identity, not bare
-- `true`, so an unlinked self-registered stranger can't read this either.
DROP POLICY IF EXISTS websites_select_authenticated ON websites;
CREATE POLICY websites_select_authenticated ON websites
  FOR SELECT TO authenticated USING ((select current_employee_id()) IS NOT NULL);

DROP POLICY IF EXISTS websites_insert_admin ON websites;
CREATE POLICY websites_insert_admin ON websites
  FOR INSERT TO authenticated WITH CHECK ((select is_admin()));

DROP POLICY IF EXISTS websites_update_admin ON websites;
CREATE POLICY websites_update_admin ON websites
  FOR UPDATE TO authenticated
  USING ((select is_admin())) WITH CHECK ((select is_admin()));

DROP POLICY IF EXISTS websites_delete_admin ON websites;
CREATE POLICY websites_delete_admin ON websites
  FOR DELETE TO authenticated USING ((select is_admin()));

-- ---------- 6. tasks -----------------------------------------------------
-- SELECT is the policy that actually implements "each employee sees only
-- their own progress / scheduled / completed tasks". An admin sees
-- everything; a member's fetch only ever returns rows assigned to them.
-- Every page in the app (Dashboard, Monthly Report, Schedule, Tasks
-- Completed) is built purely from this one fetched array, so this single
-- policy is what makes all of them "your data only" for a member — no
-- client code depends on this being literally `true` any more.
DROP POLICY IF EXISTS tasks_select_authenticated ON tasks;
DROP POLICY IF EXISTS tasks_select_own_or_admin ON tasks;
CREATE POLICY tasks_select_own_or_admin ON tasks
  FOR SELECT TO authenticated
  USING ((select is_admin()) OR assigned_to = (select current_employee_id()));

-- Members may create only self-assigned tasks (carry-forward and the
-- "additional task" flow both depend on this). WITH CHECK is what blocks
-- creating work assigned to someone else.
DROP POLICY IF EXISTS tasks_insert_own_or_admin ON tasks;
CREATE POLICY tasks_insert_own_or_admin ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select is_admin())
    OR assigned_to = (select current_employee_id())
  );

-- USING = the row as it is now ("is this already my task?").
-- WITH CHECK = the row after the update ("is it still my task?").
-- Together these block both stealing someone else's task and handing your
-- own task off to someone else.
DROP POLICY IF EXISTS tasks_update_own_or_admin ON tasks;
CREATE POLICY tasks_update_own_or_admin ON tasks
  FOR UPDATE TO authenticated
  USING (
    (select is_admin())
    OR assigned_to = (select current_employee_id())
  )
  WITH CHECK (
    (select is_admin())
    OR assigned_to = (select current_employee_id())
  );

-- Delete follows the same ownership rule as UPDATE: an admin, or the task's
-- own assignee. (Originally admin-only — changed once it became clear members
-- need to be able to remove their own mis-scheduled or duplicate entries, not
-- just edit them. There's still no soft-delete or audit trail server-side, so
-- this remains the one truly irreversible action in the app.)
DROP POLICY IF EXISTS tasks_delete_admin ON tasks;
CREATE POLICY tasks_delete_own_or_admin ON tasks
  FOR DELETE TO authenticated
  USING (
    (select is_admin())
    OR assigned_to = (select current_employee_id())
  );

-- ---------- 7. REPLICA IDENTITY FULL, required now the SELECT policy on
-- tasks is no longer a bare `true` ---------------------------------------
-- Under the default replica identity, a DELETE only writes the row's primary
-- key to the WAL. Realtime evaluates a subscriber's SELECT policy against
-- that WAL data to decide who receives the event — but `assigned_to =
-- current_employee_id()` cannot be evaluated without `assigned_to`, which a
-- bare primary key does not include. Without this, a member's browser would
-- likely never receive a realtime notification that one of their own tasks
-- was deleted (only a full page reload would show it gone). employees/
-- websites do NOT need this despite also no longer being bare `true`: their
-- policy (current_employee_id() IS NOT NULL) depends only on the CALLER's own
-- identity, never on any column of the row being deleted, so there is no
-- OLD-row data it needs that a bare primary key doesn't already provide.
-- tasks is different because its policy checks assigned_to — a column on the
-- row itself, which the WAL only carries for DELETE if told to keep all of it.
ALTER TABLE tasks REPLICA IDENTITY FULL;

-- ---------- 8. Guard against losing the last admin ----------------------
CREATE OR REPLACE FUNCTION prevent_last_admin_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only fires when an admin was actually demoted or deleted, so bootstrap
  -- states (zero admins yet) are never blocked by this.
  IF OLD.role = 'admin' AND NOT EXISTS (SELECT 1 FROM employees WHERE role = 'admin') THEN
    RAISE EXCEPTION 'Refusing to remove the last admin — promote someone else first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS employees_last_admin_trg ON employees;
CREATE TRIGGER employees_last_admin_trg
  AFTER UPDATE OR DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION prevent_last_admin_removal();

COMMIT;

-- ---------- Verify, after COMMIT ----------------------------------------
-- Expect: 4 rows, exactly 1 with role = admin.
SELECT name, email, role FROM employees ORDER BY role DESC, name;

-- Expect: no policy named "Allow all on ..." remains.
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('employees', 'websites', 'tasks')
ORDER BY tablename, cmd;
