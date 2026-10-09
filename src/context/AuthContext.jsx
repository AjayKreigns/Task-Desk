import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useNotification } from './NotificationContext';
import {
  setLastUserId, isDifferentUser, clearMirrors, migratePersonalKeysToUser,
} from '../lib/localCache';
import { AUTH_STATUS as STATUS } from '../lib/authStatus';
import { normalizeRole } from '../lib/roles';

const AuthContext = createContext(null);

// See src/lib/authStatus.js for what each value means and why they're explicit
// states rather than a pile of booleans — AuthGate.jsx needs to pick exactly one
// screen, and "loading && !session && !employee && !recovering" style conditions
// are how that kind of gate quietly grows a bug.

// Never shown verbatim — translated so a stranger probing the login form learns
// nothing more specific than "that didn't work".
function friendlySignInError(error) {
  const msg = error?.message || '';
  if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(msg)) return "This account hasn't been confirmed yet. Ask your administrator to confirm it.";
  if (/rate limit/i.test(msg) || error?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error?.name === 'TypeError' || /Failed to fetch/i.test(msg)) return "Can't reach the server. Check your connection and try again.";
  if (msg) console.error('Sign-in error:', error);
  return 'Sign-in failed. Please try again.';
}

// Same idea for sign-up. The database's reject_unapproved_signup trigger (see
// supabase_signup_gate.sql) is the only thing standing between "anyone can
// register" and "only pre-approved emails can" — Supabase's Auth server does
// not always pass a trigger's raw exception text straight through to the
// client, sometimes wrapping it in a generic "Database error saving new user"
// instead. This is why there are two patterns matched for the same rejection
// rather than one: whichever shape actually comes through, the person still
// gets the specific, actionable message rather than a raw wrapper string.
function friendlySignUpError(error) {
  const msg = error?.message || '';
  if (/already registered|already exists|user_already_exists/i.test(msg)) {
    return 'An account with this email already exists. Try signing in, or use "Forgot password?" below.';
  }
  if (/has not been added by an administrator/i.test(msg)) return msg;
  if (/database error saving new user/i.test(msg) || error?.status === 500) {
    return 'This email has not been added by an administrator yet. Ask them to add you in Team & Websites first, using this exact email address.';
  }
  if (/password/i.test(msg) && /(least|short|weak|character)/i.test(msg)) return msg;
  if (/rate limit/i.test(msg) || error?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error?.name === 'TypeError' || /Failed to fetch/i.test(msg)) return "Can't reach the server. Check your connection and try again.";
  if (msg) console.error('Sign-up error:', error);
  return 'Could not create your account. Please try again.';
}

