-- =============================================================
-- CATEGORIES TABLE — multi-team schema, step 3 of 4
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Run AFTER supabase_teams_foundation.sql and
-- supabase_teams_rls.sql (needs teams/is_team_admin()/is_same_team() to exist).
--
-- WHY THIS EXISTS
-- Categories have never actually lived in the database — `customCategories`/
-- `categoryColors`/`hiddenCategories` in AppContext.jsx are plain browser
-- localStorage, never synced to Supabase at all. "A team lead creates
-- categories their own employees can see" cannot work today, since nothing
-- syncs even within one team's own browsers. This table is what makes that
-- real, and — necessarily — per-team: two different teams must each be able
-- to have their own "Design" category without colliding.
--
-- WHY DIGITAL MARKETING GETS A SEED BUT NO OTHER TEAM DOES
-- Digital Marketing already has real tasks using its existing category names
-- (today's DEFAULT_CATEGORIES + CATEGORY_PALETTE in src/lib/categories.js),
-- so its own rows below backfill exactly that set — nothing here is inherited
-- from a true "default team" concept. A brand-new team created afterward
-- (create_team_with_admin() in supabase_teams_admin_rpc.sql) deliberately
-- starts with zero categories instead: Digital Marketing's category set is
-- specific to its own work, not a sensible generic starting point for an
-- unrelated team (confirmed with the user after testing a real second team).
--
-- default_category_seed() still exists as its own function purely so this
-- backfill has a single place listing "Digital Marketing's starting set" —
-- it is no longer called from anywhere else.
--
-- Re-runnable: every statement drops-then-creates, so running this twice is
-- safe and changes nothing the second time.
-- =============================================================
BEGIN;

-- ---------- 1. The default seed, as one shared function ------------------
-- Mirrors DEFAULT_CATEGORIES + the first 11 entries of CATEGORY_PALETTE in
-- src/lib/categories.js exactly, paired in the same order.
CREATE OR REPLACE FUNCTION default_category_seed()
RETURNS TABLE(name TEXT, color TEXT)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT * FROM (VALUES
    ('SEO - New Content',     '#7c3aed'),
    ('SEO - Rewrite Content', '#0284c7'),
    ('Content Marketing',     '#059669'),
    ('Social Media',          '#d97706'),
    ('PPC / Ads',             '#db2777'),
    ('Email Marketing',       '#e11d48'),
    ('Web Development',       '#4f46e5'),
    ('Analytics',             '#0891b2'),
    ('Design',                '#65a30d'),
    ('Reviewed',              '#ea580c'),
    ('Other',                 '#9333ea')
  ) AS t(name, color);
$$;

GRANT EXECUTE ON FUNCTION default_category_seed() TO authenticated;

-- ---------- 2. categories table -------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  hidden     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-team, not global — two different teams must each be able to have a
-- "Design" category.
CREATE UNIQUE INDEX IF NOT EXISTS categories_team_name_unique
  ON categories (team_id, lower(name));

CREATE INDEX IF NOT EXISTS categories_team_id_idx ON categories (team_id);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories REPLICA IDENTITY FULL; -- SELECT policy references team_id, a row column — same reasoning as employees/websites in supabase_teams_rls.sql

REVOKE ALL ON categories FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO authenticated;

DROP POLICY IF EXISTS categories_select_authenticated ON categories;
CREATE POLICY categories_select_authenticated ON categories
  FOR SELECT TO authenticated
  USING ((select is_super_admin()) OR is_same_team(team_id));

DROP POLICY IF EXISTS categories_insert_admin ON categories;
CREATE POLICY categories_insert_admin ON categories
  FOR INSERT TO authenticated WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS categories_update_admin ON categories;
CREATE POLICY categories_update_admin ON categories
  FOR UPDATE TO authenticated
  USING ((select is_team_admin(team_id))) WITH CHECK ((select is_team_admin(team_id)));

DROP POLICY IF EXISTS categories_delete_admin ON categories;
CREATE POLICY categories_delete_admin ON categories
  FOR DELETE TO authenticated USING ((select is_team_admin(team_id)));

-- ---------- 3. Backfill Digital Marketing's category set -----------------
DO $$
DECLARE v_dm_team_id UUID;
BEGIN
  SELECT id INTO v_dm_team_id FROM teams WHERE name = 'Digital Marketing';

  INSERT INTO categories (team_id, name, color)
  SELECT v_dm_team_id, s.name, s.color FROM default_category_seed() s
  ON CONFLICT (team_id, lower(name)) DO NOTHING;

  -- Any real task's category not already covered by the seed above, so no
  -- existing task is left pointing at an undefined category after the
  -- localStorage -> table cutover. Colors cycle through the rest of
  -- CATEGORY_PALETTE (src/lib/categories.js), offset past the 11 the seed
  -- above already used.
  INSERT INTO categories (team_id, name, color)
  SELECT
    v_dm_team_id,
    t.category,
    (ARRAY['#e11d48','#4f46e5','#0891b2','#65a30d','#ea580c','#9333ea','#0d9488',
           '#475569','#c026d3','#2563eb','#16a34a','#ca8a04','#dc2626','#7e22ce',
           '#0369a1','#be123c','#15803d','#a16207','#1d4ed8'])
      [1 + ((row_number() OVER (ORDER BY t.category) - 1) % 19)]
  FROM (SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL AND category <> '') t
  WHERE NOT EXISTS (
    SELECT 1 FROM categories c WHERE c.team_id = v_dm_team_id AND lower(c.name) = lower(t.category)
  )
  ON CONFLICT (team_id, lower(name)) DO NOTHING;
END $$;

COMMIT;

-- ---------- Self-test, as its own transaction ----------------------------
BEGIN;
DO $$
DECLARE
  v_team_a UUID; v_team_b UUID;
  v_a_admin UUID; v_a_member UUID;
  v_b_admin UUID;
  v_count INT; v_row_count INT;
BEGIN
  INSERT INTO teams (name) VALUES ('__selftest_cat_team_a__') RETURNING id INTO v_team_a;
  INSERT INTO teams (name) VALUES ('__selftest_cat_team_b__') RETURNING id INTO v_team_b;

  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_cat_a_admin__', 'QA', 'st-cat-a-admin@example.invalid', 'admin', v_team_a) RETURNING id INTO v_a_admin;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_cat_a_member__', 'QA', 'st-cat-a-member@example.invalid', 'member', v_team_a) RETURNING id INTO v_a_member;
  INSERT INTO employees (name, designation, email, role, team_id)
    VALUES ('__st_cat_b_admin__', 'QA', 'st-cat-b-admin@example.invalid', 'admin', v_team_b) RETURNING id INTO v_b_admin;

  INSERT INTO categories (team_id, name, color) VALUES (v_team_a, '__SelftestCat__', '#111111');
  INSERT INTO categories (team_id, name, color) VALUES (v_team_b, '__SelftestCat__', '#222222');

  -- ---- As Team A's admin ----
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-cat-a-admin@example.invalid')::text, true);

  SELECT count(*) INTO v_count FROM categories WHERE team_id = v_team_a;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin should see Team A''s own category, saw %.', v_count; END IF;
  SELECT count(*) INTO v_count FROM categories WHERE team_id = v_team_b;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: Team A admin could see Team B''s category.'; END IF;

  -- Member cannot write (silent 0-row filter, not an exception).
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-cat-a-member@example.invalid')::text, true);
  UPDATE categories SET color = '#ffffff' WHERE team_id = v_team_a;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN RAISE EXCEPTION 'Self-test FAILED: a plain member was able to update a category (% rows).', v_row_count; END IF;

  -- Same category NAME must be independently fine across two different
  -- teams (already proven by the two inserts above succeeding during setup)
  -- but rejected twice within the SAME team.
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', 'st-cat-a-admin@example.invalid')::text, true);
  BEGIN
    INSERT INTO categories (team_id, name, color) VALUES (v_team_a, '__SelftestCat__', '#333333');
    RAISE EXCEPTION 'Self-test FAILED: the same category name was allowed twice within one team.';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;

  RAISE NOTICE 'Categories self-test passed: cross-team read isolation, member write-block, and per-team (not global) name uniqueness all confirmed.';

  EXECUTE 'RESET ROLE';
  DELETE FROM categories WHERE team_id IN (v_team_a, v_team_b);
  -- Trigger disabled for this one DELETE: v_a_admin and v_b_admin are each
  -- the ONLY admin of their own fixture team, so guard_employee_role_changes()
  -- (supabase_teams_rls.sql) always blocks deleting either of them on its
  -- own "last admin of this team" check — deterministically, not just a
  -- multi-row ordering edge case, since each team never had a second admin
  -- fixture to begin with. Teardown of fixture data isn't what that guard
  -- exists to protect, so it's bypassed here rather than worked around by
  -- adding an unnecessary second admin fixture per team.
  ALTER TABLE employees DISABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM employees WHERE id IN (v_a_admin, v_a_member, v_b_admin);
  ALTER TABLE employees ENABLE TRIGGER employees_role_change_guard_trg;
  DELETE FROM teams WHERE id IN (v_team_a, v_team_b);
END $$;
COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: no rows — every fixture cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM categories WHERE name LIKE '__Selftest%';

-- Expect: 11+ rows, one per Digital Marketing category (built-ins plus any
-- real task category that wasn't already in the default set).
SELECT c.name, c.color FROM categories c
JOIN teams t ON t.id = c.team_id AND t.name = 'Digital Marketing'
ORDER BY c.name;
