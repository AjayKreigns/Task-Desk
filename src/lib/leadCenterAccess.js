// Lead Center's own visibility rule — one shared place for it, checked from
// four different spots (Layout.jsx's nav item, App.jsx's isTabAccessible
// context, Dashboard.jsx's Enquiries-by-Country card, MonthlyReport.jsx's
// Enquiries section), so none of them can drift onto checking a slightly
// different condition.
//
// Digital Marketing always sees it, for every role — the resource is
// theirs (is_lead_source_team, not its editable name).
//
// "BED Team" is a deliberate, temporary, one-off exception (confirmed with
// the user — NOT a general "every team's admin" rule): its own
// admin/super_admin can see it too, members/viewers on it still can't.
// Matched by team NAME, since there's no dedicated column for this the way
// is_lead_source_team exists for Digital Marketing — if this team is ever
// renamed, this stops matching until updated here.
const EXCEPTION_TEAM_NAME = 'BED Team';

export function isLeadCenterVisible(currentTeam, canManageTeam) {
  if (currentTeam?.is_lead_source_team) return true;
  if (currentTeam?.name === EXCEPTION_TEAM_NAME && canManageTeam) return true;
  return false;
}
