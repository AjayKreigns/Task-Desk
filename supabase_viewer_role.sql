-- =============================================================
-- VIEWER ROLE — a read-only admin
-- Paste this whole script into the Supabase SQL Editor and run it. Run AFTER
-- supabase_rls_policies.sql (needs current_employee_id()/is_admin() to exist)
-- and supabase_leads_admin_only_writes.sql (needs the leads policies this
-- script relies on but does not change).
--
-- THE RULE
--   A 'viewer' employee sees exactly what an admin sees — every employee's
--   tasks, the full Team & Websites page, every Lead Center enquiry — but can
--   create, edit, or delete nothing. Two narrow exceptions, both matching
--   what a plain 'member' can already do today and were an explicit decision,
--   not an oversight: a viewer may still update a lead's conversion status
--   (converted/converted_reason — the leads table's existing
--   leads_update_authenticated policy already allows this for anyone linked,
--   unchanged by this script), and may still use "My Day" normally (a purely
--   personal, client-side feature that writes nothing shared).
--
-- WHY tasks NEEDS ITS OWN GUARD, NOT JUST "is_viewer() blocks everything"
-- The existing member write policies key off `assigned_to =
-- current_employee_id()` — "you may write a task that's yours". A viewer who
-- was previously a member (or who the database otherwise has pending/assigned
-- tasks for, from before being switched to viewer) would still satisfy that
-- ownership check even though they must not be allowed to write ANYTHING.
-- Every tasks write policy below is updated to explicitly exclude is_viewer(),
-- not just rely on is_admin() being false.
--
-- WHY employees/websites NEED NO CHANGES
-- Their INSERT/UPDATE/DELETE policies are already is_admin()-only — a viewer
-- is already correctly excluded with zero edits. Their SELECT policy only
-- requires a linked identity, already true for a viewer.
--
-- This script REFUSES TO COMMIT if its own built-in self-test fails — same
-- convention as every other migration in this repo. The self-test is fully
-- self-contained: it fabricates its own throwaway employee/task/lead rows and
-- impersonates them via a faked JWT claim (current_employee_id() only ever
-- joins against the employees table, never auth.users, so no real Supabase
-- Auth account is needed to exercise this), then deletes everything it
-- planted. Nothing here persists past this script.
--
-- Re-runnable: every statement drops-then-creates, so running this twice is
-- safe and changes nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. Add 'viewer' to the role vocabulary ----------------------
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('admin', 'member', 'viewer'));

-- ---------- 2. is_viewer() helper, same shape as is_admin() --------------
CREATE OR REPLACE FUNCTION is_viewer()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT e.role = 'viewer' FROM employees e WHERE e.id = current_employee_id()),
    false);
$$;

REVOKE ALL ON FUNCTION is_viewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_viewer() TO authenticated;

-- ---------- 3. tasks: full read, zero write for a viewer -----------------
DROP POLICY IF EXISTS tasks_select_own_or_admin ON tasks;
CREATE POLICY tasks_select_own_or_admin ON tasks
  FOR SELECT TO authenticated
  USING (
    (select is_admin())
    OR (select is_viewer())
    OR assigned_to = (select current_employee_id())
  );

DROP POLICY IF EXISTS tasks_insert_own_or_admin ON tasks;
CREATE POLICY tasks_insert_own_or_admin ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select is_admin())
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

