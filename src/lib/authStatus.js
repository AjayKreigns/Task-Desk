// The auth status enum, kept in its own file rather than alongside AuthContext's
// component export — a plain module can export as many named constants as it
// likes, while a file that exports a component is expected to export only that
// component (react-refresh/only-export-components), which is why useAuth is the
// one exception every context file in this app already carries.
export const AUTH_STATUS = {
  LOCAL: 'local',
  RESTORING: 'restoring',
  SIGNED_OUT: 'signed-out',
  LINKING: 'linking',
  UNLINKED: 'unlinked',
  SIGNED_IN: 'signed-in',
  RECOVERY: 'recovery',
};
