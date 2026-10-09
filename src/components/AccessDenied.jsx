import { ShieldAlert } from 'lucide-react';

// Renders in place of a page when a non-admin's activeTab somehow points at an
// admin-only screen. The redirect effect in App.jsx normally moves them away
// within the same tick, so this is a one-frame fallback rather than something
// a member is expected to sit on — reachable only via a role change on an
// already-open tab (e.g. an admin demoting their own account).
export default function AccessDenied() {
  return (
    <div className="empty-state" style={{ padding: '60px 24px' }}>
      <ShieldAlert size={40} />
      <h4>You don't have access to this page</h4>
      <p>Ask an administrator if you think this is wrong.</p>
    </div>
  );
}