export function AuthProvider({ children }) {
  const localOnly = !isSupabaseConfigured();
  const notificationCtx = useNotification();

  const [status, setStatus] = useState(localOnly ? STATUS.LOCAL : STATUS.RESTORING);
  const [session, setSession] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [authNotice, setAuthNotice] = useState(null);
  const expiring = useRef(false); // debounces reportSessionExpired

  const user = session?.user ?? null;

  // === session restore ===
  useEffect(() => {
    if (localOnly) return undefined;
    let cancelled = false;

    // Subscribed before the initial getSession() call, so no event in between is
    // lost. HARD RULE: never await, and never call another supabase.* method,
    // inside this callback — it runs while supabase-js holds its internal auth
    // lock, and doing either here can deadlock the client.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (cancelled) return;
      if (event === 'PASSWORD_RECOVERY') setStatus(STATUS.RECOVERY);
      setSession(s ?? null);
      if (event === 'SIGNED_OUT') {
        setEmployee(null);
        setStatus(STATUS.SIGNED_OUT);
      }
    });

    // supabase-js v2 also emits INITIAL_SESSION through the callback above, but
    // this covers a client version that doesn't, so the app always boots.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession((prev) => prev ?? data.session ?? null);
      if (!data.session) setStatus((prev) => (prev === STATUS.RESTORING ? STATUS.SIGNED_OUT : prev));
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [localOnly]);

  // === link the session to an employees row ===
  // A separate effect, keyed on the user id — never done inside
  // onAuthStateChange, per the hard rule above.
  //
  // Keyed on user?.id (a stable string), NOT on `user` itself. Every token
  // auto-refresh — which fires whenever a tab regains visibility after being
  // hidden long enough, per supabase-js's own visibilitychange handling —
  // hands onAuthStateChange a brand-new session/user object for the SAME
  // account. Depending on the object reference reran this effect on every one
  // of those refreshes: status flipped to LINKING, AuthGate swapped the whole
  // app out for the loading screen, and AppProvider (everything below it,
  // including activeTab) unmounted and remounted for no actual account
  // change. That's what made switching tabs or unminimizing look like the
  // dashboard had reloaded.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (localOnly) return undefined;
    if (!user) return undefined;

    let cancelled = false;
    // Guarded against RECOVERY, not a plain setStatus(STATUS.LINKING): this
    // effect reruns whenever `userId` changes, which also happens the moment
    // a password-recovery link hands back a session — onAuthStateChange
    // above has already set status to RECOVERY by then (AuthGate shows the
    // "set a new password" screen for it). Without this guard, this effect
    // immediately stomped that back to LINKING and then SIGNED_IN once the
    // employee lookup resolved, silently dropping the person straight into
    // the dashboard with their OLD password still active — this is the
    // actual bug behind "the link logged me in instead of resetting it".
    // completePasswordReset's own setStatus(STATUS.LINKING) call, once the
    // password has genuinely been changed, is the deliberate way out of
    // RECOVERY — this effect must never do that on its own.
    setStatus(prev => (prev === STATUS.RECOVERY ? prev : STATUS.LINKING));

    // Stage A (the `role`/`user_id` migration) may not have run yet, so this
    // selects '*' rather than naming those columns explicitly — an explicit list
    // referencing a column that doesn't exist yet would fail outright, whereas
    // '*' simply omits it and `employee.role` reads as undefined until the
    // migration lands. `.limit(1)` rather than `.maybeSingle()`: two employees
    // sharing an email is possible in free-text data today, and `.maybeSingle()`
    // errors on more than one row instead of just taking the first.
    supabase
      .from('employees')
      .select('*')
      .ilike('email', user.email)
      .limit(1)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Employee link lookup failed:', error);
          setEmployee(null);
          setStatus(prev => (prev === STATUS.RECOVERY ? prev : STATUS.UNLINKED));
          return;
        }
        const row = data?.[0] || null;
        setEmployee(row);
        setStatus(prev => (prev === STATUS.RECOVERY ? prev : (row ? STATUS.SIGNED_IN : STATUS.UNLINKED)));

        // Different-user detection happens here, not at sign-in, because this is
        // the first point a concrete user id exists to compare against.
        if (isDifferentUser(user.id)) clearMirrors(localOnly);
        setLastUserId(user.id);
        migratePersonalKeysToUser(user.id);
      });

    return () => { cancelled = true; };
    // Deliberately keyed on userId (stable), not `user` (a new object on
    // every token refresh) — see the comment above this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localOnly, userId]);

  const signIn = useCallback(async (email, password) => {
    if (localOnly) return { ok: false, error: 'No backend is configured.' };
    // Only the email is normalised, never the password: a stray space pasted
    // alongside an email address is an easy, invisible mistake worth absorbing,
    // but silently trimming a password would mean second-guessing a value the
    // user may have deliberately set, which is not this app's call to make.
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) return { ok: false, error: friendlySignInError(error) };
    return { ok: true };
  }, [localOnly]);

  // Only succeeds if the database's reject_unapproved_signup trigger finds
  // this exact email already present in employees — an administrator must
  // add the person there first. This is what replaces "no public sign-up"
  // with "sign-up gated to pre-approved emails", closing the same risk a
  // dashboard-level toggle would have, since this project's Auth settings
  // don't expose signup and login as separately switchable.
  const signUp = useCallback(async (email, password) => {
    if (localOnly) return { ok: false, error: 'No backend is configured.' };
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) return { ok: false, error: friendlySignUpError(error) };
    // If email confirmation is required project-wide, Supabase returns a user
    // but no session yet — they must click the emailed link before they can
    // sign in. If confirmation is off, a session comes back immediately and
    // onAuthStateChange already picks it up on its own; nothing further to do
    // here either way.
    return { ok: true, needsConfirmation: !data.session };
  }, [localOnly]);

  const signOut = useCallback(async () => {
    if (localOnly) return;
    // 'local' scope, not the default 'global': global revokes every session for
    // this user everywhere, so signing out of the office PC would also sign them
    // out of their phone.
    await supabase.auth.signOut({ scope: 'local' });
    setLastUserId(null);
    // Clearing while AppProvider is still mounted is pointless — its own
    // save-to-localStorage effects (AppContext.jsx) would just write the mirrors
    // straight back on the next render. AuthGate has already unmounted it by the
    // time SIGNED_OUT flips `status`, and the full reload also drops the
    // realtime socket cleanly rather than leaving it to error out mid-teardown.
    clearMirrors(localOnly);
    window.location.reload();
  }, [localOnly]);

  const sendPasswordReset = useCallback(async (email) => {
    if (localOnly) return { ok: false };
    // Always the same neutral result regardless of whether the address has an
    // account — there is no sign-up, so this is the only account-enumeration
    // probe available, and confirming or denying it would hand that out for free.
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: window.location.origin,
    });
    return { ok: true };
  }, [localOnly]);

  const completePasswordReset = useCallback(async (newPassword) => {
    if (localOnly) return { ok: false, error: 'No backend is configured.' };
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message || 'Could not set the new password.' };
    // Strip the recovery token out of the address bar and drop back to the
    // normal signed-in gate now that a password has actually been set.
    window.history.replaceState(null, '', window.location.pathname);
    if (!user) {
      setStatus(STATUS.SIGNED_OUT);
      return { ok: true };
    }
    // Resolved directly here rather than setStatus(STATUS.LINKING) + hoping
    // the employee-linking effect above picks it back up: that effect is
    // keyed on userId, which hasn't changed since the recovery session first
    // arrived (it already ran once, guarded, while status was RECOVERY), so
    // it would never re-fire to carry LINKING onward — status would be stuck
    // on the loading screen forever instead of reaching the dashboard.
    const { data, error: lookupError } = await supabase
      .from('employees')
      .select('*')
      .ilike('email', user.email)
      .limit(1);
    if (lookupError) {
      console.error('Employee link lookup failed:', lookupError);
      setEmployee(null);
      setStatus(STATUS.UNLINKED);
      return { ok: true };
    }
    const row = data?.[0] || null;
    setEmployee(row);
    setStatus(row ? STATUS.SIGNED_IN : STATUS.UNLINKED);
    return { ok: true };
  }, [user, localOnly]);

  // Called by AppContext when a write comes back with an expired/invalid session
  // (PGRST301), so the user is dropped back to the login screen with an
  // explanation instead of writes just silently failing forever. Debounced —
  // several requests can each hit this within the same tick.
  const reportSessionExpired = useCallback(() => {
    if (expiring.current) return;
    expiring.current = true;
    setAuthNotice('Your session expired. Please sign in again.');
    notificationCtx?.notify?.('error', 'Session expired', 'Please sign in again.');
    if (!localOnly) {
      supabase.auth.signOut({ scope: 'local' }).finally(() => { expiring.current = false; });
    }
  }, [localOnly, notificationCtx]);

  const myEmployeeId = employee?.id ?? null;
  const role = normalizeRole(employee?.role);
  const isAdmin = localOnly ? true : role === 'admin';
  // A read-only admin: sees every employee's data exactly like an admin does
  // (canViewAll below), but can create/edit/delete nothing — isAdmin stays
  // false for them everywhere a write control is gated on it, which is most
  // of this codebase's existing isAdmin checks. Only the handful of call
  // sites that mean "which data should default to showing" need canViewAll
  // instead.
  const isViewer = localOnly ? false : role === 'viewer';
  // Sees and manages every team, not just their own — isAdmin deliberately
  // keeps meaning "my own role is literally admin" so every existing write
  // gate stays correct unchanged; canManageTeam below is the one that grows
  // to also cover a super admin acting on a team's behalf.
  const isSuperAdmin = localOnly ? true : role === 'super_admin';
  const myTeamId = employee?.team_id ?? null;
  const canViewAll = isAdmin || isViewer || isSuperAdmin;
  const canManageTeam = isAdmin || isSuperAdmin;
  const isMe = useCallback((employeeId) => !!myEmployeeId && employeeId === myEmployeeId, [myEmployeeId]);
  const displayName = employee?.name || user?.email || 'Signed in';
  const authKey = localOnly ? 'local' : (user?.id ?? 'anon');
  const authReady = status !== STATUS.RESTORING && status !== STATUS.LINKING;

  // Which team's data is in view. For everyone but a super admin this is
  // just their own team, fixed — only a super admin can actually change it,
  // via the topbar team switcher (App.jsx) or the Employees-tab drill-down
  // (Settings.jsx), both of which just call setSelectedTeamId.
  const [selectedTeamIdRaw, setSelectedTeamIdRaw] = useState(null);
  const selectedTeamId = isSuperAdmin ? selectedTeamIdRaw : myTeamId;
  const setSelectedTeamId = isSuperAdmin ? setSelectedTeamIdRaw : () => {};

  const value = {
    session, user, employee, myEmployeeId, role, isAdmin, isViewer, isSuperAdmin, myTeamId,
    canViewAll, canManageTeam, selectedTeamId, setSelectedTeamId, isMe, displayName,
    status, authReady, localOnly, authKey, authNotice,
    signIn, signUp, signOut, sendPasswordReset, completePasswordReset, reportSessionExpired,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
