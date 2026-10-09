// Shared with Stopwatch.jsx and MyDay.jsx — kept out of the component file so
// that file can export only the component (see the comment on Stopwatch.jsx
// about react-refresh/only-export-components).
export const DEFAULT_STOPWATCH = { running: false, elapsedMs: 0, startedAt: null, laps: [] };

export function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
