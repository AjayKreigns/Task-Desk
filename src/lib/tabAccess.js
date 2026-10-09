// One shared gate for every "can this tab even be reached" check — nav
// visibility (Layout.jsx), App.jsx's stale-tab bounce effect, and its
// renderPage() switch each used to carry their own hand-written copy of the
// same two conditions. Keyed on the tab's key rather than per-item flags so
// all three call sites share this exact function instead of each re-deriving
// its own version of "which tabs need which role."
//
// Lives in its own file, not inside Layout.jsx (which is where this was
// first written) — a component file's exports must all be components for
// Fast Refresh to work, and this isn't one.
const ADMIN_ONLY_TABS = new Set(['settings']);
const SUPER_ADMIN_ONLY_TABS = new Set(['teams']);

export function isTabAccessible(key, { canViewAll, isSuperAdmin }) {
  if (ADMIN_ONLY_TABS.has(key) && !canViewAll) return false;
  if (SUPER_ADMIN_ONLY_TABS.has(key) && !isSuperAdmin) return false;
  return true;
}
