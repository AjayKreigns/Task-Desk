// Whether month/year has already ended relative to the real wall-clock date —
// NOT the page's selectedMonth/selectedYear filter, which may be viewing a
// different period than "now" (e.g. Full Year mode, or browsing last month).
// Callers combine this with !isSuperAdmin themselves — this helper is pure
// date math, with no awareness of who's asking.
export function isPastPeriod(month, year) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  return year < currentYear || (year === currentYear && month < currentMonth);
}
