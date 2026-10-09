-- =============================================================
-- SELF-SERVICE SIGN-UP GATE
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Safe to run more than once.
--
-- WHAT THIS CHANGES: today, "Enable email provider" is one combined toggle
-- for both login AND public sign-up (confirmed from your dashboard screenshot
-- — there's no separate switch for just one of them). That means anyone with
-- the app's public key can currently call the sign-up API with any email at
-- all and create a login. Stage B already made sure that account would see
-- nothing once created, but nothing stopped the account from being created in
-- the first place.
--
-- This closes that, by turning sign-up into exactly the flow you described:
-- an administrator adds a person's name and email in Team & Websites first,
-- and only THEN can that exact email be used to create a password. Any other
-- email is rejected before any account is created — not just hidden data
-- afterward, an account is never created at all.
--
-- This applies uniformly to BOTH the app's self-service sign-up AND the
-- Supabase dashboard's own "Add user" button, since both go through the same
-- underlying auth.users insert. Practically: from now on, always add the
-- employee's email in Team & Websites BEFORE creating their login, whichever
-- way you create it. (This is a workflow change from how Ajaykumar's account
-- was set up — that one happened to be created before the email was added,
-- which is exactly the case this trigger now prevents.)
-- =============================================================
BEGIN;

CREATE OR REPLACE FUNCTION reject_unapproved_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(NEW.email)), '');
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'An email address is required.' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE email = v_email) THEN
    RAISE EXCEPTION 'This email has not been added by an administrator yet. Ask them to add you in Team & Websites first, using this exact email address.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE, not AFTER: this must run before the row is written, so a rejected
-- signup creates NO auth.users row at all — not a row that then gets cleaned
-- up, an account that was simply never created.
DROP TRIGGER IF EXISTS reject_unapproved_signup_trg ON auth.users;
CREATE TRIGGER reject_unapproved_signup_trg
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION reject_unapproved_signup();

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: the trigger listed, timing BEFORE.
SELECT tgname, tgrelid::regclass, tgtype,
       CASE WHEN tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
FROM pg_trigger
WHERE tgname = 'reject_unapproved_signup_trg';
