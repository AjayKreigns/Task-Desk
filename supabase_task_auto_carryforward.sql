-- =============================================================
-- SCHEDULE — automatic carry-forward of incomplete tasks
-- Paste this whole script into the Supabase SQL Editor and run it.
-- Safe to run more than once. Requires the pg_cron extension (Database →
-- Extensions → search "pg_cron" → enable — confirmed available on Free).
--
-- WHAT THIS ADDS
-- On the 4th of every month, any task still 'pending' from the month that
-- just ended gets carried forward into the new month automatically — using
-- the EXACT SAME mechanism as the existing manual "Carry Forward" button in
-- Schedule.jsx (clone into next month, link both tasks via
-- carry_forward_from/carry_forward_to, leave the original untouched in its
-- own month). This does not replace that button; a task can still be
-- carried forward manually at any time, and the automated job simply skips
-- anything that already has carry_forward_to set — whether that happened by
-- someone's click or by a previous run of this same job.
--
-- WHY A SCHEDULED DATABASE FUNCTION, NOT SOMETHING THE APP TRIGGERS
-- This must happen on the calendar date regardless of whether anyone opens
-- the dashboard that day — the same "real enforcement, not UI-dependent
-- luck" reasoning already used for RLS and lead deduplication elsewhere in
-- this schema. pg_cron runs inside Postgres itself, independent of the app.
--
-- WHY A NEW carry_forward_batch COLUMN
-- The app's notification system is entirely per-browser (localStorage), with
-- no server-side notification table. So the app has to detect for itself,
-- next time someone opens it, "were any of my tasks just auto-carried
-- forward, and have I already been told?" It can't tell that apart from an
-- ordinary MANUAL carry-forward using only carry_forward_from/to, since
-- those are identical either way. carry_forward_batch is set to today's date
-- ONLY by this automated function — NULL for a manual carry-forward — so the
-- app can distinguish "auto, and which run" from "manual, already notified
-- at click-time" without needing a whole new notifications table.
--
-- This script REFUSES TO COMMIT if its own built-in test fails (Step 4), so
-- a partial migration is never left behind — same convention as
-- supabase_leads_dedup.sql.
-- =============================================================
BEGIN;

-- ---------- Step 1: the batch marker column ---------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS carry_forward_batch DATE;

-- ---------- Step 2: the carry-forward function -------------------------
-- p_month/p_year let a caller target a specific month instead of "last
-- calendar month" — used ONLY by the self-test below (Step 4), so it can
-- exercise this exact function against a sentinel month/year that no real
-- task will ever have, instead of operating on real production data. The
-- real pg_cron schedule in Step 3 always calls this with no arguments.
--
-- A zero-argument version of this function may already exist from an
-- earlier run of this script, before p_month/p_year were added. Postgres
-- treats that as a DIFFERENT overload from the two-argument version below
-- (CREATE OR REPLACE only replaces an exact signature match), so without
-- this explicit drop both would exist side by side — risking "function is
-- not unique" the next time anything calls this by name with no arguments.
DROP FUNCTION IF EXISTS public.auto_carry_forward_tasks();

CREATE OR REPLACE FUNCTION public.auto_carry_forward_tasks(
  p_month INT DEFAULT NULL,
  p_year  INT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last_month INT;
  v_last_year  INT;
  v_batch      DATE := CURRENT_DATE;
  v_task       RECORD;
  v_new_id     UUID;
  v_next_month INT;
  v_next_year  INT;
  v_progress   INT;
  v_count      INT := 0;
BEGIN
  -- The month that just ended, computed via date arithmetic (not "days ago")
  -- so 28/29/30/31-day months are all handled correctly without special-casing.
  -- Overridden by p_month/p_year when the caller passes them explicitly.
  v_last_month := COALESCE(p_month, EXTRACT(MONTH FROM (CURRENT_DATE - INTERVAL '1 month'))::INT);
  v_last_year  := COALESCE(p_year,  EXTRACT(YEAR  FROM (CURRENT_DATE - INTERVAL '1 month'))::INT);

  FOR v_task IN
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND month = v_last_month
      AND year = v_last_year
      AND carry_forward_to IS NULL
  LOOP
    v_next_month := v_task.month + 1;
    v_next_year  := v_task.year;
    IF v_next_month > 12 THEN
      v_next_month := 1;
      v_next_year := v_next_year + 1;
    END IF;

    -- Mirrors getTaskPercent() in src/lib/taskProgress.js exactly: 0 if
    -- nothing was targeted, otherwise taken/targeted capped at 100. Not a
    -- copy of the original row's stored progress — targeted_time/time_taken
    -- carry over unchanged (matching the client's own handleCarryForward,
    -- which spreads the original task and only overrides completion-related
    -- fields), so progress is recomputed from those same carried-over values
    -- rather than assumed to reset to 0.
    v_progress := COALESCE(
      LEAST(ROUND(COALESCE(v_task.time_taken, 0) / NULLIF(v_task.targeted_time, 0) * 100), 100),
      0
    );

    INSERT INTO tasks (
      title, category, assigned_to, website_id, priority, status, progress,
      reference_url, completion_url, completed_date, month, year,
      is_additional, carry_forward_from, carry_forward_to, carry_forward_batch,
      targeted_time, time_taken
    ) VALUES (
      CASE WHEN v_task.title LIKE '%(Carry Forwarded)%' THEN v_task.title ELSE v_task.title || ' (Carry Forwarded)' END,
      v_task.category, v_task.assigned_to, v_task.website_id, v_task.priority, 'pending', v_progress,
      v_task.reference_url, '', NULL, v_next_month, v_next_year,
      v_task.is_additional, v_task.id, NULL, v_batch,
      v_task.targeted_time, v_task.time_taken
    )
    RETURNING id INTO v_new_id;

    UPDATE tasks SET carry_forward_to = v_new_id WHERE id = v_task.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'batch', v_batch,
    'carried_forward_count', v_count,
    'from_month', v_last_month,
    'from_year', v_last_year
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_carry_forward_tasks(INT, INT) FROM PUBLIC;
-- No GRANT to anon/authenticated at all — this is invoked only by pg_cron,
-- never by the app or any REST caller. SECURITY DEFINER lets it write to
-- tasks regardless of RLS, the same trust boundary every other SECURITY
-- DEFINER function in this schema already relies on.

-- ---------- Step 3: schedule it for the 4th of every month -------------
-- 02:00 UTC = 07:30 IST — before the team's typical start of day, so the
-- carried-forward state is already settled by the time anyone logs in.
-- pg_cron schedules run in UTC regardless of the project's display timezone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-carry-forward-tasks') THEN
    PERFORM cron.unschedule('auto-carry-forward-tasks');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-carry-forward-tasks',
  '0 2 4 * *',
  $$SELECT public.auto_carry_forward_tasks();$$
);

