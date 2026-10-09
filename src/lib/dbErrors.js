// Turns a Supabase/PostgREST error into a message a person can act on, and a
// `kind` the caller can branch on.
//
// This exists because of how Row Level Security fails. Once RLS is switched on:
//   - a blocked INSERT (or an UPDATE whose new row breaks the policy) raises 42501
//   - a blocked UPDATE/DELETE raises NOTHING: the row is simply invisible to the
//     policy, so nothing matches and PostgREST reports success with zero rows
//   - a blocked SELECT returns 200 with an empty array and no error at all
// Only the first of those is visible here. The second is handled by the
// `affectedRows` check in AppContext's write paths, and the third is undetectable
// from the response, which is why the employee lookup doubles as a canary.

// 42501 = insufficient_privilege. PostgREST surfaces RLS violations with this.
const PERMISSION_CODES = new Set(['42501']);
// PGRST301 = JWT expired or otherwise unusable.
const AUTH_CODES = new Set(['PGRST301']);

export function classifyDbError(error) {
  if (!error) return { kind: 'ok', message: '' };

  const code = error.code || '';
  const msg = error.message || '';

  // A fetch that never reached the server. Distinct from a rejection, because the
  // write definitely did not happen and retrying is reasonable.
  if (msg === 'Failed to fetch' || msg === 'NetworkError' || error.name === 'TypeError') {
    return { kind: 'network', message: "Can't reach the server, so your change was not saved. Check your connection and try again." };
  }

  if (AUTH_CODES.has(code) || /JWT expired|Invalid Refresh Token|invalid claim/i.test(msg)) {
    return { kind: 'auth', message: 'Your session has expired. Please sign in again.' };
  }

  if (PERMISSION_CODES.has(code) || /row-level security/i.test(msg) || error.status === 403) {
    return { kind: 'permission', message: "You don't have permission to make that change." };
  }

  // Handled by schemaFallback's column-stripping retry; pass the raw text through
  // so a genuinely missing column is still diagnosable.
  if (code === 'PGRST204') return { kind: 'schema', message: msg };

  // Foreign key still referenced — e.g. deleting something a task points at.
  if (code === '23503') return { kind: 'conflict', message: 'That item is still referenced by a task, so it cannot be removed.' };

  // Unique violation — e.g. two employees with the same email once that is constrained.
  if (code === '23505') return { kind: 'conflict', message: 'That value is already in use.' };

  return { kind: 'unknown', message: msg || 'Something went wrong. Please try again.' };
}

export const isPermissionError = (error) => classifyDbError(error).kind === 'permission';
export const isAuthError = (error) => classifyDbError(error).kind === 'auth';

// True when a write reported success but changed nothing. With RLS on, this is
// what a denied UPDATE or DELETE looks like — no error, no rows. Callers must
// treat it as a failure or the UI will show a change the server rejected.
export function wasBlockedSilently(data) {
  return Array.isArray(data) && data.length === 0;
}
