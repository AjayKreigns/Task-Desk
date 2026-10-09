-- =============================================================
-- STAGE B ROLLBACK — BREAK GLASS
-- Restoring "Allow all" immediately re-exposes every row to the public anon
-- key that is already compiled into the deployed app. Use this only to
-- regain access if something is broken, then fix forward — it is not meant
-- to be a normal operating state.
--
-- Deliberately non-destructive: it restores the permissive policies and drops
-- the new triggers/functions, but keeps user_id/role/email on employees, so
-- none of the account-linking work is lost.
-- =============================================================
BEGIN;

DROP POLICY IF EXISTS employees_select_authenticated ON employees;
DROP POLICY IF EXISTS employees_insert_admin ON employees;
DROP POLICY IF EXISTS employees_update_admin ON employees;
DROP POLICY IF EXISTS employees_delete_admin ON employees;
DROP POLICY IF EXISTS websites_select_authenticated ON websites;
DROP POLICY IF EXISTS websites_insert_admin ON websites;
DROP POLICY IF EXISTS websites_update_admin ON websites;
DROP POLICY IF EXISTS websites_delete_admin ON websites;
DROP POLICY IF EXISTS tasks_select_own_or_admin ON tasks;
DROP POLICY IF EXISTS tasks_insert_own_or_admin ON tasks;
DROP POLICY IF EXISTS tasks_update_own_or_admin ON tasks;
DROP POLICY IF EXISTS tasks_delete_admin ON tasks;
DROP POLICY IF EXISTS tasks_delete_own_or_admin ON tasks;

DROP TRIGGER IF EXISTS employees_last_admin_trg ON employees;
DROP FUNCTION IF EXISTS prevent_last_admin_removal();

GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON websites TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO anon, authenticated;

CREATE POLICY "Allow all on employees" ON employees FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on websites" ON websites FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on tasks" ON tasks FOR ALL USING (true) WITH CHECK (true);

COMMIT;

-- Note: current_employee_id() and is_admin() are left in place — they are
-- harmless with no policies referencing them, and Stage B can be re-applied
-- later without redefining them. If you truly want them gone too:
-- DROP FUNCTION IF EXISTS is_admin();
-- DROP FUNCTION IF EXISTS current_employee_id();
