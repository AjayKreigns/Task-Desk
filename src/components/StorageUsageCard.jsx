import { useState, useEffect, useCallback } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';

// Confirmed directly against Supabase → Organization → Usage → "Database &
// Storage Size" (2026-09-19): "0.5 GB per project" on the Free plan — this is
// 512 MiB, not the commonly-quoted "500 MB" (500 MiB would be ~2.4% smaller
// and under-report how full the database actually is). Supabase can still
// change this later, so it stays a clearly-named, easily-adjusted constant
// rather than something buried in a calculation.
const FREE_TIER_LIMIT_BYTES = 512 * 1024 * 1024;

// Auto-compact, matching the dataviz stat-tile contract (1,284 / 12.9K / $4.2M
// style formatting) — but for bytes. Always shows one decimal past the first
// unit so small values (a near-empty database) aren't rounded down to "0 MB".
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// Meter severity per the dataviz spec: fill carries severity
// (accent -> warning -> danger), track is a lighter step of the same ramp.
function severityFor(pct) {
  if (pct >= 85) return { tone: 'danger', label: 'Nearing the free-tier limit' };
  if (pct >= 60) return { tone: 'warning', label: 'Getting used' };
  return { tone: 'success', label: 'Plenty of headroom' };
}

export default function StorageUsageCard() {
  const { fetchStorageUsage } = useApp();
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // No setState before the first `await` here, so calling this from the
  // effect below never trips react-hooks/set-state-in-effect — the rule
  // objects to a synchronous setState during an effect's own execution, not
  // to one that happens after an await has already yielded.
  const runFetch = useCallback(async () => {
    const data = await fetchStorageUsage();
    setUsage(data);
    setLoading(false);
  }, [fetchStorageUsage]);

  // The refresh button's onClick — a synchronous setLoading(true) here is
  // fine, since a click handler isn't an effect body.
  const handleRefresh = useCallback(() => {
    setLoading(true);
    runFetch();
  }, [runFetch]);

  // `loading` already starts true (useState(true) below), so the initial
  // mount needs no extra setLoading(true) — this just needs to fetch.
  // A plain one-shot fetch-on-mount for read-only stats, not a subscription
  // to an external system — exactly the case react.dev's own guidance on this
  // rule (linked in the rule's message) says an effect is still the right
  // tool for. AppContext's own main data-fetch effect hits this identical
  // rule unsuppressed as pre-existing baseline debt; this one is suppressed
  // explicitly instead of silently growing that count.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { runFetch(); }, [runFetch]);

  if (!loading && !usage) return null; // local-only mode, or the call failed — dbRun already toasted the error

  const pct = usage ? Math.min(100, (usage.total_bytes / FREE_TIER_LIMIT_BYTES) * 100) : 0;
  const severity = severityFor(pct);

  return (
    <div className="card storage-usage-card" style={{ marginBottom: '16px' }}>
      <div className="card-body">
        <div className="storage-usage-header">
          <div className="storage-usage-title">
            <Database size={16} />
            <span>Database storage</span>
          </div>
          <button
            className="btn-icon"
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh storage usage"
          >
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          </button>
        </div>

        {usage && (
          <>
            <div className="storage-usage-value">
              <span className="storage-usage-used">{formatBytes(usage.total_bytes)}</span>
              <span className="storage-usage-of"> of {formatBytes(FREE_TIER_LIMIT_BYTES)} used</span>
            </div>

            <div className={`storage-meter storage-meter-${severity.tone}`}>
              <div className="storage-meter-fill" style={{ width: `${pct}%` }} />
            </div>

            <div className="storage-usage-footer">
              <span className={`storage-usage-status storage-usage-status-${severity.tone}`}>
                {severity.label} · {pct.toFixed(1)}%
              </span>
              <button className="storage-usage-toggle" onClick={() => setExpanded(e => !e)}>
                {expanded ? 'Hide breakdown' : 'Show breakdown'}
              </button>
            </div>

            {expanded && (
              <table className="storage-usage-table">
                <tbody>
                  {usage.tables.map(t => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td>{formatBytes(t.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="storage-usage-caption">
              Limit confirmed against Supabase's own Organization → Usage page
              (0.5 GB, Free plan). If you ever change plans, that page always
              has the number that actually applies.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
