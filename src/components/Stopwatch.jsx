import { useState, useEffect } from 'react';
import { Play, Pause, Flag, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { DEFAULT_STOPWATCH, formatElapsed } from '../lib/stopwatch';

// A per-task stopwatch: play/pause, lap, reset. `value` is persisted by the
// caller (My Day keeps it inside the todo it belongs to, in the same
// localStorage-only object that todo already lives in — this never syncs
// anywhere, by design, matching the rest of My Day).
//
// Wall-clock based rather than a running JS timer: elapsedMs only ever holds
// time already banked from a *finished* run, and while running the live
// value is elapsedMs + (liveNow - startedAt). That's what lets a stopwatch
// left running survive a page reload (or the tab being discarded and
// reloaded) and still show correct time, the same way a real stopwatch would
// keep counting in your pocket while you weren't looking at it.
//
// `liveNow` is state, not a bare Date.now() read inside the render body —
// render must stay a pure function of props/state, so the impure clock read
// happens in the initializer, the interval tick, and the toggle handler
// (all of which run outside render), never inline in the calculation below.
export default function Stopwatch({ value, onChange }) {
  const { running, elapsedMs, startedAt, laps } = value;
  const [showLaps, setShowLaps] = useState(false);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setLiveNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  const liveElapsed = running ? elapsedMs + (liveNow - startedAt) : elapsedMs;
  const hasTime = liveElapsed > 0 || laps.length > 0;

  const handleToggle = () => {
    if (running) {
      onChange({ ...value, running: false, elapsedMs: elapsedMs + (Date.now() - startedAt), startedAt: null });
    } else {
      const now = Date.now();
      setLiveNow(now);
      onChange({ ...value, running: true, startedAt: now });
    }
  };

  const handleLap = () => {
    if (!running) return;
    const totalMs = liveElapsed;
    const prevTotal = laps.length ? laps[laps.length - 1].totalMs : 0;
    onChange({ ...value, laps: [...laps, { id: laps.length + 1, lapMs: totalMs - prevTotal, totalMs }] });
  };

  const handleReset = () => {
    onChange({ ...DEFAULT_STOPWATCH });
    setShowLaps(false);
  };

  return (
    <div className="stopwatch">
      <div className="stopwatch-row">
        <span className="stopwatch-time">{formatElapsed(liveElapsed)}</span>
        <button
          type="button"
          className="btn-icon stopwatch-btn"
          onClick={handleToggle}
          title={running ? 'Pause' : 'Start'}
        >
          {running ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          type="button"
          className="btn-icon stopwatch-btn"
          onClick={handleLap}
          disabled={!running}
          title="Lap"
        >
          <Flag size={13} />
        </button>
        {hasTime && (
          <button type="button" className="btn-icon stopwatch-btn" onClick={handleReset} title="Reset">
            <RotateCcw size={13} />
          </button>
        )}
        {laps.length > 0 && (
          <button
            type="button"
            className="btn-icon stopwatch-btn"
            onClick={() => setShowLaps((s) => !s)}
            title={showLaps ? 'Hide laps' : 'Show laps'}
          >
            {showLaps ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>

      {showLaps && laps.length > 0 && (
        <ul className="stopwatch-laps">
          {laps.slice().reverse().map((lap) => (
            <li key={lap.id}>
              <span>Lap {lap.id}</span>
              <span>{formatElapsed(lap.lapMs)}</span>
              <span className="stopwatch-lap-total">{formatElapsed(lap.totalMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
