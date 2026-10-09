// Tolerates a Supabase schema that hasn't had later migrations applied.
//
// PostgREST rejects an entire write with PGRST204 when it references a column
// the table doesn't have, which made "Add Task" fail with nothing shown to the
// user. These helpers remember which optional columns are missing, strip them
// and retry, so the core action still succeeds — the affected fields simply
// don't persist until supabase_migration.sql is run.

import { isPermissionError, isAuthError } from './dbErrors';

export const OPTIONAL_TASK_COLUMNS = [
  'targeted_time', 'time_taken', 'progress',
  'is_additional', 'carry_forward_from', 'carry_forward_to',
];

const missingColumns = new Set();

export function getMissingColumns() {
  return [...missingColumns];
}

// Test hook — production code never needs to clear this.
export function resetMissingColumns() {
  missingColumns.clear();
}

export function parseMissingColumn(error) {
  const match = /Could not find the '(.+?)' column/.exec(error?.message || '');
  const col = match ? match[1] : null;
  return col && OPTIONAL_TASK_COLUMNS.includes(col) ? col : null;
}

export function stripMissing(payload) {
  if (!missingColumns.size) return payload;
  const drop = (row) => {
    const out = { ...row };
    missingColumns.forEach(c => delete out[c]);
    return out;
  };
  return Array.isArray(payload) ? payload.map(drop) : drop(payload);
}

// Runs a Supabase write, retrying without any column the schema doesn't have.
// `run` receives the payload and must return Supabase's { data, error } shape.
export async function taskWrite(run, payload, onColumnDropped) {
  for (let attempt = 0; attempt <= OPTIONAL_TASK_COLUMNS.length; attempt++) {
    const stripped = stripMissing(payload);
    const result = await run(stripped);
    if (!result?.error) return result;

    // A permission failure is not a schema problem. Return immediately rather
    // than re-issuing the same denied write once per optional column — the retry
    // loop would turn one rejection into seven and bury the real cause.
    if (isPermissionError(result.error) || isAuthError(result.error)) return result;

    const col = parseMissingColumn(result.error);
    const sample = Array.isArray(stripped) ? stripped[0] : stripped;
    // Unrelated failure, or a column we already dropped — surface it as-is.
    if (!col || !sample || !(col in sample)) return result;

    missingColumns.add(col);
    onColumnDropped?.(col);
  }
  return { error: { message: 'Task schema is missing too many columns.' } };
}
