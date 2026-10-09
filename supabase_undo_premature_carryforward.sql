-- =============================================================
-- UNDO — the accidental early carry-forward run caused by re-running
-- supabase_task_auto_carryforward.sql's self-test (Step 4) against a live
-- database that already had genuinely-pending tasks from last month. That
-- self-test called the real auto_carry_forward_tasks() function, which has
-- no "test mode" — it processed every real matching task, not just its own
-- fake row, carrying them forward for real, days before the intended
-- schedule. The script has since been fixed (the self-test now runs inside
-- a SAVEPOINT that gets rolled back) so this cannot happen again on a
-- future re-run — this script only cleans up the one bad run that already
-- committed.
--
-- HOW TO USE
-- 1. Run the SELECT below first and read its output. Confirm the rows
--    listed match the tasks you saw wrongly marked "(Carry Forwarded)" /
--    prompting the "Tasks Carried Forward" modal.
-- 2. Only then run the BEGIN...COMMIT block underneath it.
-- =============================================================

-- ---------- Step 1: preview what this will undo -------------------------
SELECT
  orig.id    AS original_id,
  orig.title AS original_title,
  orig.month AS original_month,
  orig.year  AS original_year,
  clone.id    AS clone_id,
  clone.title AS clone_title,
  clone.month AS clone_month,
  clone.year  AS clone_year,
  clone.carry_forward_batch
FROM tasks clone
JOIN tasks orig ON orig.id = clone.carry_forward_from
WHERE clone.carry_forward_batch = CURRENT_DATE
ORDER BY orig.title;

-- ---------- Step 2: undo it ----------------------------------------------
-- Only the clones created TODAY by the accidental run are touched
-- (carry_forward_batch = CURRENT_DATE is set only by the automated
-- function, never by a manual Carry Forward click, and today is the only
-- date it has ever actually run) — this will not touch any manual
-- carry-forward or any future real run on a later date.
BEGIN;

-- Unlink the originals first, so they go back to plain, unlinked 'pending'
-- tasks in their own month — eligible again for the real run on the 4th.
UPDATE tasks
SET carry_forward_to = NULL
WHERE id IN (
  SELECT carry_forward_from
  FROM tasks
  WHERE carry_forward_batch = CURRENT_DATE
    AND carry_forward_from IS NOT NULL
);

DELETE FROM tasks
WHERE carry_forward_batch = CURRENT_DATE
  AND carry_forward_from IS NOT NULL;

COMMIT;

-- ---------- Verify --------------------------------------------------------
-- Expect 0.
SELECT count(*) AS remaining_bad_clones
FROM tasks
WHERE carry_forward_batch = CURRENT_DATE
  AND carry_forward_from IS NOT NULL;
