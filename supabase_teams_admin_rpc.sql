-- =============================================================
-- TEAMS ADMIN RPC — multi-team schema, step 4 of 4
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Run AFTER supabase_teams_foundation.sql,
-- supabase_teams_rls.sql, and supabase_categories_table.sql (needs
-- is_super_admin() to exist).
--
-- WHY ONE RPC, NOT TWO SEPARATE INSERTS FROM THE APP
-- Creating a team and bootstrapping its first admin are two inserts across
-- two tables. Done as two separate round-trips from the frontend, a
-- brand-new team could end up with no admin at all (nobody could ever
-- manage it through the UI again) if the second step failed. One atomic
-- function call means that can't happen — either the whole team is fully
-- usable, or nothing was created at all. Same precedent as the existing
-- get_storage_usage() function (supabase_storage_usage_rpc.sql): a plain
-- SECURITY DEFINER function the dashboard calls directly, rather than raw
-- table writes from the client.
--
-- WHY A NEW TEAM STARTS WITH ZERO CATEGORIES (confirmed with the user,
-- reversing this schema's original decision)
-- Earlier versions of this migration seeded every new team from Digital
-- Marketing's own 11 categories, reasoning that an empty team couldn't
-- create a single task until its lead manually re-typed them. Tested
-- against a real second team and reversed: Digital Marketing's category set
-- is specific to Digital Marketing's own work, not a sensible generic
-- starting point for an unrelated team — every other team defines its own
-- categories from scratch instead. Digital Marketing's own categories
-- (already backfilled by supabase_categories_table.sql) are unaffected.
--
-- Re-runnable: CREATE OR REPLACE, so running this twice just redefines the
-- same function.
-- =============================================================
BEGIN;

CREATE OR REPLACE FUNCTION create_team_with_admin(
  p_name TEXT,
  p_entity_label_singular TEXT,
  p_entity_label_plural TEXT,
  p_admin_name TEXT,
  p_admin_designation TEXT,
  p_admin_email TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_team_id UUID;
BEGIN
  -- Checked inside the function body, not just via GRANT — so even a
  -- misconfigured future grant can't bypass this. Mirrors the convention
  -- already used by this schema's other privileged write paths.
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin may create a team.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO teams (name, entity_label_singular, entity_label_plural)
  VALUES (p_name, p_entity_label_singular, p_entity_label_plural)
  RETURNING id INTO v_team_id;

  -- No category seeding here — a new team starts with zero categories and
  -- defines its own from scratch (see the header comment above).

  -- role = 'admin': this is the new team's bootstrap lead. employees.role,
  -- .email (normalized/shape-checked), and .email's uniqueness are all
  -- enforced by constraints already in place from supabase_auth_migration.sql
  -- — a bad email or a duplicate surfaces as a real constraint error here,
  -- same as anywhere else in this app.
  INSERT INTO employees (name, designation, email, role, team_id)
  VALUES (p_admin_name, p_admin_designation, p_admin_email, 'admin', v_team_id);

  RETURN v_team_id;
END;
$$;

REVOKE ALL ON FUNCTION create_team_with_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_team_with_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

-- ---------- Self-test, as its own transaction ----------------------------
-- Uses entirely fabricated fixtures throughout (team, member, super_admin —
-- all with user_id left NULL), never a real existing account. Impersonating
-- a REAL account by faking its JWT `sub` does not work here: a real,
-- already-signed-in employee has user_id already set, so
-- current_employee_id()'s email-fallback branch (which only matches rows
-- WHERE user_id IS NULL) would never resolve to them — exactly the same
-- reasoning the other three migration files' self-tests already rely on.
BEGIN;
DO $$
DECLARE
  v_fixture_team UUID;
  v_member_id UUID;
  v_super_id UUID;
  v_new_team_id UUID;
  v_category_count INT;
  v_admin_role TEXT;
  v_rejected BOOLEAN;
BEGIN
  INSERT INTO teams (name) VALUES ('__selftest_rpc_fixture_team__') RETURNING id INTO v_fixture_team;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_rpc_member__', 'QA', 'st-rpc-member@example.invalid', 'member', v_fixture_team)
    RETURNING id INTO v_member_id;

  -- Trigger disabled only for this one fixture insert: guard_employee_role_changes()
  -- (supabase_teams_rls.sql) blocks ANY insert of role='super_admin' unless
  -- the caller already is_super_admin() — which this raw script-runner
  -- context never is, same reasoning as supabase_teams_rls.sql's own
  -- self-test setup.
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_rpc_super__', 'QA', 'st-rpc-super@example.invalid', 'super_admin', v_fixture_team)
    RETURNING id INTO v_super_id;
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;

  -- ---- Reject as a non-super-admin ----
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-rpc-member@example.invalid')::text, true);

  v_rejected := false;
  BEGIN
    PERFORM create_team_with_admin('__selftest_rpc_team__', 'Thing', 'Things', 'X', 'Y', 'st-rpc-admin@example.invalid');
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Self-test FAILED: a plain member was able to call create_team_with_admin().';
  END IF;

  -- ---- Succeed as the fake super_admin ----
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-rpc-super@example.invalid')::text, true);

  v_new_team_id := create_team_with_admin(
    '__selftest_rpc_team__', 'Thing', 'Things',
    '__st_rpc_admin__', 'QA', 'st-rpc-admin@example.invalid'
  );

  SELECT count(*) INTO v_category_count FROM categories WHERE team_id = v_new_team_id;
  IF v_category_count <> 0 THEN
    RAISE EXCEPTION 'Self-test FAILED: a new team should start with 0 categories, got %.', v_category_count;
  END IF;

  SELECT role INTO v_admin_role FROM employees WHERE team_id = v_new_team_id AND email = 'st-rpc-admin@example.invalid';
  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Self-test FAILED: new team''s bootstrap employee does not have role = admin.';
  END IF;

  RAISE NOTICE 'Teams admin RPC self-test passed: non-super-admin correctly rejected; a fake super_admin created a team with zero categories and its first admin bootstrapped, atomically.';

  -- ---- Clean up: both the RPC-created team and the fixture team/employees
  -- used to call it ----
  -- Trigger disabled for the employees deletes below: the RPC-created
  -- team's bootstrap admin is that team's ONLY employee, so
  -- guard_employee_role_changes() (supabase_teams_rls.sql) always blocks
  -- deleting it via its "last admin of this team" check — deterministically,
  -- same reasoning as supabase_categories_table.sql's cleanup fix. Teardown
  -- of fixture data isn't what that guard exists to protect.
  EXECUTE 'RESET ROLE';
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM categories WHERE team_id = v_new_team_id;
  DELETE FROM employees WHERE team_id = v_new_team_id;
  DELETE FROM teams WHERE id = v_new_team_id;
  DELETE FROM employees WHERE id IN (v_member_id, v_super_id);
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM teams WHERE id = v_fixture_team;
END $$;
COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: no rows — every fixture cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM teams WHERE name LIKE '__selftest_rpc%';
