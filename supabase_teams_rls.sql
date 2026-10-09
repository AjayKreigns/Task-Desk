-- =============================================================
-- TEAMS RLS — multi-team schema, step 2 of 4
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Run AFTER supabase_teams_foundation.sql.
--
-- WHAT CHANGES FOR REAL USERS after this runs
--   - 'admin' narrows from "sees/manages everything" to "sees/manages only
--     my own team". 'viewer' narrows the same way (full read, zero write,
--     within one team instead of globally). 'member' is unaffected — it
--     already only ever saw its own tasks.
--   - A new 'super_admin' role sees and manages every team.
--   - A team's own admin can no longer promote anyone to 'super_admin' —
--     only an existing super_admin can grant that role (new guard, closing a
--     gap the original design didn't have: is_team_admin() only checks WHO
--     may write a row, not WHICH values they're allowed to write into it).
--   - "Don't remove the last admin" becomes per-team, not company-wide — in
--     a multi-team world, the old company-wide check would have wrongly
--     allowed emptying Team A of admins just because Team B still had one.
--
-- Re-runnable: every statement drops-then-creates, so running this twice is
-- safe and changes nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. Helper functions ------------------------------------------
-- current_employee_id()/is_admin()/is_viewer() (supabase_rls_policies.sql,
-- supabase_viewer_role.sql) are untouched — they stay plain role/identity
-- checks with zero team awareness, composed by the team-aware helpers below
-- rather than rewritten in place.
CREATE OR REPLACE FUNCTION current_team_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.team_id FROM employees e WHERE e.id = current_employee_id();
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT e.role = 'super_admin' FROM employees e WHERE e.id = current_employee_id()),
    false);
$$;

