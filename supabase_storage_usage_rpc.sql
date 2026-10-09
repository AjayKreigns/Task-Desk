-- =============================================================
-- STORAGE USAGE — in-app view of database size (Settings tab)
-- Paste this whole script into the Supabase SQL Editor and run it.
-- Safe to run more than once.
--
-- WHY THIS EXISTS
-- The Supabase free tier caps database size (500MB at the time this was
-- written — Supabase can change this, so the app treats it as a soft,
-- easily-adjustable assumption, not a hardcoded truth). Checking usage
-- meant leaving the dashboard and digging through the Supabase project
-- itself every time — this exposes the same numbers `pg_database_size()`
-- already gives you, but as a small RPC the dashboard's Settings page can
-- call directly, so a glance at Team & Websites is enough.
--
-- WHY SECURITY DEFINER
-- pg_database_size()/pg_total_relation_size() are ordinary read-only
-- introspection functions — nothing here is sensitive, and no row content is
-- returned, only aggregate byte counts per table. SECURITY DEFINER is used
-- for consistency with this schema's other helper functions and so EXECUTE
-- can be granted explicitly to `authenticated` rather than relying on
-- whatever Postgres' default privilege on these functions happens to be.
-- =============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.get_storage_usage()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'total_bytes', pg_database_size(current_database()),
    'tables', (
      SELECT coalesce(jsonb_agg(t ORDER BY (t->>'bytes')::bigint DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'name', relname,
          'bytes', pg_total_relation_size(relid)
        ) AS t
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
      ) sub
    )
  )
$$;

REVOKE ALL ON FUNCTION public.get_storage_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_storage_usage() TO authenticated;

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect a real jsonb object back, total_bytes > 0, and a `tables` array
-- listing employees/websites/tasks/leads with plausible byte counts.
SELECT get_storage_usage();
