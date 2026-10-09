-- =============================================================
-- STAGE A PREFLIGHT — read-only, safe to run anytime
-- Paste this whole script into the Supabase SQL Editor and run it BEFORE
-- supabase_auth_migration.sql. It changes nothing; it only reports.
--
-- What to look for: sections (a) and (c) below should return ZERO rows.
-- As of the last check on this project they did — every employee already has
-- a clean, unique, lowercase email — but re-run this if you add more people
-- before applying the migration below.
-- =============================================================

-- (a) Real duplicate emails. THE MIGRATION WILL FAIL if this returns any rows —
--     fix them by hand in Team & Websites first (two people cannot legitimately
--     share a login identity).
SELECT lower(btrim(email)) AS normalized_email,
       count(*)            AS rows,
       array_agg(id)       AS employee_ids,
       array_agg(name)     AS names
FROM employees
WHERE btrim(coalesce(email, '')) <> ''
GROUP BY 1
HAVING count(*) > 1;

-- (b) Blank/missing emails. NOT a blocker — the migration turns '' into NULL,
--     and NULL never collides with anything. These people simply can't sign in
--     until an email is added for them (see Team & Websites).
SELECT id, name, designation, quote_literal(coalesce(email, '<null>')) AS email
FROM employees
WHERE btrim(coalesce(email, '')) = '';

-- (c) Emails with stray case or whitespace. Not a blocker either — the
--     migration normalizes these in place — but worth a glance.
SELECT id, name, quote_literal(email) AS email_as_stored
FROM employees
WHERE email IS NOT NULL AND email <> lower(btrim(email));

-- (d) Auth users (people who can sign in) with no employees row to link to yet.
--     Expected to be empty right after you create someone's login and before
--     you've added their email in Team & Websites — that's the exact
--     "Account not set up yet" screen you just worked through.
SELECT u.id AS auth_user_id, u.email, u.created_at
FROM auth.users u
LEFT JOIN employees e ON lower(btrim(e.email)) = lower(btrim(u.email))
WHERE e.id IS NULL;

-- (e) Employees with no auth login. Normal and expected for anyone who doesn't
--     need dashboard access — they still work fine as an assignable team member.
SELECT e.id, e.name, e.email
FROM employees e
LEFT JOIN auth.users u ON lower(btrim(u.email)) = lower(btrim(e.email))
WHERE u.id IS NULL;

-- (f) Confirms the migration's owner-exemption trick will work later (for
--     Stage B, not this stage) — relrowsecurity should be true and
--     relforcerowsecurity should be FALSE for all three tables.
SELECT relname, relowner::regrole AS owner, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname IN ('employees', 'websites', 'tasks');
