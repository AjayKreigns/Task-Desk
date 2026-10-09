-- =============================================================
-- LEAD CENTER — direct website intake (WordPress → Supabase, no email step)
-- Paste this whole script into the Supabase SQL Editor and run it.
-- Safe to run more than once. Run AFTER supabase_leads_dedup.sql and
-- supabase_leads_admin_only_writes.sql.
--
-- WHAT THIS ADDS
-- A single RPC function, ingest_website_lead(), that a WordPress snippet on
-- ifluids.com calls the moment someone submits the Fluent Forms enquiry form.
-- It inserts straight into `leads` — no export, no import, no weekly upload.
-- The existing dedup trigger and unique index apply exactly as they do to a
-- manual add or a spreadsheet import, so nothing about duplicate handling
-- changes.
--
-- WHY A SECRET RATHER THAN THE SERVICE ROLE KEY
-- The obvious way to let an external system insert rows is to hand it the
-- Supabase service_role key — but that key bypasses RLS entirely and can do
-- ANYTHING in this database (delete tasks, change roles, wipe every table).
-- Handing that to a WordPress plugin config is a large blast radius for one
-- small job. Instead, this function checks a private shared secret itself and
-- is the ONLY thing it can do — insert a well-formed lead. A leaked secret
-- lets someone submit fake enquiries; it cannot touch anything else.
--
-- WHY A LOCKED TABLE AND NOT A HARDCODED STRING IN THE FUNCTION
-- Keeping the secret in a table (rather than baked into the function body)
-- means rotating it later is just an UPDATE, not a redeploy. The table has
-- RLS enabled with NO policies at all — not even a permissive one — so anon
-- and authenticated can never read it through the API, full stop. Only a
-- SECURITY DEFINER function owned by postgres can see inside it, exactly the
-- same trust boundary current_employee_id()/is_admin() already rely on
-- elsewhere in this schema (see supabase_rls_policies.sql).
--
-- WHY EXECUTE IS GRANTED TO anon
-- WordPress has no Supabase Auth session — it's calling as an anonymous
-- client with just the public anon key, the same key already compiled into
-- the deployed dashboard. That's fine: the function's own secret check is
-- the real gate, not who is allowed to call it.
--
-- This script REFUSES TO COMMIT if its own built-in test fails (Step 4), so a
-- partial migration is never left behind — same convention as
-- supabase_leads_dedup.sql.
-- =============================================================
BEGIN;

-- ---------- Step 1: the secret, in a table nothing else can read -----------
CREATE TABLE IF NOT EXISTS lead_webhook_secret (
  id     boolean PRIMARY KEY DEFAULT true,
  secret text NOT NULL,
  CONSTRAINT lead_webhook_secret_singleton CHECK (id) -- only one row can ever exist
);
ALTER TABLE lead_webhook_secret ENABLE ROW LEVEL SECURITY;
-- Deliberately no CREATE POLICY of any kind here. With RLS on and zero
-- policies, Postgres denies every row to anon/authenticated by default — the
-- function below reads it anyway because SECURITY DEFINER functions run as
-- their owner (postgres), which has BYPASSRLS.

-- Sets the secret. Change the string below any time you want to rotate it —
-- re-running this script updates it in place. The value shipped here was
-- generated fresh for this: T6cdeMC6lGJNc0l5mSj1lDP4XnIAkd9zqq8dMSQz5vM
-- (also given to you separately — put it in the WordPress snippet, nowhere else).
INSERT INTO lead_webhook_secret (id, secret)
VALUES (true, 'T6cdeMC6lGJNc0l5mSj1lDP4XnIAkd9zqq8dMSQz5vM')
ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret;

