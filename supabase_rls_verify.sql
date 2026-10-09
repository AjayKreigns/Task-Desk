-- =============================================================
-- STAGE B VERIFICATION — run after supabase_rls_policies.sql
-- Impersonates each role inside BEGIN...ROLLBACK, so nothing here persists.
--
-- First, get real identities to substitute below:
SELECT e.name, e.role, e.email, e.user_id
FROM employees e WHERE e.user_id IS NOT NULL ORDER BY e.role DESC, e.name;
-- Copy one admin's user_id/email and one member's (once a member has a login)
-- into the placeholders marked <ADMIN_...> / <MEMBER_...> below.
-- =============================================================

-- ---------- A. ANONYMOUS — must see and change nothing -----------------
BEGIN;
  SET LOCAL ROLE anon;
  SET LOCAL request.jwt.claims = '{"role":"anon"}';
  -- EXPECT: permission denied for table employees (grants were revoked).
  SELECT count(*) AS anon_employees FROM employees;
  SELECT count(*) AS anon_tasks FROM tasks;
  SELECT count(*) AS anon_websites FROM websites;
  -- EXPECT: denied.
  INSERT INTO tasks (title, month, year) VALUES ('anon hack', 1, 2026);
ROLLBACK;

-- ---------- A2. AUTHENTICATED BUT UNLINKED — a self-registered stranger ---
-- This is the case that stands in for "disable public sign-ups", since this
-- dashboard doesn't expose that toggle separately from login itself. Use any
-- made-up UUID/email here — the point is that NOTHING in employees links to
-- it, so current_employee_id() resolves to NULL.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
    '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated","email":"nobody-real@example.com"}';
  SELECT current_employee_id() AS should_be_null, is_admin() AS should_be_false;
  -- EXPECT: all three return 0 rows. Not an error — the rows exist, they are
  -- just invisible, exactly like the "Account not set up yet" screen implies.
  SELECT count(*) AS unlinked_employees FROM employees;
  SELECT count(*) AS unlinked_tasks FROM tasks;
  SELECT count(*) AS unlinked_websites FROM websites;
  -- EXPECT: ERROR 42501 — cannot create a task with no linked identity.
  INSERT INTO tasks (title, month, year) VALUES ('unlinked stranger task', 1, 2026);
ROLLBACK;

-- ---------- B. MEMBER — the restricted-to-own-data behaviour -----------
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
    '{"sub":"<MEMBER_AUTH_UUID>","role":"authenticated","email":"<member email>"}';

  -- EXPECT: the member's own employee id, and false.
  SELECT current_employee_id() AS me, is_admin() AS admin;

  -- THE KEY CHANGE FROM THE ORIGINAL DESIGN: this must now return ONLY that
  -- person's own tasks, not every task in the company. Compare this count to
  -- the admin's count in section C below — they should differ (unless this
  -- member happens to have every task, which won't be true in practice).
  SELECT count(*) AS visible_tasks FROM tasks;
  SELECT DISTINCT assigned_to FROM tasks; -- EXPECT: exactly one value — themselves

  -- EXPECT: still full team-wide read — employees/websites are shared
  -- reference data, not what your restriction was about.
  SELECT count(*) AS visible_emps FROM employees;
  SELECT count(*) AS visible_sites FROM websites;

  -- EXPECT: succeeds — booking hours / completing their own task.
  UPDATE tasks SET status = 'completed', time_taken = 3, completed_date = now()
   WHERE assigned_to = current_employee_id()
   RETURNING id, title, status;

  -- EXPECT: self-assigned insert succeeds (carry-forward / additional task).
  INSERT INTO tasks (title, assigned_to, month, year)
  VALUES ('member self task', current_employee_id(), 1, 2026)
  RETURNING id;

  -- EXPECT: ERROR 42501 — cannot create work for someone else.
  INSERT INTO tasks (title, assigned_to, month, year)
  SELECT 'work for someone else', e.id, 1, 2026
    FROM employees e WHERE e.id IS DISTINCT FROM current_employee_id() LIMIT 1;

  -- EXPECT: 0 rows deleted — delete stays admin-only regardless of ownership.
  DELETE FROM tasks WHERE assigned_to = current_employee_id() RETURNING id;

  -- EXPECT: 0 rows — cannot self-promote.
  UPDATE employees SET role = 'admin' WHERE id = current_employee_id() RETURNING id, role;

  -- EXPECT: 0 rows — cannot re-point their own email (the identity link).
  UPDATE employees SET email = 'someone-else@ifluids.com' WHERE id = current_employee_id() RETURNING id;

  -- EXPECT: ERROR 42501 — employees/websites writes stay admin-only.
  INSERT INTO employees (name, designation, email) VALUES ('Ghost', 'Intern', 'ghost@ifluids.com');
ROLLBACK;

-- Separately: confirm a member truly cannot read a specific colleague's task
-- by id, even when they already know its UUID (not just "SELECT * happens to
-- filter it out" — this proves the row is invisible, full stop).
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
    '{"sub":"<MEMBER_AUTH_UUID>","role":"authenticated","email":"<member email>"}';
  -- Put a real task id belonging to someone else here.
  -- EXPECT: 0 rows, not an error — the row exists but is invisible to this role.
  SELECT * FROM tasks WHERE id = '<SOMEONE_ELSES_TASK_ID>';
ROLLBACK;

-- ---------- C. ADMIN — sees and can do everything -----------------------
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
    '{"sub":"<ADMIN_AUTH_UUID>","role":"authenticated","email":"<admin email>"}';

  SELECT is_admin() AS should_be_true;

  -- EXPECT: this is the whole company's task count — compare against
  -- section B's member count above; it should be larger.
  SELECT count(*) AS all_tasks_visible_to_admin FROM tasks;

  INSERT INTO employees (name, designation, email) VALUES ('Temp Person', 'QA', 'temp.person@ifluids.com') RETURNING id;
  INSERT INTO websites (name, description) VALUES ('rls-test.example', 'temp') RETURNING id;
  INSERT INTO tasks (title, month, year) VALUES ('admin task for anyone', 1, 2026) RETURNING id;
  DELETE FROM tasks WHERE title = 'admin task for anyone' RETURNING id;
  UPDATE tasks SET priority = 'high' WHERE assigned_to IS NOT NULL RETURNING count(*) OVER ();
ROLLBACK;

-- ---------- D. Structural assertions ------------------------------------
-- EXPECT: no policy with roles = {public}. None of the three SELECT policies'
-- `qual` should read literally "true" any more — employees/websites now
-- require current_employee_id() IS NOT NULL, and tasks requires is_admin()
-- OR an ownership match.
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'public'
  AND tablename IN ('employees', 'websites', 'tasks')
ORDER BY tablename, cmd, policyname;

-- EXPECT: relrowsecurity = true, relforcerowsecurity = FALSE for all 3.
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname IN ('employees', 'websites', 'tasks');

-- EXPECT: prosecdef = true and a pinned search_path on both helpers.
SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('is_admin', 'current_employee_id');

-- EXPECT: zero rows — every login has an employee row.
SELECT u.id, u.email FROM auth.users u
LEFT JOIN employees e ON e.user_id = u.id WHERE e.id IS NULL;

-- EXPECT: exactly one admin.
SELECT count(*) AS admins FROM employees WHERE role = 'admin';
