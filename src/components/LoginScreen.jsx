import { useState } from 'react';
import { LogIn, AlertCircle, Moon, Sun } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import BackgroundNetwork from './BackgroundNetwork';

// Several screens in one component, switched by local `mode` plus the
// `forcedMode` prop AuthGate passes for the one case it must control (the
// password-reset link landing back on the app): 'signin' -> 'forgot' -> 'sent',
// 'signin' -> 'signup' -> 'signup-sent', or 'set-password' when arriving via a
// recovery link.
//
// Sign-up is not open to anyone: the database's reject_unapproved_signup
// trigger (see supabase_signup_gate.sql) only allows it to succeed for an
// email an administrator already added in Team & Websites. This form doesn't
// enforce that itself — it just submits and shows whatever the database
// decides, which is what makes the restriction real rather than cosmetic.
export default function LoginScreen({ forcedMode }) {
  const { signIn, signUp, sendPasswordReset, completePasswordReset, authNotice } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [mode, setMode] = useState('signin');
  const effectiveMode = forcedMode || mode;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSignIn = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const result = await signIn(email, password);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    setBusy(true);
    await sendPasswordReset(email);
    setBusy(false);
    setMode('sent');
  };

  const handleSetPassword = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) { setError('Use at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true);
    const result = await completePasswordReset(newPassword);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) { setError('Use at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true);
    const result = await signUp(email, newPassword);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    // If confirmation isn't required, signUp() already started a session and
    // onAuthStateChange moves the app on by itself — nothing to do here but
    // let that happen. If it IS required, show where to go next.
    if (result.needsConfirmation) setMode('signup-sent');
  };

  return (
    <div className="auth-shell">
      <BackgroundNetwork full />
      <button
        type="button"
        className="theme-toggle auth-theme-toggle"
        onClick={toggleTheme}
        title={theme === 'light' ? 'Dark mode' : 'Light mode'}
      >
        {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
      </button>

      <div className="auth-card">
        <img src="/logo.png" alt="" className="auth-logo" />
        <h1 className="auth-title">Task Dashboard</h1>
        <p className="auth-subtitle">Digital Marketing Operations</p>

        {authNotice && effectiveMode === 'signin' && (
          <div className="auth-notice"><AlertCircle size={15} /> {authNotice}</div>
        )}

        {effectiveMode === 'signin' && (
          <form onSubmit={handleSignIn} className="auth-form">
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="form-input" type="email" autoComplete="username" required
                value={email} onChange={(e) => { setEmail(e.target.value); setError(''); }}
                placeholder="you@ifluids.com"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                className="form-input" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }}
              />
            </div>
            {error && <div className="auth-error"><AlertCircle size={15} /> {error}</div>}
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? 'Signing in...' : (<><LogIn size={16} /> Sign in</>)}
            </button>
            <button type="button" className="auth-link" onClick={() => { setMode('forgot'); setError(''); }}>
              Forgot password?
            </button>
            <button type="button" className="auth-link" onClick={() => { setMode('signup'); setError(''); }}>
              First time? Create your password
            </button>
          </form>
        )}

        {effectiveMode === 'signup' && (
          <form onSubmit={handleSignUp} className="auth-form">
            <p className="auth-help">
              Enter the exact email your administrator added for you in Team &amp; Websites, then choose a password.
            </p>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="form-input" type="email" autoComplete="username" required
                value={email} onChange={(e) => { setEmail(e.target.value); setError(''); }}
                placeholder="you@ifluids.com"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                className="form-input" type="password" autoComplete="new-password" required
                value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm password</label>
              <input
                className="form-input" type="password" autoComplete="new-password" required
                value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
              />
            </div>
            {error && <div className="auth-error"><AlertCircle size={15} /> {error}</div>}
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? 'Creating account...' : 'Create account'}
            </button>
            <button type="button" className="auth-link" onClick={() => { setMode('signin'); setError(''); }}>
              Back to sign in
            </button>
          </form>
        )}

        {effectiveMode === 'signup-sent' && (
          <div className="auth-form">
            <p className="auth-help">
              Check your email to confirm your account, then come back and sign in.
            </p>
            <button type="button" className="btn btn-secondary auth-submit" onClick={() => setMode('signin')}>
              Back to sign in
            </button>
          </div>
        )}

        {effectiveMode === 'forgot' && (
          <form onSubmit={handleForgot} className="auth-form">
            <p className="auth-help">Enter your email and we'll send you a reset link.</p>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="form-input" type="email" autoComplete="username" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@ifluids.com"
              />
            </div>
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? 'Sending...' : 'Send reset link'}
            </button>
            <button type="button" className="auth-link" onClick={() => setMode('signin')}>
              Back to sign in
            </button>
          </form>
        )}

        {effectiveMode === 'sent' && (
          <div className="auth-form">
            <p className="auth-help">
              If that address has an account, a reset link is on its way. Check your inbox.
            </p>
            <button type="button" className="btn btn-secondary auth-submit" onClick={() => setMode('signin')}>
              Back to sign in
            </button>
          </div>
        )}

        {effectiveMode === 'set-password' && (
          <form onSubmit={handleSetPassword} className="auth-form">
            <p className="auth-help">Choose a new password for your account.</p>
            <div className="form-group">
              <label className="form-label">New password</label>
              <input
                className="form-input" type="password" autoComplete="new-password" required
                value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm password</label>
              <input
                className="form-input" type="password" autoComplete="new-password" required
                value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
              />
            </div>
            {error && <div className="auth-error"><AlertCircle size={15} /> {error}</div>}
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? 'Saving...' : 'Set password'}
            </button>
          </form>
        )}

        <p className="auth-footnote">Your administrator adds your email in Team &amp; Websites - then you can create your password here.</p>
      </div>
    </div>
  );
}
