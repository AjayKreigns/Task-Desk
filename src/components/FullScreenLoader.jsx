import BackgroundNetwork from './BackgroundNetwork';

// Originally an inline block in App.jsx, then a plain spinning Loader2 icon on
// a blank background. Now shares the login screen's own branding (logo +
// BackgroundNetwork) instead of looking like an unrelated interstitial — this
// gate and the login screen it hands off to (or comes from) should read as
// the same app, not two different loading languages. Two of these can stack
// (auth restore, then data load) and the transition between them is invisible.
export default function FullScreenLoader({ label = 'Loading dashboard...' }) {
  return (
    <div className="auth-shell">
      <BackgroundNetwork full />
      <div style={{ textAlign: 'center' }}>
        <img src="/logo.png" alt="" className="auth-logo loader-logo" />
        <h1 className="auth-title">Task Dashboard</h1>
        <p className="auth-subtitle" style={{ marginBottom: 0 }}>{label}</p>
      </div>
    </div>
  );
}