-- ---------- Step 2: the intake function -------------------------------------
-- Every argument defaults to '' so a WordPress form missing one field (say,
-- no Company field on a particular form) never causes the whole call to fail
-- — it just lands as blank, same as a manual entry with that field left empty.
CREATE OR REPLACE FUNCTION public.ingest_website_lead(
  p_secret      TEXT,
  p_name        TEXT DEFAULT '',
  p_company     TEXT DEFAULT '',
  p_email       TEXT DEFAULT '',
  p_phone       TEXT DEFAULT '',
  p_message     TEXT DEFAULT '',
  p_confirm     TEXT DEFAULT '',
  p_source_url  TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expected TEXT;
  v_id       UUID;
BEGIN
  SELECT secret INTO v_expected FROM lead_webhook_secret WHERE id = true;

  IF v_expected IS NULL OR p_secret IS DISTINCT FROM v_expected THEN
    -- 28000 = invalid_authorization_specification. Whatever HTTP status
    -- PostgREST maps that to, it is always an error response, never a
    -- silent success — the caller (WordPress) can tell the insert did not
    -- happen and that is the only property that actually matters here.
    RAISE EXCEPTION 'ingest_website_lead: invalid secret' USING ERRCODE = '28000';
  END IF;

  -- ON CONFLICT (dedup_key) DO NOTHING — the same unique index that already
  -- protects manual entry and spreadsheet import protects this path too. A
  -- form resubmission (a nervous double-click, a page refresh) is silently
  -- absorbed rather than creating a second row.
  --
  -- btrim(coalesce(p_x, '')) — NEVER nullif(..., ''). Every column in `leads`
  -- is NOT NULL DEFAULT '' specifically so blank fields compare equal (see
  -- supabase_leads_table.sql's own comment: NULL never equals NULL in
  -- Postgres, so a nullable column would let "blank company" rows duplicate
  -- forever). A first version of this function used nullif() here, which
  -- turns a blank field into NULL — violating that NOT NULL constraint the
  -- moment any field (company, phone, whatever a given form lacks) was left
  -- empty. Caught by the self-test below failing on the very first run.
  INSERT INTO leads (name, company, email, phone, message, confirm, source_url, created_at)
  VALUES (
    btrim(coalesce(p_name, '')), btrim(coalesce(p_company, '')), btrim(coalesce(p_email, '')),
    btrim(coalesce(p_phone, '')), btrim(coalesce(p_message, '')), btrim(coalesce(p_confirm, '')),
    btrim(coalesce(p_source_url, '')), now()
  )
  ON CONFLICT (dedup_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'inserted', v_id IS NOT NULL, 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_website_lead(text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_website_lead(text,text,text,text,text,text,text,text) TO anon, authenticated;

-- ---------- Step 3: proves the whole thing works before committing ---------
-- Mirrors supabase_leads_dedup.sql's self-test: if any assertion below fails,
-- this RAISEs and the entire transaction rolls back — nothing partially
-- applied, nothing left in a broken state.
DO $$
DECLARE
  v_real_secret TEXT;
  v_result      jsonb;
  v_count       INT;
  v_rejected    BOOLEAN := false;
BEGIN
  SELECT secret INTO v_real_secret FROM lead_webhook_secret WHERE id = true;

  -- 1. A correct call inserts a row.
  v_result := ingest_website_lead(
    v_real_secret, '__webhook_selftest__', 'Test Co', 'webhooktest@example.invalid',
    '+10000000000', 'self test enquiry via webhook', '', 'https://ifluids.com/contact-us/'
  );
  IF NOT (v_result->>'ok')::boolean OR NOT (v_result->>'inserted')::boolean THEN
    RAISE EXCEPTION 'Webhook self-test FAILED: first call did not insert. Got %. Rolling back.', v_result;
  END IF;

  -- 2. The identical enquiry again (same email+message+day) must be silently
  --    deduped, not inserted a second time — proves this path shares the same
  --    protection as manual entry and spreadsheet import.
  v_result := ingest_website_lead(
    v_real_secret, '__webhook_selftest__', 'Test Co', 'webhooktest@example.invalid',
    '+10000000000', 'self test enquiry via webhook', '', 'https://ifluids.com/contact-us/'
  );
  IF (v_result->>'inserted')::boolean THEN
    RAISE EXCEPTION 'Webhook self-test FAILED: a duplicate call inserted a second row. Rolling back.';
  END IF;

  SELECT count(*) INTO v_count FROM leads WHERE name = '__webhook_selftest__';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Webhook self-test FAILED: expected exactly 1 row, found %. Rolling back.', v_count;
  END IF;

  -- 3. A wrong secret must be rejected, not silently accepted.
  BEGIN
    PERFORM ingest_website_lead('this-is-the-wrong-secret', '__webhook_selftest_bad__');
  EXCEPTION WHEN OTHERS THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Webhook self-test FAILED: a call with the WRONG secret was not rejected. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM leads WHERE name = '__webhook_selftest_bad__') THEN
    RAISE EXCEPTION 'Webhook self-test FAILED: a wrong-secret call still inserted a row. Rolling back.';
  END IF;

  -- Clean up the test rows either way — this only runs if every assertion
  -- above passed, since a RAISE anywhere above aborts the transaction first.
  DELETE FROM leads WHERE name IN ('__webhook_selftest__', '__webhook_selftest_bad__');

  RAISE NOTICE 'Webhook self-test passed: valid secret inserts, duplicate calls are deduped, wrong secret is rejected and inserts nothing.';
END $$;

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: the function listed, EXECUTE granted to anon and authenticated only.
SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'ingest_website_lead'
ORDER BY grantee;

-- Expect: 0 rows — the self-test rows were cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM leads
WHERE name IN ('__webhook_selftest__', '__webhook_selftest_bad__');

-- Expect: exactly 1 row, RLS enabled, and — because no policy was created —
-- this table has no entries in pg_policies at all for anon/authenticated to
-- use, meaning the secret cannot be read through the REST API by anyone.
SELECT count(*) AS secret_row_count FROM lead_webhook_secret;
SELECT relrowsecurity FROM pg_class WHERE relname = 'lead_webhook_secret';
