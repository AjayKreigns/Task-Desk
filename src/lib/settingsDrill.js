// Shared between Settings.jsx (which owns the drilled-in state) and
// TeamManagement.jsx (which needs to jump straight into a team's drilled-in
// view from its own "click a team card" action) — a single source for the
// sessionStorage key so the two can never drift onto different strings.
export const SETTINGS_DRILLED_IN_KEY = 'td_settings_drilled_in';
