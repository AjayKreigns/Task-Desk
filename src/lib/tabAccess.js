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
// Lead Center stays a single, shared, company-wide resource — never
// duplicated per team — so it's only ever reachable while Digital Marketing
// (is_lead_source_team, not its editable name) is the team in view. This
// used to be enforced only by hiding the nav link (Layout.jsx) — the actual
// page had no gate of its own, so a stale activeTab or a button that
// switches straight to it (Dashboard.jsx's "View Details" on the Enquiries
// card) could still render it for any other team.
const LEAD_SOURCE_ONLY_TABS = new Set(['leads']);

export function isTabAccessible(key, { canViewAll, isSuperAdmin, isLeadSourceTeam }) {
  if (ADMIN_ONLY_TABS.has(key) && !canViewAll) return false;
  if (SUPER_ADMIN_ONLY_TABS.has(key) && !isSuperAdmin) return false;
  if (LEAD_SOURCE_ONLY_TABS.has(key) && !isLeadSourceTeam) return false;
  return true;
}
