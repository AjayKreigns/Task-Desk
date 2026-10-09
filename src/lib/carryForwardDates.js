// Shared date logic for the auto carry-forward feature, used by both
// TaskCarryForwardNotifier (the toast/panel warning) and
// CarryForwardWarningBanner (the in-page banner on Tasks Completed) — kept
// in one place so the two can never quietly disagree about which day counts
// as "the warning day" or what the next carry-forward date actually is.

// Local calendar date, not UTC. This is a purely human-facing check ("does
// today feel like month-end to the person looking at their screen"), unlike
// the UTC-based date boundaries used elsewhere for STORED/exported data
// (Lead Center's dedup key, its month filter) where cross-timezone
// consistency of the data itself is what matters. IST is UTC+5:30, so a
// UTC-based check here could disagree with the team's actual wall-clock day
// by several hours near midnight.
export function isMonthEndWarningDay(date) {
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return date.getDate() === lastDayOfMonth - 1;
}

// The date the next auto carry-forward run will happen — the 4th of next
// month, matching the pg_cron schedule in supabase_task_auto_carryforward.sql
// ('0 2 4 * *'). If that schedule ever changes, this is the one place to
// update so every notification/banner stays in sync with it.
export function nextCarryForwardDate(today = new Date()) {
  return new Date(today.getFullYear(), today.getMonth() + 1, 4);
}

// "October 3, 2026" — used everywhere this date is shown to a person, so the
// wording never drifts between the toast, the panel entry, and the banner.
export function formatCarryForwardDate(date) {
  return date.toLocaleDateString('default', { month: 'long', day: 'numeric', year: 'numeric' });
}

// The Monday of a month's final week — the last Monday on or before that
// month's last day.
function mondayOfLastWeek(monthAnchor) {
  const lastDay = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0);
  const dow = lastDay.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const monday = new Date(lastDay);
  monday.setDate(lastDay.getDate() - daysSinceMonday);
  return monday;
}

// Which month's carry-forward cycle "today" currently belongs to. On the
// 1st, 2nd, or 3rd of a month, LAST month's carry-forward hasn't run yet —
// it runs on the 4th — so those days still belong to last month's cycle, not
// the new month's (whose own cycle won't start until ITS last week). Every
// other day belongs to its own month's cycle.
function cycleMonthAnchor(today) {
  return today.getDate() <= 3
    ? new Date(today.getFullYear(), today.getMonth() - 1, 1)
    : new Date(today.getFullYear(), today.getMonth(), 1);
}

// The wider banner window (as opposed to isMonthEndWarningDay's single toast
// day): from the Monday of the current cycle's last week through — but not
// including — the day the automated carry-forward actually runs. Spans the
// month boundary correctly: it's still showing on the 1st/2nd/3rd of the new
// month (the run hasn't happened yet), and stops the moment day 4 arrives,
// handing off to the "tasks were carried forward" result notification.
export function isCarryForwardWarningWindow(today) {
  const anchor = cycleMonthAnchor(today);
  const windowStart = mondayOfLastWeek(anchor);
  const runDate = nextCarryForwardDate(anchor);
  return today >= windowStart && today < runDate;
}

// The date to DISPLAY while the window above is active — same cycle logic,
// so it stays correct (still "next month's 4th", not a month further out)
// across the boundary too.
export function upcomingCarryForwardDate(today) {
  return nextCarryForwardDate(cycleMonthAnchor(today));
}
