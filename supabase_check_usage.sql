-- =============================================================
-- HOW MUCH SPACE ARE WE USING?
-- Read-only — safe to run any time, changes nothing.
--
-- Paste into the Supabase SQL Editor and run. This reports the DATABASE size
-- only. The other free-tier limits (file storage, bandwidth, monthly active
-- users) are not visible from SQL — see the dashboard path in the notes at the
-- bottom of this file.
-- =============================================================

-- ---------- 1. Total database size ----------------------------------------
-- This is the number to compare against the free tier's database allowance.
-- Note it includes Postgres' own system catalogs and the auth/storage
-- schemas, so a brand-new empty project is never 0 — expect a baseline of
-- tens of MB before any of your own rows exist.
SELECT pg_size_pretty(pg_database_size(current_database())) AS total_database_size;

-- ---------- 2. Where that space actually goes ------------------------------
-- Our own tables, biggest first. total_size includes indexes and TOAST
-- (out-of-line storage for long text such as lead messages), which is why it
-- can be several times the raw row data.
SELECT
  relname                                        AS table_name,
  n_live_tup                                     AS approx_rows,
  pg_size_pretty(pg_relation_size(relid))        AS table_only,
  pg_size_pretty(pg_indexes_size(relid))         AS indexes,
  pg_size_pretty(pg_total_relation_size(relid))  AS total_size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC;

-- ---------- 3. Same thing across every schema, including Supabase's own ----
-- Useful for seeing whether the bulk is your data or the platform's
-- (auth, storage, realtime).
SELECT
  schemaname,
  pg_size_pretty(sum(pg_total_relation_size(relid))) AS total_size
FROM pg_stat_all_tables
GROUP BY schemaname
ORDER BY sum(pg_total_relation_size(relid)) DESC
LIMIT 10;

-- ---------- 4. Row counts for our own tables -------------------------------
-- Exact counts (the n_live_tup above is an estimate maintained by ANALYZE).
SELECT 'employees' AS table_name, count(*) AS exact_rows FROM employees
UNION ALL SELECT 'websites', count(*) FROM websites
UNION ALL SELECT 'tasks',    count(*) FROM tasks
UNION ALL SELECT 'leads',    count(*) FROM leads
ORDER BY exact_rows DESC;

-- =============================================================
-- WHAT SQL CANNOT TELL YOU — check these in the dashboard:
--   Organization → Usage        : database size, file storage, bandwidth (egress)
--                                 and monthly active users, each shown against
--                                 the plan's limit
--   Project → Reports → Database: size over time, so you can see the trend
--                                 rather than a single snapshot
--   Project → Settings → Billing: which plan this project is actually on
--
-- The free tier also pauses a project after a period with no activity. A
-- dashboard the team opens regularly will not hit that, but it is the limit
-- most likely to bite an unused project, not disk space.
-- =============================================================