-- Takes a ROW's team_id as its argument, unlike the caller-only functions
-- above — this is inherently evaluated per-row regardless of `(select ...)`
-- wrapping in a policy, so wrapping it there is for stylistic consistency
-- with the rest of this file, not for the same per-statement InitPlan
-- caching current_employee_id()/is_admin() get.
CREATE OR REPLACE FUNCTION is_same_team(target_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT target_team_id IS NOT NULL AND target_team_id = current_team_id();
$$;

CREATE OR REPLACE FUNCTION is_team_admin(target_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT is_super_admin() OR ((select is_admin()) AND is_same_team(target_team_id));
$$;

-- tasks SELECT only: full-read bypass covering both team-admin and
-- team-scoped viewer in one call, mirroring is_team_admin()'s shape.
CREATE OR REPLACE FUNCTION is_team_reader(target_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT is_team_admin(target_team_id) OR ((select is_viewer()) AND is_same_team(target_team_id));
$$;

REVOKE ALL ON FUNCTION current_team_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_same_team(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_team_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_team_reader(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_team_id() TO authenticated;
GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION is_same_team(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION is_team_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION is_team_reader(UUID) TO authenticated;

-- ---------- 2. teams: RLS ------------------------------------------------
-- The teams TABLE was created in supabase_teams_foundation.sql; its RLS
-- lives here alongside every other policy change, since it depends on
-- is_super_admin() defined just above.
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON teams FROM anon;
GRANT SELECT, INSERT, UPDATE ON teams TO authenticated;
-- No DELETE grant at all — team deletion was out of scope when this script
-- was written (no cascade/reassignment semantics designed yet). It became a
-- real need; see supabase_teams_delete_rpc.sql for the controlled RPC that
-- now handles it instead of a raw DELETE grant on this table.

DROP POLICY IF EXISTS teams_select_own_or_super_admin ON teams;
CREATE POLICY teams_select_own_or_super_admin ON teams
  FOR SELECT TO authenticated
  USING ((select is_super_admin()) OR id = (select current_team_id()));

DROP POLICY IF EXISTS teams_insert_super_admin ON teams;
CREATE POLICY teams_insert_super_admin ON teams
  FOR INSERT TO authenticated
  WITH CHECK ((select is_super_admin()));

DROP POLICY IF EXISTS teams_update_super_admin ON teams;
CREATE POLICY teams_update_super_admin ON teams
  FOR UPDATE TO authenticated
  USING ((select is_super_admin())) WITH CHECK ((select is_super_admin()));

-- ---------- 3. employees: team-scoped ------------------------------------
DROP POLICY IF EXISTS employees_select_authenticated ON employees;
CREATE POLICY employees_select_authenticated ON employees
  FOR SELECT TO authenticated
  USING ((select is_super_admin()) OR is_same_team(team_id));

DROP POLICY IF EXISTS employees_insert_admin ON employees;
CREATE POLICY employees_insert_admin ON employees
  FOR INSERT TO authenticated WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS employees_update_admin ON employees;
CREATE POLICY employees_update_admin ON employees
  FOR UPDATE TO authenticated
  USING ((select is_team_admin(team_id)))
  WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS employees_delete_admin ON employees;
CREATE POLICY employees_delete_admin ON employees
  FOR DELETE TO authenticated USING ((select is_team_admin(team_id)));

-- ---------- 4. websites: team-scoped --------------------------------------
DROP POLICY IF EXISTS websites_select_authenticated ON websites;
CREATE POLICY websites_select_authenticated ON websites
  FOR SELECT TO authenticated
  USING ((select is_super_admin()) OR is_same_team(team_id));

DROP POLICY IF EXISTS websites_insert_admin ON websites;
CREATE POLICY websites_insert_admin ON websites
  FOR INSERT TO authenticated WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS websites_update_admin ON websites;
CREATE POLICY websites_update_admin ON websites
  FOR UPDATE TO authenticated
  USING ((select is_team_admin(team_id))) WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS websites_delete_admin ON websites;
CREATE POLICY websites_delete_admin ON websites
  FOR DELETE TO authenticated USING ((select is_team_admin(team_id)));

-- ---------- 5. tasks: team-scoped, member/viewer rules unchanged in shape --
-- Mechanical diff from the existing policies: every bare is_admin() becomes
-- is_team_admin(team_id)/is_team_reader(team_id); the member-ownership
-- clause and the viewer-exclusion are untouched, since a member's own-task
-- access is already implicitly team-safe (they can only ever be assigned to
-- themselves, who belongs to exactly one team).
DROP POLICY IF EXISTS tasks_select_own_or_admin ON tasks;
CREATE POLICY tasks_select_own_or_admin ON tasks
  FOR SELECT TO authenticated
  USING (
    (select is_team_reader(team_id))
    OR assigned_to = (select current_employee_id())
  );

DROP POLICY IF EXISTS tasks_insert_own_or_admin ON tasks;
CREATE POLICY tasks_insert_own_or_admin ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select is_team_admin(team_id))
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

DROP POLICY IF EXISTS tasks_update_own_or_admin ON tasks;
CREATE POLICY tasks_update_own_or_admin ON tasks
  FOR UPDATE TO authenticated
  USING (
    (select is_team_admin(team_id))
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  )
  WITH CHECK (
    (select is_team_admin(team_id))
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

DROP POLICY IF EXISTS tasks_delete_own_or_admin ON tasks;
CREATE POLICY tasks_delete_own_or_admin ON tasks
  FOR DELETE TO authenticated
  USING (
    (select is_team_admin(team_id))
    OR (NOT (select is_viewer()) AND assigned_to = (select current_employee_id()))
  );

-- leads: ZERO changes. Confirmed to stay the single shared, non-team-scoped
-- resource exactly as supabase_leads_admin_only_writes.sql already left it.

-- ---------- 6. Consolidated role-change guard ----------------------------
-- Replaces prevent_last_admin_removal with a function that does two jobs:
--   (a) blocks anyone but an existing super_admin from ever setting
--       role = 'super_admin' on INSERT or UPDATE — is_team_admin(team_id)
--       only checks WHO may write a row, not WHICH role value they write
--       into it, so without this a team's own admin could silently grant
--       themselves or a teammate global access.
--   (b) on UPDATE/DELETE, blocks removing the last super_admin company-wide,
--       and blocks removing the last admin OF THAT SPECIFIC TEAM (not
--       company-wide — a team being left admin-less must not be hidden by
--       some OTHER team still having one). This also correctly catches
--       transferring a team's last admin to a different team (team_id
--       changing without role changing), since the EXISTS check below runs
--       against OLD.team_id either way.
CREATE OR REPLACE FUNCTION guard_employee_role_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'super_admin' AND NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin may grant super admin access.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.role = 'super_admin' AND NOT EXISTS (
      SELECT 1 FROM employees WHERE role = 'super_admin' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'Refusing to remove the last super admin — promote someone else first.'
        USING ERRCODE = 'check_violation';
    ELSIF OLD.role = 'admin' AND NOT EXISTS (
      SELECT 1 FROM employees WHERE role = 'admin' AND team_id = OLD.team_id AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'Refusing to remove the last admin of this team — promote someone else first.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL; -- AFTER trigger; return value is ignored either way
END;
$$;

DROP TRIGGER IF EXISTS employees_last_admin_trg ON employees;      -- the old name, from supabase_rls_policies.sql
DROP TRIGGER IF EXISTS employees_role_change_guard_trg ON employees;
CREATE TRIGGER employees_role_change_guard_trg
  AFTER INSERT OR UPDATE OR DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION guard_employee_role_changes();

-- ---------- 7. REPLICA IDENTITY FULL -------------------------------------
-- tasks already has this (supabase_rls_policies.sql). employees/websites now
-- need it too: their SELECT policies reference team_id, a column on the row
-- itself, not just the caller's identity — Realtime can't evaluate who
-- should receive a DELETE event from the bare-PK WAL record under default
-- replica identity otherwise. teams does NOT need this — its own policy only
-- depends on the row's own primary key, already in the WAL by default.
ALTER TABLE employees REPLICA IDENTITY FULL;
ALTER TABLE websites  REPLICA IDENTITY FULL;

COMMIT;

-- ---------- Self-test, as its own transaction ----------------------------
-- Fully self-contained: fabricates two fake teams with their own
-- admin/member/viewer, plus a fake super_admin, impersonates each via
-- SET LOCAL ROLE + a faked JWT claim (current_employee_id() only ever joins
-- against employees, never auth.users — real accounts aren't needed), then
-- deletes everything it planted. Refuses to leave anything behind either way.
BEGIN;
DO $$
DECLARE
  v_team_a UUID; v_team_b UUID;
  v_a_admin UUID; v_a_member UUID; v_a_viewer UUID;
  v_b_admin UUID; v_b_member UUID;
  v_super UUID;
  v_task_a UUID; v_task_b UUID;
  v_count INT; v_row_count INT;
BEGIN
  -- ---- Setup, as the privileged script-runner (table owner, bypasses RLS) ----
  -- Trigger disabled only for this fixture setup, re-enabled immediately
  -- after — guard_employee_role_changes() checks is_super_admin() on EVERY
  -- INSERT of role='super_admin', including this script's own raw fixture
  -- insert below (v_super), since table-owner RLS bypass does not also
  -- bypass ordinary triggers. The guard itself is exactly what gets tested
  -- below (a real client, authenticated as a non-super-admin, must still be
  -- rejected) — this disable only covers planting the fixture super_admin
  -- row directly, before any role is impersonated.
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;

  INSERT INTO teams (name, entity_label_singular, entity_label_plural)
    VALUES ('__selftest_team_a__', 'Website', 'Websites') RETURNING id INTO v_team_a;
  INSERT INTO teams (name, entity_label_singular, entity_label_plural)
    VALUES ('__selftest_team_b__', 'Company', 'Companies') RETURNING id INTO v_team_b;

  -- user_id left NULL throughout: employees.user_id has a foreign key into
  -- auth.users, which a fabricated UUID can't satisfy. current_employee_id()'s
  -- own fallback path (user_id IS NULL, match by email) is exactly what a
  -- pre-signup employee row already relies on — no real auth account needed.
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_a_admin__', 'QA', 'st-a-admin@example.invalid', 'admin', v_team_a) RETURNING id INTO v_a_admin;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_a_member__', 'QA', 'st-a-member@example.invalid', 'member', v_team_a) RETURNING id INTO v_a_member;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_a_viewer__', 'QA', 'st-a-viewer@example.invalid', 'viewer', v_team_a) RETURNING id INTO v_a_viewer;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_b_admin__', 'QA', 'st-b-admin@example.invalid', 'admin', v_team_b) RETURNING id INTO v_b_admin;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_b_member__', 'QA', 'st-b-member@example.invalid', 'member', v_team_b) RETURNING id INTO v_b_member;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_super__', 'QA', 'st-super@example.invalid', 'super_admin', v_team_a) RETURNING id INTO v_super;

  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;

  INSERT INTO tasks (title, assigned_to, month, year, status)
    VALUES ('__selftest_task_a__', v_a_member, 1, 1900, 'pending') RETURNING id INTO v_task_a;
  INSERT INTO tasks (title, assigned_to, month, year, status)
    VALUES ('__selftest_task_b__', v_b_member, 1, 1900, 'pending') RETURNING id INTO v_task_b;

  -- ---- As Team A's admin ----
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-a-admin@example.invalid')::text, true);

  -- 4, not 3: Team A holds v_a_admin/v_a_member/v_a_viewer AND v_super (the
  -- fixture super_admin above is parked in Team A too — it needs SOME
  -- team_id to satisfy the NOT NULL column, and which one doesn't matter
  -- since role=super_admin grants it visibility regardless). The later
  -- "super_admin sees all 6" assertion already counted it this way; this is
  -- the one place that didn't.
  SELECT count(*) INTO v_count FROM employees WHERE team_id = v_team_a;
  IF v_count <> 4 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin should see all 4 of Team A''s own employees, saw %.', v_count; END IF;
  SELECT count(*) INTO v_count FROM employees WHERE team_id = v_team_b;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin could see Team B''s employees (saw %) — cross-team isolation broken.', v_count; END IF;

  SELECT count(*) INTO v_count FROM tasks WHERE id = v_task_b;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin could see Team B''s task.'; END IF;

  -- Cross-team write must silently affect 0 rows (USING-filtered, not an
  -- exception) — asserting on ROW_COUNT, not exception-catching.
  UPDATE tasks SET status = 'completed' WHERE id = v_task_b;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin was able to UPDATE Team B''s task (% rows).', v_row_count; END IF;

  -- Role-escalation guard: Team A's admin must not be able to promote
  -- anyone to super_admin — this DOES raise (it's a BEFORE... no, an AFTER
  -- trigger via RAISE EXCEPTION aborts the whole statement either way).
  BEGIN
    UPDATE employees SET role = 'super_admin' WHERE id = v_a_member;
    RAISE EXCEPTION 'Self-test FAILED: Team A admin was able to grant super_admin.';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;

  -- Last-admin-of-THIS-team guard: Team A's admin is the only admin on Team
  -- A — demoting them must fail even though Team B's own admin still exists
  -- (proving the guard is per-team, not company-wide).
  BEGIN
    UPDATE employees SET role = 'member' WHERE id = v_a_admin;
    RAISE EXCEPTION 'Self-test FAILED: demoted the last admin of Team A while Team B''s admin still existed — guard is not actually per-team.';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- ---- As the fake super_admin ----
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-super@example.invalid')::text, true);

  SELECT count(*) INTO v_count FROM employees WHERE team_id IN (v_team_a, v_team_b);
  IF v_count <> 6 THEN RAISE EXCEPTION 'Self-test FAILED: super_admin should see all 6 fixture employees across both teams, saw %.', v_count; END IF;

  SELECT count(*) INTO v_count FROM teams WHERE id IN (v_team_a, v_team_b);
  IF v_count <> 2 THEN RAISE EXCEPTION 'Self-test FAILED: super_admin should see both fake teams, saw %.', v_count; END IF;

  -- Super admin CAN grant super_admin (the one case that should succeed).
  UPDATE employees SET role = 'super_admin' WHERE id = v_b_member;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN RAISE EXCEPTION 'Self-test FAILED: a real super_admin could not grant super_admin.'; END IF;

  RAISE NOTICE 'Teams RLS self-test passed: cross-team read/write isolation confirmed, role-escalation guard confirmed, per-team last-admin guard confirmed, super_admin cross-team visibility confirmed.';

  -- ---- Clean up, as the privileged role ----
  -- Trigger disabled for this one statement, same reasoning as the setup
  -- step above: it deletes two super_admin rows (v_super, and v_b_member —
  -- promoted a few lines up) and two admin rows (v_a_admin, v_b_admin) in
  -- one multi-row DELETE. Whether Postgres's per-row AFTER-trigger firing
  -- would see each already-deleted sibling row as gone (satisfying the
  -- guard) or still present (depending on internal command-counter timing
  -- this script has no business depending on) isn't worth pinning down —
  -- teardown of fixture data was never what this guard exists to protect.
  EXECUTE 'RESET ROLE';
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM tasks WHERE id IN (v_task_a, v_task_b);
  DELETE FROM employees WHERE id IN (v_a_admin, v_a_member, v_a_viewer, v_b_admin, v_b_member, v_super);
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM teams WHERE id IN (v_team_a, v_team_b);
END $$;
COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: no rows — every fixture cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM employees WHERE name LIKE '__st_%';
SELECT count(*) AS selftest_teams_remaining FROM teams WHERE name LIKE '__selftest_%';

-- Expect: every tasks policy below mentions is_team_admin/is_team_reader.
SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('teams', 'employees', 'websites', 'tasks')
ORDER BY tablename, cmd, policyname;
