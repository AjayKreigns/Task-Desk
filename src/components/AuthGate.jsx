import { useAuth } from '../context/AuthContext';
import { AUTH_STATUS } from '../lib/authStatus';
import FullScreenLoader from './FullScreenLoader';
import LoginScreen from './LoginScreen';
import AccountNotLinked from './AccountNotLinked';

// Picks exactly one screen for the current auth status. `local` is checked
// first and unconditionally, on purpose: if the Netlify env vars are missing or
// misnamed at build time, `supabase` is null and every other branch would try to
// render a login form with no backend behind it, bricking the deployed app. In
// that mode there's nothing to gate — the app has always worked this way.
export default function AuthGate({ children }) {
  const { status } = useAuth();

  if (status === AUTH_STATUS.LOCAL) return children;

  // Covers both "we don't know yet if there's a session" and "there is a
  // session, still looking up who it belongs to" — a returning user goes
  // straight from this spinner to the dashboard, never through the login screen.
  if (status === AUTH_STATUS.RESTORING || status === AUTH_STATUS.LINKING) {
    return <FullScreenLoader label="Restoring your session..." />;
  }

  if (status === AUTH_STATUS.RECOVERY) return <LoginScreen forcedMode="set-password" />;
  if (status === AUTH_STATUS.SIGNED_OUT) return <LoginScreen />;
  if (status === AUTH_STATUS.UNLINKED) return <AccountNotLinked />;

  return children;
}
