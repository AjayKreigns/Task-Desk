-- =============================================================
-- TEAMS FOUNDATION — multi-team schema, step 1 of 4
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Run FIRST, before supabase_teams_rls.sql,
-- supabase_categories_table.sql, and supabase_teams_admin_rpc.sql.
--
-- WHAT THIS DOES
-- Introduces `teams` and gives every employee/website/task a team_id, so a
-- second (third, fourth...) team can use this dashboard in complete isolation
-- from Digital Marketing's data. This script ONLY adds the schema and
-- backfills it — RLS stays exactly as it is today until supabase_teams_rls.sql
-- runs next. Nobody's actual access changes yet from this script alone.
--
-- MIGRATION DEFAULT (confirmed with the user)
-- All existing data becomes one "Digital Marketing" team. The current admin
-- account(s) become 'super_admin'. Promoting someone as Digital Marketing's
-- own team lead ('admin') is a manual step you do AFTER this script — it
-- deliberately does not guess who that should be.
--
-- WHY tasks.team_id IS ITS OWN COLUMN, NOT A LIVE JOIN THROUGH assigned_to
-- assigned_to is nullable (ON DELETE SET NULL) — a join-derived team would
-- make an orphaned task invisible to everyone but a super_admin. It also
-- means an employee later moving to a different team never retroactively
-- changes which team owns their PAST tasks — a task's team is decided once,
-- at creation/reassignment time, by the trigger below, and otherwise pinned.
--
-- Re-runnable: every statement is IF NOT EXISTS / OR REPLACE / DROP-then-
-- CREATE, so running this twice changes nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. teams ----------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  -- Per-team display label for the "websites" concept — Digital Marketing
  -- sees "Website"/"Websites" everywhere; another team sees the identical
  -- feature as e.g. "Company"/"Companies". Two columns, not one pluralized
  -- at render time: naive pluralization breaks ("Company" -> "Companys").
  entity_label_singular TEXT NOT NULL DEFAULT 'Website',
  entity_label_plural   TEXT NOT NULL DEFAULT 'Websites',
  -- Exactly one row is true: Digital Marketing. Drives Lead Center's
  -- visibility rule on the frontend — a stable boolean, not string-matching
  -- `name` (which is just editable text an admin could rename).
  is_lead_source_team   BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT now()
);

INSERT INTO teams (name, entity_label_singular, entity_label_plural, is_lead_source_team)
SELECT 'Digital Marketing', 'Website', 'Websites', true
WHERE NOT EXISTS (SELECT 1 FROM teams WHERE name = 'Digital Marketing');

-- Enabled here, with zero policies yet, deliberately — this script's own
-- policies don't land until supabase_teams_rls.sql (step 2), since they
-- depend on is_super_admin()/current_team_id(), defined there. RLS enabled
-- with no policy at all means nobody but the table owner (this script, and
-- the Supabase dashboard) can read or write a single row of it in the
-- meantime — the safe default for that gap, and also what a real policy
-- later replaces. Without this line, Supabase's own default grants leave a
-- newly created public-schema table readable/writable by anon/authenticated
-- immediately, which is exactly the "table with no RLS" warning the SQL
-- Editor raises on this script otherwise.
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

-- ---------- 2. team_id on employees, websites, tasks ---------------------
-- Added nullable first, backfilled, THEN set NOT NULL — the standard safe
-- three-step pattern for adding a required column to a populated table.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);
ALTER TABLE websites  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);

DO $$
DECLARE v_dm_team_id UUID;
BEGIN
  SELECT id INTO v_dm_team_id FROM teams WHERE name = 'Digital Marketing';

  UPDATE employees SET team_id = v_dm_team_id WHERE team_id IS NULL;
  UPDATE websites  SET team_id = v_dm_team_id WHERE team_id IS NULL;
  UPDATE tasks     SET team_id = v_dm_team_id WHERE team_id IS NULL;
END $$;

ALTER TABLE employees ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE websites  ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE tasks     ALTER COLUMN team_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS employees_team_id_idx ON employees (team_id);
CREATE INDEX IF NOT EXISTS websites_team_id_idx  ON websites (team_id);
CREATE INDEX IF NOT EXISTS tasks_team_id_idx     ON tasks (team_id);

