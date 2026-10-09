import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getGreeting } from '../lib/greeting';
import HeartbeatIndicator from './HeartbeatIndicator';

// Mirrors Layout.jsx's own unexported `initials()` helper — same precedent,
// kept local since nothing else needs it.
function firstName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return parts[0] || 'there';
}

// Sits above everything else on the Dashboard. Owns its own ticking clock
// rather than Dashboard.jsx owning it, so a once-a-second re-render only ever
// touches this small leaf component, never Dashboard's KPI/chart tree.
export default function WelcomeBanner() {
  const { displayName } = useAuth();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="welcome-banner">
      <div>
        <div className="welcome-banner-greeting">
          {getGreeting(now)}, {firstName(displayName)}
        </div>
        <div className="welcome-banner-meta">
          <span>{now.toLocaleDateString('default', { weekday: 'long' })}</span>
          <span>{now.toLocaleDateString('default', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
          <span className="welcome-banner-time">{now.toLocaleTimeString('default', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      </div>
      <HeartbeatIndicator />
    </div>
  );
}
