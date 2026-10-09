// Shared lead field helpers — date parsing/formatting and the
// converted/pending/not-converted status vocabulary. Originally private to
// LeadCenter.jsx; pulled out so MonthlyReport.jsx's enquiries section can use
// the EXACT SAME date parsing and status labels rather than a second copy
// that could quietly drift from this one.

export const STATUS_LABEL = { yes: 'Converted', no: 'Not Converted', '': 'Pending Review' };

// A lead's raw `converted` field is 'yes' | 'no' | '' — '' meaning "Pending
// Review", same three buckets STATUS_LABEL already names.
export function leadStatusKey(lead) {
  return lead.converted === 'yes' || lead.converted === 'no' ? lead.converted : '';
}

// Day 0 of Excel's 1900 date system.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// Excel stores a timestamp as a fractional day, so converting to and from it
// loses sub-second precision — a round-trip turns 09:30:00.000 into
// 09:29:59.999. Harmless on its own, but at exactly midnight UTC that 1ms
// lands on the PREVIOUS calendar day, which would change both the date shown
// in the table and the day duplicate detection groups by. Every timestamp
// this app deals with is whole seconds, so snapping to the nearest second
// removes the noise without inventing precision.
function roundToSecond(d) {
  return new Date(Math.round(d.getTime() / 1000) * 1000);
}

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  // Date and number both arrive from XLSX (a parsed date cell, or a raw
  // serial) — the two paths that carry Excel's fractional-day noise. ISO
  // strings come from our own storage and are already exact, so they are
  // left alone.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : roundToSecond(value);
  // A bare number here is an Excel date serial (days since 1899-12-30) that
  // slipped through unconverted, not a JS millisecond timestamp — treating it
  // as ms would land in early 1970 (a serial like 46247 is only ~46 seconds
  // after the Unix epoch), which is exactly the "Jan 1, 1970" bug this guards
  // against. XLSX.read's cellDates:true option (see ImportLeadsModal) already
  // converts most date cells for us; this is the fallback for the rest.
  if (typeof value === 'number') {
    const d = new Date(EXCEL_EPOCH_MS + value * 86400000);
    return Number.isNaN(d.getTime()) ? null : roundToSecond(d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Rendered in UTC, not the viewer's local timezone, for two reasons that both
// matter here. First, the spreadsheet's timestamps carry no timezone, and the
// importer reads them as UTC — so showing them back in UTC round-trips to
// exactly the date the website recorded, instead of shifting by the viewer's
// offset. Second, duplicate detection groups by UTC calendar day
// (src/lib/leadDedup.js); rendering local days would put two rows on the same
// visible date while the dedup treated them as different days, which reads as
// a bug even though nothing is wrong.
export function formatDate(iso) {
  const d = parseDate(iso);
  return d
    ? d.toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '—';
}
