-- =============================================================
-- LET MEMBERS DELETE THEIR OWN TASKS
-- Paste this whole script into the Supabase SQL Editor and run it as one
-- transaction. Safe to run more than once.
--
-- Today's tasks_delete_admin policy only lets an admin delete a task,
-- regardless of who it's assigned to — members can edit/complete their own
-- tasks but not remove one they added by mistake or duplicated. This changes
-- DELETE to follow the same ownership rule already used for UPDATE: an admin,
-- or the task's own assignee. Nobody can delete someone else's task either
-- way — that part doesn't change.
-- =============================================================
BEGIN;

DROP POLICY IF EXISTS tasks_delete_admin ON tasks;
DROP POLICY IF EXISTS tasks_delete_own_or_admin ON tasks;
CREATE POLICY tasks_delete_own_or_admin ON tasks
  FOR DELETE TO authenticated
  USING (
    (select is_admin())
    OR assigned_to = (select current_employee_id())
  );

COMMIT;

-- ---------- Verify ----------------------------------------------------
-- Expect: one row, tasks_delete_own_or_admin, cmd = DELETE.
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'tasks' AND cmd = 'DELETE';
