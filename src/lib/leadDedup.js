// The single definition of "these two enquiries are the same one".
//
// Deliberately does NOT include the exact timestamp. The first version of
// this feature matched on all eight fields including created_at, which only
// worked while every export parsed byte-identically forever — one timezone
// shift, Excel version change, or export-format tweak and duplicates would
// pour in silently. Since this spreadsheet is re-uploaded every week or
// month with overlapping rows, that fragility was the whole problem.
//
// Matching on WHO + WHAT + WHICH DAY instead is stable across all of that,
// while still letting the same person send a genuinely new enquiry on a
// later day.
//
// Must stay in lockstep with the `dedup_key` generated column in
// supabase_leads_dedup.sql — the database is the real enforcement (it holds
// even if two people import at the same moment); this copy exists so the app
// can grey out likely-duplicate rows in the import preview beforehand.

// Collapses runs of whitespace and trims, so a message that picked up a
// stray newline or double space between exports still matches.
function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

// Calendar day in UTC. Matching the database's
// `(created_at AT TIME ZONE 'UTC')::date` exactly — using local time here
// would put a late-evening enquiry on a different day than Postgres does.
function utcDateKey(createdAt) {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// Returns null when there is nothing identifying to match on — a manual
// entry with no email and no message is never treated as a duplicate,
// mirroring the NULL dedup_key case in the database (Postgres unique
// indexes let NULLs repeat).
//
// The two normalisations differ on purpose, matching the SQL exactly: email
// gets btrim + lower (SQL's `lower(btrim(email))`), message additionally
// gets internal whitespace collapsed (SQL's `regexp_replace(..., '\s+', ' ',
// 'g')`). Collapsing inside an email here but not there would make this
// preview disagree with what the database actually does.
export function leadDedupKey(lead) {
  const email = (lead.email || '').trim().toLowerCase();
  const message = normalizeText(lead.message);
  if (!email && !message) return null;
  return `${email}|${message}|${utcDateKey(lead.createdAt)}`;
}

export function isDuplicateLead(candidate, existing) {
  const key = leadDedupKey(candidate);
  if (key === null) return false;
  return existing.some(l => leadDedupKey(l) === key);
}