DROP POLICY IF EXISTS tasks_update_own_or_admin ON tasks;
CREATE POLICY tasks_update_own_or_admin ON tasks
  FOR UPDATE TO authenticated
  USING (
    (select is_admin())
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  )
  WITH CHECK (
    (select is_admin())
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

DROP POLICY IF EXISTS tasks_delete_own_or_admin ON tasks;
CREATE POLICY tasks_delete_own_or_admin ON tasks
  FOR DELETE TO authenticated
  USING (
    (select is_admin())
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

-- ---------- 4. employees / websites / leads: no changes ------------------
-- employees_insert_admin / employees_update_admin / employees_delete_admin
-- (supabase_rls_policies.sql) and websites_insert_admin / websites_update_admin
-- / websites_delete_admin are already is_admin()-only — a viewer is already
-- excluded. leads_update_authenticated (supabase_leads_admin_only_writes.sql)
-- stays open to any linked employee, including a viewer, by explicit decision
-- — conversion-status triage is treated as routine team work, not an admin
-- write. leads_insert_admin / leads_delete_admin are already is_admin()-only.

COMMIT;

-- ---------- Self-test, as its own transaction so a failure here can
-- ---------- cleanly roll back everything it planted ----------------------
BEGIN;
DO $$
DECLARE
  v_viewer_user_id  CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  v_viewer_emp_id   CONSTANT UUID := '00000000-0000-4000-8000-000000000002';
  v_other_emp_id    CONSTANT UUID := '00000000-0000-4000-8000-000000000003';
  v_task_id         CONSTANT UUID := '00000000-0000-4000-8000-000000000004';
  v_lead_id         CONSTANT UUID := '00000000-0000-4000-8000-000000000005';
  v_count           INT;
  v_row_count       INT;
  v_is_admin        BOOLEAN;
  v_is_viewer       BOOLEAN;
  v_write_blocked   BOOLEAN;
BEGIN
  -- ---- Setup, as the privileged script-runner (table owner, bypasses RLS) ----
  -- user_id is deliberately left NULL rather than set to v_viewer_user_id:
  -- employees.user_id has a foreign key to auth.users, which would reject a
  -- fabricated UUID outright. current_employee_id()'s own fallback path —
  -- "a login created before the user_id backfill ran" — matches by email
  -- instead when user_id IS NULL, which is exactly what this exercises; no
  -- real auth.users row is needed either way.
  INSERT INTO employees (id, name, designation, email, role)
  VALUES (v_viewer_emp_id, '__viewerselftest_viewer__', 'QA', 'viewerselftest-viewer@example.invalid', 'viewer');

  INSERT INTO employees (id, name, designation, email, role)
  VALUES (v_other_emp_id, '__viewerselftest_other__', 'QA', 'viewerselftest-other@example.invalid', 'member');

  -- Deliberately assigned to someone ELSE, and a sentinel month/year no real
  -- task will ever have — proves full visibility without colliding with
  -- real data.
  INSERT INTO tasks (id, title, assigned_to, month, year, status)
  VALUES (v_task_id, '__viewerselftest_task__', v_other_emp_id, 1, 1900, 'pending');

  INSERT INTO leads (id, name, email, message, created_at)
  VALUES (v_lead_id, '__viewerselftest_lead__', 'viewerselftest-lead@example.invalid', 'self-test', now());

  -- ---- Impersonate the fake viewer for the rest of this test ----
  -- SET ROLE is a utility command, not a value-assignment GUC — it has to go
  -- through EXECUTE from inside PL/pgSQL (a plain `SET LOCAL ROLE ...;`
  -- statement is not valid directly in a function body, the same category of
  -- restriction as SAVEPOINT). request.jwt.claims, by contrast, is an
  -- ordinary custom GUC string, which set_config() sets directly and
  -- correctly.
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_viewer_user_id, 'role', 'authenticated', 'email', 'viewerselftest-viewer@example.invalid')::text,
    true);

  SELECT is_admin(), is_viewer() INTO v_is_admin, v_is_viewer;
  IF v_is_admin THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: is_admin() returned true for a viewer.';
  END IF;
  IF NOT v_is_viewer THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: is_viewer() returned false for the fake viewer.';
  END IF;

  -- Full visibility: sees a task assigned to someone else entirely.
  SELECT count(*) INTO v_count FROM tasks WHERE id = v_task_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer could not see a task assigned to another employee (expected full visibility, like an admin).';
  END IF;

  -- Zero write on tasks: INSERT.
  v_write_blocked := false;
  BEGIN
    INSERT INTO tasks (title, assigned_to, month, year) VALUES ('__viewerselftest_insert__', v_viewer_emp_id, 1, 1900);
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    v_write_blocked := true;
  END;
  IF NOT v_write_blocked THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer was able to INSERT a task, even one self-assigned.';
  END IF;

  -- Zero write on tasks: UPDATE, even the one genuinely assigned elsewhere.
  -- Unlike INSERT's WITH CHECK, a blocked UPDATE/DELETE does not raise — its
  -- USING clause just filters the row out, so this affects 0 rows SILENTLY.
  -- Asserting on ROW_COUNT, not on an exception, is the only way to actually
  -- prove this was blocked rather than just quietly not matching anything.
  UPDATE tasks SET status = 'completed' WHERE id = v_task_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer was able to UPDATE a task (% row(s) affected).', v_row_count;
  END IF;

  -- Zero write on tasks: DELETE. Same silent-filter reasoning as UPDATE above.
  DELETE FROM tasks WHERE id = v_task_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer was able to DELETE a task (% row(s) affected).', v_row_count;
  END IF;

  -- Leads: SELECT stays open (unchanged policy, sanity-checked here anyway).
  SELECT count(*) INTO v_count FROM leads WHERE id = v_lead_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer could not see leads at all.';
  END IF;

  -- Leads: conversion-status UPDATE stays ALLOWED — the one deliberate
  -- exception to "zero writes".
  UPDATE leads SET converted = 'yes' WHERE id = v_lead_id;
  SELECT count(*) INTO v_count FROM leads WHERE id = v_lead_id AND converted = 'yes';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer could not update a lead''s conversion status, which should still be allowed.';
  END IF;

  -- Leads: INSERT/DELETE stay admin-only.
  v_write_blocked := false;
  BEGIN
    INSERT INTO leads (name, email, message) VALUES ('__viewerselftest_lead_insert__', 'x@example.invalid', 'x');
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    v_write_blocked := true;
  END;
  IF NOT v_write_blocked THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer was able to INSERT a lead.';
  END IF;

  -- employees stay admin-only for writes — same silent-filter reasoning as
  -- the tasks UPDATE/DELETE above (employees_update_admin is a USING clause
  -- too, so this never raises, it just matches 0 rows).
  UPDATE employees SET designation = 'hacked' WHERE id = v_viewer_emp_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'Viewer self-test FAILED: viewer was able to UPDATE their own employees row (% row(s) affected).', v_row_count;
  END IF;

  RAISE NOTICE 'Viewer self-test passed: full read visibility confirmed, every tasks/employees/leads-insert-delete write correctly blocked, and the one deliberate exception (lead conversion-status update) correctly still works.';

  -- ---- Drop back to the privileged role to clean up --------------------
  -- RESET is the same category of utility command as SET — needs EXECUTE
  -- from inside PL/pgSQL too. The JWT claim is left as-is deliberately: it
  -- cannot affect anything below, since cleanup runs as the table owner,
  -- which bypasses RLS regardless of what auth.uid()/auth.jwt() report.
  EXECUTE 'RESET ROLE';
  DELETE FROM leads WHERE id = v_lead_id;
  DELETE FROM tasks WHERE id = v_task_id;
  DELETE FROM employees WHERE id IN (v_viewer_emp_id, v_other_emp_id);
END $$;
COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: no rows — the self-test's fixtures were cleaned up.
SELECT count(*) AS viewer_selftest_rows_remaining FROM employees WHERE name LIKE '__viewerselftest%';

-- Expect: 'viewer' now accepted alongside 'admin'/'member'.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'employees_role_check';

-- Expect: tasks SELECT policy now mentions is_viewer() too.
SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'tasks'
ORDER BY cmd, policyname;
