-- =============================================================
-- STAGE A — additive auth migration
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Recommended: run supabase_auth_preflight.sql first and confirm
-- sections (a) and (c) return zero rows.
--
-- WHAT THIS DOES NOT DO: it does not touch the "Allow all on employees/
-- websites/tasks" policies. The app keeps working exactly as it does today —
-- this only adds columns, a normalization trigger, and a trigger that links
-- future logins to the matching employees row. Access is tightened later, in
-- a separate script (Stage B), only once the login-capable app is confirmed
-- working end to end. Safe to run against the live database right now.
--
-- Re-runnable: every statement is IF NOT EXISTS / OR REPLACE / DROP-then-CREATE,
-- so running this twice does nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. New columns on employees -------------------------------
-- user_id links a login to a person. ON DELETE SET NULL, not CASCADE: if an
-- auth account is ever removed, the employee record — and every task they
-- ever did — must survive. Losing someone's login should never erase their
-- work history.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Defaults to 'member'. Nobody becomes an admin by running this script —
-- promoting the first admin is a separate, explicit step you'll do right
-- before Stage B (I'll give you that when we get there).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees
  ADD CONSTRAINT employees_role_check CHECK (role IN ('admin', 'member'));

-- ---------- 2. Normalize existing email data before constraining it ---
-- '' and whitespace-only become NULL; everything else is lowercased/trimmed.
-- Your four employees already have clean emails (confirmed via preflight), so
-- this is a no-op today — it exists for whoever gets added next.
UPDATE employees
   SET email = NULLIF(lower(btrim(email)), '')
 WHERE email IS DISTINCT FROM NULLIF(lower(btrim(email)), '');

-- Stop the '' default so a future blank employee reads as NULL from the start.
ALTER TABLE employees ALTER COLUMN email DROP DEFAULT;

-- ---------- 3. Keep it normalized going forward ------------------------
-- The deployed app writes `email: emp.email || ''` today (a blank email saves
-- as '', not NULL). Without this trigger, the SECOND employee ever saved with
-- a blank email would collide with the unique index below. The database fixes
-- it up so the existing frontend keeps working unmodified.
CREATE OR REPLACE FUNCTION employees_normalize_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.email := NULLIF(lower(btrim(NEW.email)), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_normalize_email_trg ON employees;
CREATE TRIGGER employees_normalize_email_trg
  BEFORE INSERT OR UPDATE OF email ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_normalize_email();

-- ---------- 4. Constraints ---------------------------------------------
-- Partial indexes (WHERE ... IS NOT NULL) so blank-as-NULL rows never collide
-- with each other, and so an employee with no login (user_id NULL) never
-- collides with another employee who also has no login.
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_unique
  ON employees (lower(email)) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employees_user_id_unique
  ON employees (user_id) WHERE user_id IS NOT NULL;

-- Shape check only, and NOT VALID so it can never fail against existing rows.
-- (Run `ALTER TABLE employees VALIDATE CONSTRAINT employees_email_shape_check;`
-- later, any time, once you're ready to enforce it retroactively too.)
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_email_shape_check;
ALTER TABLE employees
  ADD CONSTRAINT employees_email_shape_check
  CHECK (email IS NULL OR email LIKE '%_@_%.%') NOT VALID;

-- Every RLS policy in Stage B will filter tasks by assigned_to — this index is
-- what keeps those checks cheap once there are hundreds of rows.
CREATE INDEX IF NOT EXISTS tasks_assigned_to_idx ON tasks (assigned_to);

-- ---------- 5. Link (or create) an employee row for each new login -----
-- Fires when you add someone in Authentication -> Users. Links to an existing
-- employees row by email if one matches; otherwise creates one, so a
-- mistyped-but-plausible email doesn't leave someone signed in with nothing to
-- link to (the "Account not set up yet" screen is still there as a fallback,
-- and you can just delete a wrongly-created row from Team & Websites).
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(NEW.email)), '');
  v_name  TEXT;
  v_emp   UUID;
BEGIN
  IF v_email IS NULL THEN RETURN NEW; END IF;

  v_name := COALESCE(NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
                      split_part(v_email, '@', 1));

  SELECT id INTO v_emp FROM employees WHERE email = v_email ORDER BY created_at LIMIT 1;

  IF v_emp IS NOT NULL THEN
    UPDATE employees SET user_id = NEW.id WHERE id = v_emp AND user_id IS NULL;
  ELSE
    INSERT INTO employees (name, designation, email, user_id)
    VALUES (v_name, '', v_email, NEW.id);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a problem here block "Add user" in the dashboard from working.
  RAISE WARNING 'handle_new_auth_user failed for %: %', v_email, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- ---------- 6. One-time backfill for the login you already created -----
-- ajaykumar.k@ifluids.com was created before this trigger existed, so it
-- needs linking by hand, once. Anyone you add after this point is linked
-- automatically by the trigger above.
UPDATE employees e
   SET user_id = u.id
  FROM auth.users u
 WHERE e.user_id IS NULL
   AND e.email IS NOT NULL
   AND e.email = lower(btrim(u.email));

COMMIT;

-- ---------- Verify, after COMMIT --------------------------------------
-- Expect one row per employee who has signed in, each with user_id filled in.
SELECT e.name, e.email, e.role, e.user_id, u.email AS auth_email
FROM employees e
LEFT JOIN auth.users u ON u.id = e.user_id
ORDER BY e.created_at;
