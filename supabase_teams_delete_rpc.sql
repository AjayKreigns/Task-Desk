-- =============================================================
-- TEAMS DELETE RPC — multi-team schema, step 5
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Run AFTER supabase_teams_foundation.sql, supabase_teams_rls.sql,
-- supabase_categories_table.sql, and supabase_teams_admin_rpc.sql (needs
-- is_super_admin() to exist).
--
-- WHY A CONTROLLED RPC, NOT A RAW DELETE GRANT ON teams
-- supabase_teams_rls.sql deliberately left teams with no DELETE grant at
-- all — deleting a team raises questions a plain RLS policy can't answer on
-- its own: what happens to its employees, tasks, categories, websites? This
-- function answers that explicitly, the same precedent as
-- create_team_with_admin() (supabase_teams_admin_rpc.sql): one atomic,
-- privileged function call instead of raw table writes from the client.
--
-- THE TWO SAFETY RULES (both checked server-side, not just in the UI)
--   1. The Digital Marketing team (is_lead_source_team) can never be
--      deleted — it's the one team Lead Center depends on, and effectively
--      this app's original, foundational team.
--   2. A team with ANY tasks at all cannot be deleted. Tasks are real
--      scheduled/completed work — this function will never silently
--      destroy that history. A team can only be deleted while it's still
--      "empty" in the sense that matters; its employees, categories and
--      {{unit}} are removed along with it (nothing there is irreplaceable
--      the way a task's work record is), but if real work has already been
--      logged against it, it must be manually cleared (reassign or delete
--      those tasks first) before the team itself can go.
--
-- Re-runnable: CREATE OR REPLACE, so running this twice just redefines the
-- same function.
-- =============================================================
BEGIN;

CREATE OR REPLACE FUNCTION delete_team(p_team_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_lead_source BOOLEAN;
  v_task_count INT;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin may delete a team.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT is_lead_source_team INTO v_is_lead_source FROM teams WHERE id = p_team_id;
  IF v_is_lead_source IS NULL THEN
    RAISE EXCEPTION 'Team not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_is_lead_source THEN
    RAISE EXCEPTION 'The Digital Marketing team cannot be deleted.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_task_count FROM tasks WHERE team_id = p_team_id;
  IF v_task_count > 0 THEN
    RAISE EXCEPTION 'This team still has % task(s) — remove or reassign them before deleting the team.', v_task_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- guard_employee_role_changes (supabase_teams_rls.sql) fires on every
  -- employee DELETE below and would block removing this team's last
  -- admin/super_admin via its "last admin of this team" check — bypassed
  -- here the same way this schema's own migration self-tests already do,
  -- since this is a deliberate whole-team teardown, not an accidental
  -- demotion the guard exists to catch.
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM categories WHERE team_id = p_team_id;
  DELETE FROM websites WHERE team_id = p_team_id;
  DELETE FROM employees WHERE team_id = p_team_id;
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM teams WHERE id = p_team_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_team(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_team(UUID) TO authenticated;

COMMIT;

-- ---------- Self-test, as its own transaction ----------------------------
-- Every fixture fabricated (teams/employees — all user_id NULL), never a
-- real account or the real Digital Marketing row — same reasoning as this
-- schema's other self-tests.
BEGIN;
DO $$
DECLARE
  v_empty_team UUID;
  v_empty_admin UUID;
  v_busy_team UUID;
  v_busy_admin UUID;
  v_busy_task UUID;
  v_fake_lead_team UUID;
  v_fake_lead_admin UUID;
  v_member_id UUID;
  v_rejected BOOLEAN;
  v_row_count INT;
BEGIN
  -- ---- Fixture 1: a deletable team (no tasks) ----
  INSERT INTO teams (name) VALUES ('__selftest_del_empty__') RETURNING id INTO v_empty_team;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_del_empty_admin__', 'QA', 'st-del-empty-admin@example.invalid', 'admin', v_empty_team)
    RETURNING id INTO v_empty_admin;
  INSERT INTO categories (team_id, name, color) VALUES (v_empty_team, '__SelftestDelCat__', '#111111');

  -- ---- Fixture 2: a team with a task — must be rejected ----
  INSERT INTO teams (name) VALUES ('__selftest_del_busy__') RETURNING id INTO v_busy_team;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_del_busy_admin__', 'QA', 'st-del-busy-admin@example.invalid', 'admin', v_busy_team)
    RETURNING id INTO v_busy_admin;
  INSERT INTO tasks (title, assigned_to, month, year, status)
    VALUES ('__selftest_del_busy_task__', v_busy_admin, 1, 1900, 'pending') RETURNING id INTO v_busy_task;

  -- ---- Fixture 3: a fake "lead source" team — must never be deletable,
  -- fabricated rather than using the real Digital Marketing row so a bug in
  -- this very check could never risk actual production data. ----
  INSERT INTO teams (name, is_lead_source_team) VALUES ('__selftest_del_lead__', true) RETURNING id INTO v_fake_lead_team;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_del_lead_admin__', 'QA', 'st-del-lead-admin@example.invalid', 'admin', v_fake_lead_team)
    RETURNING id INTO v_fake_lead_admin;

  -- A plain member, parked on the empty team, to prove non-super-admins are rejected.
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_del_member__', 'QA', 'st-del-member@example.invalid', 'member', v_empty_team)
    RETURNING id INTO v_member_id;

  -- ---- Reject as a non-super-admin ----
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-del-member@example.invalid')::text, true);
  v_rejected := false;
  BEGIN
    PERFORM delete_team(v_empty_team);
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Self-test FAILED: a plain member was able to call delete_team().';
  END IF;

  -- ---- As a fake super_admin from here on ----
  EXECUTE 'RESET ROLE';
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  UPDATE employees SET role = 'super_admin' WHERE id = v_empty_admin;
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-del-empty-admin@example.invalid')::text, true);

  -- ---- Reject deleting a team with a task ----
  v_rejected := false;
  BEGIN
    PERFORM delete_team(v_busy_team);
  EXCEPTION WHEN foreign_key_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Self-test FAILED: a team with a real task was deleted.';
  END IF;

  -- ---- Reject deleting a "lead source" team ----
  v_rejected := false;
  BEGIN
    PERFORM delete_team(v_fake_lead_team);
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Self-test FAILED: a lead-source team was deleted.';
  END IF;

  -- ---- Succeed: delete the empty team, taking its admin/member/category with it ----
  PERFORM delete_team(v_empty_team);

  SELECT count(*) INTO v_row_count FROM teams WHERE id = v_empty_team;
  IF v_row_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: the empty team still exists after delete_team().'; END IF;
  SELECT count(*) INTO v_row_count FROM employees WHERE team_id = v_empty_team;
  IF v_row_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: the deleted team''s employees still exist.'; END IF;
  SELECT count(*) INTO v_row_count FROM categories WHERE team_id = v_empty_team;
  IF v_row_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: the deleted team''s categories still exist.'; END IF;

  RAISE NOTICE 'Teams delete RPC self-test passed: non-super-admin rejected, a team with tasks rejected, a lead-source team rejected, and an empty team (plus its employees/categories) deleted cleanly.';

  -- ---- Clean up whatever's left (the empty team is already gone) ----
  EXECUTE 'RESET ROLE';
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM tasks WHERE id = v_busy_task;
  DELETE FROM employees WHERE id IN (v_busy_admin, v_fake_lead_admin);
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM teams WHERE id IN (v_busy_team, v_fake_lead_team);
END $$;
COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: no rows — every fixture cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM teams WHERE name LIKE '__selftest_del%';