-- ---------- Step 4: prove it actually works before committing -----------
-- Plants a fake "incomplete task", runs the function, and checks every
-- property that matters — then runs it a SECOND time to prove idempotency
-- (an already-forwarded task must never be forwarded again, whether
-- re-run by accident or because pg_cron somehow double-fires) — before
-- cleaning up. If any assertion fails this RAISEs and the whole transaction
-- (including the column and the schedule above) rolls back.
--
-- WHY A SENTINEL month/year INSTEAD OF "LAST CALENDAR MONTH"
-- auto_carry_forward_tasks() processes EVERY row matching the month/year it
-- is given, not just our fake row. Calling it here with the real "last
-- month" — as an earlier version of this script did — would also carry
-- forward any genuinely-pending real task from last month RIGHT NOW,
-- regardless of the cron schedule's actual date. Not a hypothetical: this
-- is exactly what happened in production the first time this script was
-- re-run. Passing an explicit sentinel month/year that no real task will
-- ever have (month 1 of year 1900) keeps the self-test fully isolated to
-- its own fake row, so a plain DELETE at the end is genuinely sufficient
-- cleanup — nothing real is ever touched.
DO $$
DECLARE
  v_test_month CONSTANT INT := 1;
  v_test_year  CONSTANT INT := 1900;
  v_orig_id    UUID;
  v_result     jsonb;
  v_clone      RECORD;
  v_count      INT;
BEGIN
  INSERT INTO tasks (title, month, year, status, targeted_time, time_taken)
  VALUES ('__autocarryforward_selftest__', v_test_month, v_test_year, 'pending', 10, 4)
  RETURNING id INTO v_orig_id;

  v_result := auto_carry_forward_tasks(v_test_month, v_test_year);

  SELECT * INTO v_clone FROM tasks WHERE carry_forward_from = v_orig_id;
  IF v_clone IS NULL THEN
    RAISE EXCEPTION 'Carry-forward self-test FAILED: no clone was created for the test task. Rolling back.';
  END IF;

  IF v_clone.status <> 'pending' OR v_clone.completed_date IS NOT NULL OR v_clone.completion_url <> '' THEN
    RAISE EXCEPTION 'Carry-forward self-test FAILED: clone did not reset status/completion fields correctly. Rolling back.';
  END IF;

  IF v_clone.progress <> 40 THEN -- 4/10 * 100, matching getTaskPercent()
    RAISE EXCEPTION 'Carry-forward self-test FAILED: expected progress 40, got %. Rolling back.', v_clone.progress;
  END IF;

  IF v_clone.carry_forward_batch IS DISTINCT FROM CURRENT_DATE THEN
    RAISE EXCEPTION 'Carry-forward self-test FAILED: clone''s carry_forward_batch was not set to today. Rolling back.';
  END IF;

  IF (SELECT carry_forward_to FROM tasks WHERE id = v_orig_id) IS DISTINCT FROM v_clone.id THEN
    RAISE EXCEPTION 'Carry-forward self-test FAILED: original task''s carry_forward_to was not linked back. Rolling back.';
  END IF;

  -- Idempotency: running it again must not create a second clone, since the
  -- original now has carry_forward_to set. Same sentinel month/year as
  -- above — this second call must stay just as isolated as the first.
  PERFORM auto_carry_forward_tasks(v_test_month, v_test_year);
  SELECT count(*) INTO v_count FROM tasks WHERE carry_forward_from = v_orig_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Carry-forward self-test FAILED: re-running created % clones instead of staying at 1. Rolling back.', v_count;
  END IF;

  -- Both calls above only ever touched the sentinel month/year, so a plain
  -- delete of the two known test ids is genuinely sufficient cleanup here.
  DELETE FROM tasks WHERE id IN (v_orig_id, v_clone.id);

  RAISE NOTICE 'Carry-forward self-test passed: clone created correctly (status/progress/batch/link), and re-running the function did not create a duplicate.';
END $$;

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect the job listed, scheduled '0 2 4 * *', active = true.
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'auto-carry-forward-tasks';

-- Expect 0 — the self-test's rows were cleaned up.
SELECT count(*) AS selftest_rows_remaining FROM tasks WHERE title = '__autocarryforward_selftest__';