-- ---------- 3. tasks.team_id assignment/pin trigger ----------------------
-- On INSERT: team comes from the assignee's current team, or (if created
-- unassigned) the creator's own team. On UPDATE: a deliberate reassignment
-- (assigned_to actually changing to a non-null value) moves the task to the
-- new assignee's team; anything else — including assigned_to going NULL, or
-- a direct attempt to write team_id itself — leaves team_id exactly as it
-- was. This is what keeps a task's team ownership from drifting just because
-- its assignee's own team changes elsewhere, or because the assignment is
-- cleared.
CREATE OR REPLACE FUNCTION tasks_assign_team_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.team_id := COALESCE(
      (SELECT team_id FROM employees WHERE id = NEW.assigned_to),
      (SELECT team_id FROM employees WHERE id = current_employee_id())
    );
  ELSE -- UPDATE
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
      NEW.team_id := (SELECT team_id FROM employees WHERE id = NEW.assigned_to);
    ELSE
      NEW.team_id := OLD.team_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- current_employee_id() already exists from supabase_rls_policies.sql (run
-- long before this script, per this project's own migration history) — the
-- INSERT branch above depends on it being defined already.
DROP TRIGGER IF EXISTS tasks_assign_team_id_trg ON tasks;
CREATE TRIGGER tasks_assign_team_id_trg
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_assign_team_id();

-- ---------- 4. Role vocabulary grows a 4th value -------------------------
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('super_admin', 'admin', 'member', 'viewer'));

-- ---------- 5. Promote the current admin(s) to super_admin --------------
-- The existing employees_last_admin_trg (supabase_rls_policies.sql) guards
-- against role='admin' ever hitting zero — exactly the invariant this step
-- intentionally breaks (every admin becomes super_admin, so admin count
-- legitimately goes to zero until the manual follow-up below promotes a new
-- one). Dropped here, not disabled-and-restored, because supabase_teams_rls.sql
-- (step 2) replaces it outright with guard_employee_role_changes() — a plain
-- DROP is exactly what that script's own migration already does, just done
-- slightly earlier here since this UPDATE can't run with the old guard
-- still attached. Employees has no admin-removal guard at all for the brief
-- gap between this script and the next — acceptable since the next script
-- runs immediately after, same as every other RLS gap already documented in
-- this migration (e.g. teams itself, enabled above with no policies yet).
DROP TRIGGER IF EXISTS employees_last_admin_trg ON employees;

-- Every existing 'admin' becomes 'super_admin' — matching "you become Super
-- Admin" from the confirmed migration default. If you only ever had one
-- admin, this promotes exactly that one account.
--
-- Guarded to run ONCE, ever: without the NOT EXISTS check, re-running this
-- script (it's documented above as safe to re-run, and nothing stops someone
-- doing so) would re-promote every current 'admin' back to 'super_admin' —
-- silently undoing the manual follow-up below the moment it's done. A
-- super_admin already existing is exactly the signal that this bootstrap
-- step already ran once.
UPDATE employees SET role = 'super_admin' WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM employees WHERE role = 'super_admin');

COMMIT;

-- =============================================================
-- MANUAL FOLLOW-UP REQUIRED (not automated by this script, on purpose)
-- Digital Marketing now has a super_admin but no team lead of its own.
-- Promote exactly one Digital Marketing employee to role = 'admin' yourself,
-- e.g.:
--   UPDATE employees SET role = 'admin' WHERE email = 'someone@ifluids.com';
-- This script deliberately does not guess who that should be.
-- =============================================================

-- ---------- Verify ----------------------------------------------------
-- Expect: exactly one team.
SELECT count(*) AS team_count FROM teams;

-- Expect: zero rows across all three — every row has a team_id.
SELECT 'employees' AS tbl, count(*) FROM employees WHERE team_id IS NULL
UNION ALL SELECT 'websites', count(*) FROM websites WHERE team_id IS NULL
UNION ALL SELECT 'tasks', count(*) FROM tasks WHERE team_id IS NULL;

-- Expect: at least one super_admin, matching however many admins existed before.
SELECT name, email, role FROM employees WHERE role = 'super_admin' ORDER BY name;
