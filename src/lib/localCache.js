// The registry of every `td_*` localStorage key in the app, and what auth is
// allowed to do to each one.
//
// This exists because "just clear localStorage on sign-out" is wrong here. Of the
// eleven keys below, only three mirror rows that actually live in Supabase —
// employees, websites and tasks. The rest (comments, activity log, My Day todos,
// notifications, and all three category-config keys) are the ONLY copy of that
// data anywhere; AppContext never writes them to the database. Deleting them
// would permanently lose comments, the activity trail and the team's category
// colours, not just refetch them.
//
// So three different treatments:
//   MIRROR_KEYS    — safe to delete outright; the next fetch repopulates them
//   PERSONAL_KEYS  — namespaced per user instead, so nothing is destroyed and a
//                    shared browser doesn't show user B what user A typed
//   SHARED_KEYS    — team config with no per-user meaning; left alone
// Plus PRESERVED_KEYS, which is just `td_theme` — a device preference, never
// touched by auth at all.

export const MIRROR_KEYS = ['td_employees', 'td_websites', 'td_tasks'];

// td_carryforward_batch_seen / td_carryforward_warning_seen: which auto
// carry-forward batch (and which month's month-end warning) this person has
// already been shown — see TaskCarryForwardNotifier.jsx. Personal, not
// shared: two people on the same machine must each still get notified.
export const PERSONAL_KEYS = ['td_comments', 'td_activity', 'td_myday_todos', 'td_notifications', 'td_carryforward_batch_seen', 'td_carryforward_warning_seen'];

export const SHARED_KEYS = ['td_categories', 'td_category_colors', 'td_hidden_categories'];

export const PRESERVED_KEYS = ['td_theme'];

// Remembers which auth user last used this browser, so a different person
// signing in on a shared machine can be told apart from the same person
// signing back in. Deliberately not `td_`-prefixed, for the same reason the
// Supabase session storage key isn't — nothing here should be swept up in a
// prefix-based clear (and MIRROR_KEYS/PERSONAL_KEYS/SHARED_KEYS are exact lists,
// never a prefix scan, precisely so a change like that can't happen by accident).
const LAST_USER_KEY = 'td-last-user';

export function scoped(key, userId) {
  return userId ? `${key}::${userId}` : key;
}

// Deletes only the three server mirrors. Call this once AppProvider has
// unmounted (or is about to remount under a new key) — while it's still
// mounted, its own save-to-localStorage effects will just write the values
// straight back on the next render.
export function clearMirrors(localOnly) {
  // In local-only mode (no Supabase configured) these keys ARE the data, not a
  // cache of it. Clearing them would delete the user's only copy.
  if (localOnly) return;
  MIRROR_KEYS.forEach((k) => {
    try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
  });
}

// One-time migration for the four personal keys: the first time auth links to a
// real user, their existing unscoped history (written before login existed)
// becomes their own scoped copy instead of silently vanishing behind the
// namespaced key.
export function migratePersonalKeysToUser(userId) {
  if (!userId) return;
  for (const key of PERSONAL_KEYS) {
    const scopedKey = scoped(key, userId);
    try {
      if (localStorage.getItem(scopedKey) !== null) continue; // already migrated
      const existing = localStorage.getItem(key);
      if (existing !== null) localStorage.setItem(scopedKey, existing);
    } catch { /* storage unavailable */ }
  }
}

export function getLastUserId() {
  try { return localStorage.getItem(LAST_USER_KEY); } catch { return null; }
}

export function setLastUserId(userId) {
  try {
    if (userId) localStorage.setItem(LAST_USER_KEY, userId);
    else localStorage.removeItem(LAST_USER_KEY);
  } catch { /* storage unavailable */ }
}

// True when the user signing in now is not the one who used this browser last.
// The caller clears the mirrors in this case so the incoming user's first paint
// never shows the previous person's cached tasks.
export function isDifferentUser(userId) {
  const prev = getLastUserId();
  return !!(userId && prev && prev !== userId);
}
