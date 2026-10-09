import { AlertTriangle } from 'lucide-react';
import { isCarryForwardWarningWindow, upcomingCarryForwardDate, formatCarryForwardDate } from '../lib/carryForwardDates';

// An in-page reminder, shown across a wider window than the one-shot toast/
// panel notification TaskCarryForwardNotifier fires (that one stays a single
// day, tracked with a "seen" flag so it doesn't repeat). This banner instead
// spans from the Monday of the month's last week all the way through to the
// day the automated carry-forward actually runs — deliberately NOT tracked
// with a "seen" flag, since it's meant to keep being visible on every visit
// throughout that whole run-up, not just announce itself once. Both this and
// the toast read from the same shared date logic in lib/carryForwardDates.js,
// so they can't drift out of sync on what "the run date" actually is.
export default function CarryForwardWarningBanner() {
  const today = new Date();
  if (!isCarryForwardWarningWindow(today)) return null;

  const runDate = upcomingCarryForwardDate(today);
  // The month whose incomplete tasks are the ones about to move — always the
  // calendar month right before runDate's, e.g. September for an October 4th
  // run. Deriving it from runDate itself (rather than from `today`) keeps it
  // correct across the month boundary too, same as runDate's own cycle logic.
  const sourceMonthName = new Date(runDate.getFullYear(), runDate.getMonth() - 1, 1)
    .toLocaleString('default', { month: 'long' });

  return (
    <div className="carryforward-warning-banner">
      <AlertTriangle size={18} />
      <div>
        <strong>Heads up - {sourceMonthName} auto carry-forward happens on {formatCarryForwardDate(runDate)}.</strong>
        <span> Any task still incomplete this month will automatically move to next month. Wrap up what you can before then.</span>
      </div>
    </div>
  );
}
