import { parsePhoneNumberFromString } from 'libphonenumber-js';

// One instance, reused — Intl.DisplayNames does its own internal caching
// setup that's wasteful to repeat per call.
let regionNames;
function countryNameFromISO(iso2) {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(iso2) || iso2;
  } catch {
    // Intl.DisplayNames is unavailable (very old browser) — the ISO code is
    // still more useful than nothing.
    return iso2;
  }
}

// Shared by both exports below — parses a phone number via
// libphonenumber-js's real per-country metadata rather than a
// hand-maintained calling-code table. This is what actually resolves NANP
// (+1) down to a specific country — US, Canada, Jamaica, Bahamas, etc. —
// by checking the number's area code against each country's real
// numbering plan, and similarly splits Russia from Kazakhstan under +7. It
// also validates the number looks like a real one for that country, so a
// mistyped or truncated number is more likely to come back unknown than
// confidently wrong.
//
// Returns null when the number has no determinable country — no
// international prefix at all ("+"/"00"), or digits that don't match any
// known numbering plan.
function cleanAndParsePhone(phone) {
  if (!phone) return null;

  // Leads imported from Excel sometimes carry a leading apostrophe (from
  // the source sheet forcing the cell to text so "+" survives) — strip that
  // and any other stray characters libphonenumber-js wouldn't expect, while
  // leaving the spaces/dashes/parens it already knows how to parse through.
  let cleaned = phone.replace(/[^\d+()\- ]/g, '').trim();
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (!cleaned.startsWith('+')) return null;

  return parsePhoneNumberFromString(cleaned) || null;
}

// Best-effort country name from a phone number — see cleanAndParsePhone above.
export function getCountryFromPhone(phone) {
  const parsed = cleanAndParsePhone(phone);
  if (!parsed || !parsed.country) return null;
  return countryNameFromISO(parsed.country);
}

// Same lookup, but the raw ISO 3166-1 alpha-2 code (e.g. "US", "IN")
// instead of a display name — what WorldMap keys into the map SVG's
// per-country path ids with, which use the same alpha-2 codes.
export function getCountryCodeFromPhone(phone) {
  const parsed = cleanAndParsePhone(phone);
  return (parsed && parsed.country) || null;
}
