import { AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BackgroundNetwork from './BackgroundNetwork';

// Shown when someone has a valid, confirmed login but no row in `employees`
// matches their email — e.g. the owner created the auth account before adding
// them to the team list, or there's a typo between the two.
//
// This screen must always offer a way out. Without a sign-out control here,
// a mismatched email would trap the person on this screen with no recovery
// path other than clearing cookies.
export default function AccountNotLinked() {
  const { user, signOut, localOnly } = useAuth();
  if (localOnly) return null; // nothing to link in local-only mode

  return (
    <div className="auth-shell">
      <BackgroundNetwork full />
      <div className="auth-card">
        <div className="auth-icon auth-icon-warning"><AlertCircle size={28} /></div>
        <h1 className="auth-title">Account not set up yet</h1>
        <p className="auth-subtitle">
          You're signed in as <strong>{user?.email}</strong>, but there's no matching
          entry in the team list. Ask your administrator to add you, using this exact
          email address.
        </p>
        <p className="auth-help">
          Already fixed it? Reload to check again - no need to sign out first.
        </p>
        <button type="button" className="btn btn-primary auth-submit" onClick={() => window.location.reload()}>
          Try again
        </button>
        <button type="button" className="auth-link" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
