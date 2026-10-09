// Task completion is binary (pending/completed). While a task is pending, its
// "% complete" is derived purely from hours logged against the hours targeted —
// there is no manually-set intermediate status.
export function getTaskPercent(task) {
  if (task.status === 'completed') return 100;
  const targeted = Number(task.targetedTime) || 0;
  if (targeted <= 0) return 0;
  const taken = Number(task.timeTaken) || 0;
  return Math.min(Math.round((taken / targeted) * 100), 100);
}

// How much of the task is still outstanding: 100% before any hours are booked,
// counting down as they go in. This is what the "% Pending" badge shows — the
// progress bar keeps using getTaskPercent, since that fills up as work is done.
export function getTaskPendingPercent(task) {
  if (task.status === 'completed') return 0;
  return 100 - getTaskPercent(task);
}

export function isTaskExceeded(task) {
  const targeted = Number(task.targetedTime) || 0;
  const taken = Number(task.timeTaken) || 0;
  return targeted > 0 && taken > targeted;
}

// A carried-forward ORIGINAL keeps status:'pending' forever — only its clone
// (the new task in next month, linked via carryForwardFrom) tracks the real
// remaining work. Once completed is ruled out, carryForwardTo being set is
// what distinguishes "moved on, tracked elsewhere" from "genuinely still
// open, no action taken" — a distinction plain status can't make on its own,
// especially once the task's own month is in the past.
//
// Deliberately period-scoped, NOT chain-following — used for AGGREGATE
// counting (Dashboard's KPI cards, Monthly Report's whole rollup/breakdown
// tables) where a task counting as "not done in June" has to stay true even
// if the work eventually got finished in July, or June's completion rate
// would silently drift after the fact. See getEffectiveStatus below for the
// other kind of question ("what's this task's status right now") that a
// single row on Tasks Completed or Schedule actually needs answered.
export function isCarriedForward(task) {
  return task.status !== 'completed' && !!task.carryForwardTo;
}

// Follows carryForwardTo forward to the LAST task in the chain — a task can
// be carried forward more than once (May -> June -> July if it keeps
// slipping), and the actual remaining work only ever lives at the end of
// that chain, never at an intermediate link. Guards against a corrupted/
// circular chain with `seen` so a bad carryForwardTo can never infinite-loop.
function latestInChain(task, tasksById) {
  let current = task;
  const seen = new Set();
  while (current.carryForwardTo && tasksById?.has(current.carryForwardTo) && !seen.has(current.id)) {
    seen.add(current.id);
    current = tasksById.get(current.carryForwardTo);
  }
  return current;
}

// The status to actually SHOW for one specific task — as opposed to
// isCarriedForward's period-scoped "did this count as done in its own
// month" question. If task A was carried forward to B, and B has since been
// completed, A's own `status` field never changes (only B's does) — so
// without following the chain, A would show "Carried Forward" forever even
// after the real work is finished. This is what fixes that: it resolves to
// whatever the END of the chain currently says, so every task along a
// resolved chain reads "Completed" once the work genuinely is, not just the
// clone that happens to hold the final status flag.
//
// `tasksById` is required (a Map of every task keyed by id, from
// AppContext's `tasksById`) — this needs global context a single task object
// can't provide on its own. Used wherever an INDIVIDUAL row is being shown
// to a person (Schedule, Tasks Completed, Task Detail, Monthly Report's
// itemized Pending Tasks list) — never for aggregate counting, which stays
// on isCarriedForward above for the reason explained there.
export function getEffectiveStatus(task, tasksById) {
  if (task.status === 'completed') return 'completed';
  if (task.carryForwardTo) {
    const latest = latestInChain(task, tasksById);
    if (latest.status === 'completed') return 'completed';
    return 'carried_forward';
  }
  return 'pending';
}
