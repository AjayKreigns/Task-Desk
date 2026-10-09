import { useApp } from '../context/AppContext';
import { getCloudStatusDisplay } from '../lib/cloudStatusDisplay';

// One PQRST-shaped waveform, always fully drawn — the "beating" look comes
// from two overlay panels sweeping across it (see .heartbeat-fade-in/-out in
// index.css), not from moving the path itself.
const PULSE_POINTS =
  '0,45.486 38.514,45.486 44.595,33.324 50.676,45.486 57.771,45.486 62.838,55.622 71.959,9 80.067,63.729 ' +
  '84.122,45.486 97.297,45.486 103.379,40.419 110.473,45.486 150,45.486';

// Replaces the old static "Cloud Synced" badge with a live read of
// AppContext's cloudStatus (not the one-time isCloud boolean, which only means
// "Supabase is configured", not "currently connected") — see
// src/lib/cloudStatusDisplay.js for the state-to-visual mapping. Green when
// truly connected, red when not (local-only or a real sync failure), amber
// and un-swept while a connection attempt is still in flight.
export default function HeartbeatIndicator() {
  const { cloudStatus, cloudError } = useApp();
  const display = getCloudStatusDisplay(cloudStatus, cloudError);
  const sweeping = display.tone === 'success' || display.tone === 'danger';

  return (
    <div className={`heartbeat-pill tone-${display.tone}`} title={display.tooltip || undefined}>
      <div className="heartbeat-track">
        <svg viewBox="0 0 150 73" width="70" height="34" aria-hidden="true">
          <polyline
            points={PULSE_POINTS}
            className={`heartbeat-wave ${sweeping ? '' : 'is-idle'}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {sweeping && (
          <>
            <div className="heartbeat-fade-in" />
            <div className="heartbeat-fade-out" />
          </>
        )}
      </div>
      <span className="heartbeat-label">{display.label}</span>
    </div>
  );
}
