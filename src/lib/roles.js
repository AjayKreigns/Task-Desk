// The 4-role vocabulary, in one place. AuthContext.jsx, AppContext.jsx, and
// Settings.jsx each used to carry their own hand-written copy of this same
// ternary (one inline, one separately named normalizeRole, one more inside
// an employee-card badge) — exactly the kind of drift that let a role
// silently fall back to the wrong default in one spot while staying correct
// in another. One function, every importer, from here on.
export const ROLES = ['super_admin', 'admin', 'viewer', 'member'];

export function normalizeRole(role) {
  return ROLES.includes(role) ? role : 'member';
}

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  viewer: 'Viewer',
  member: 'Member',
};

export const ROLE_BADGE_CLASS = {
  super_admin: 'badge-danger',
  admin: 'badge-warning',
  viewer: 'badge-success',
  member: 'badge-info',
};
