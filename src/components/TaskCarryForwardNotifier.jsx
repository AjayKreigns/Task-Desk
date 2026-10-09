import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { scoped } from '../lib/localCache';
import { isMonthEndWarningDay, nextCarryForwardDate } from '../lib/carryForwardDates';
import CarryForwardAcknowledgeModal from './CarryForwardAcknowledgeModal';

const BATCH_ACK_KEY = 'td_carryforward_batch_ack'; // personal — only written when Acknowledge is clicked
const ADMIN_SEEN_KEY = 'td_carryforward_admin_seen'; // team summary — auto-written like an ordinary toast
const WARNING_SEEN_KEY = 'td_carryforward_warning_seen';

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Renders nothing OF ITS OWN — mounted once in Layout.jsx (persists across
// tab switches) purely to run the detection checks below and surface a
// notification through the app's existing toast/panel system, or (for the
// personal carry-forward result specifically) a blocking acknowledge modal.
// No new backend notification table: a server-scheduled pg_cron job did the
// actual work (see supabase_task_auto_carryforward.sql); this component's
// only responsibility is noticing that on the next time the app happens to
// be open.
export default function TaskCarryForwardNotifier() {
  const { tasks, logActivity } = useApp();
  const { user, myEmployeeId, canViewAll, authReady } = useAuth();
  const { notify } = useNotification();
  // { batch, tasks: [...] } while an unacknowledged personal batch is
  // pending, else null. Deliberately real component state, not just a
  // notify() call — a toast can be missed or auto-dismiss; this has to stay
  // on screen, and reappear on every reload, until explicitly acknowledged.
  const [pendingAck, setPendingAck] = useState(null);

  // --- 1. Month-end warning — pure date check, independent of task data.
  // Goes to everyone regardless of task status (a blanket reminder), once
  // per calendar month, on whichever day the app is next opened on or after
  // the day before the last day of the month. Unaffected by the
  // acknowledge-modal change below — this is a heads-up before the fact, not
  // a record of what happened, so a normal toast is still the right tool.
  useEffect(() => {
    if (!authReady) return;
    const today = new Date();
    if (!isMonthEndWarningDay(today)) return;

    const key = scoped(WARNING_SEEN_KEY, user?.id);
    const thisMonth = monthKey(today);
    if (readLocal(key) === thisMonth) return;

    const nextMonthDate = nextCarryForwardDate(today);
    const nextMonthName = nextMonthDate.toLocaleString('default', { month: 'long' });
    notify(
      'info',
      'Update your progress',
      `Incomplete tasks will be automatically carried forward to ${nextMonthName} ${nextMonthDate.getFullYear()} on ${nextMonthName} 4th. Wrap up what you can before then.`,
    );
    writeLocal(key, thisMonth);
  }, [authReady, user?.id, notify]);

  // --- 2. Carry-forward result. Two different audiences, two different
  // mechanisms: the admin team summary is an FYI stat and stays an ordinary
  // toast (auto-marked seen once shown, same as before). The PERSONAL "your
  // tasks moved" notice is what accountability actually hinges on, so it
  // becomes a pendingAck instead of a notify() call — never marked seen
  // automatically, only when handleAcknowledge below actually runs.
  useEffect(() => {
    if (!authReady || tasks.length === 0) return;

    const autoForwarded = tasks.filter((t) => t.carryForwardBatch);
    if (autoForwarded.length === 0) return;

    // ISO date strings (YYYY-MM-DD) sort correctly with plain string
    // comparison, so this finds the most recent batch without parsing dates.
    const latestBatch = autoForwarded.reduce(
      (max, t) => (t.carryForwardBatch > max ? t.carryForwardBatch : max),
      autoForwarded[0].carryForwardBatch,
    );

    if (canViewAll) {
      const adminKey = scoped(ADMIN_SEEN_KEY, user?.id);
      if (readLocal(adminKey) !== latestBatch) {
        const teamBatch = autoForwarded.filter((t) => t.carryForwardBatch === latestBatch);
        if (teamBatch.length > 0) {
          const uniqueAssignees = new Set(teamBatch.map((t) => t.assignedTo).filter(Boolean)).size;
          notify(
            'info',
            'Team carry-forward summary',
            `${teamBatch.length} incomplete task${teamBatch.length !== 1 ? 's' : ''} across ${uniqueAssignees} team member${uniqueAssignees !== 1 ? 's' : ''} were automatically carried forward this month.`,
          );
        }
        writeLocal(adminKey, latestBatch);
      }
    }

    const ackKey = scoped(BATCH_ACK_KEY, user?.id);
    if (readLocal(ackKey) === latestBatch) return; // already explicitly acknowledged

    const mine = autoForwarded.filter((t) => t.carryForwardBatch === latestBatch && t.assignedTo === myEmployeeId);
    if (mine.length > 0) {
      // Same category as StorageUsageCard's fetch-on-mount effect: a
      // one-shot detection running from data already loaded, not a
      // subscription to an external system — the case react.dev's own
      // guidance on this rule still calls out an effect as the right tool
      // for. Unlike notify() elsewhere in this file (which the linter can't
      // trace into, so it stays unflagged), this is a LOCAL useState setter,
      // which the rule's static analysis correctly recognizes directly.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingAck({ batch: latestBatch, tasks: mine });
    }
  }, [authReady, tasks, myEmployeeId, canViewAll, user?.id, notify]);

  const handleAcknowledge = () => {
    if (!pendingAck) return;
    writeLocal(scoped(BATCH_ACK_KEY, user?.id), pendingAck.batch);
    // The actual proof: an entry on each affected task's own activity log
    // (already visible in TaskDetailModal's Activity tab) — logActivity sets
    // its own real timestamp automatically, shown there via timeAgo(), so
    // "were they notified, and when" is checkable per task, not just trusted.
    pendingAck.tasks.forEach((t) => {
      logActivity('Carry-Forward Acknowledged', t.title, `${user?.email || 'This user'} confirmed they were notified this task moved to this month.`, t.id);
    });
    setPendingAck(null);
  };

  if (pendingAck) {
    return <CarryForwardAcknowledgeModal tasks={pendingAck.tasks} onAcknowledge={handleAcknowledge} />;
  }
  return null;
}
