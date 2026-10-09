// Built-in task categories. Users can add their own in Team & Websites →
// Categories; the merged list is exposed as `categories` from AppContext.
export const DEFAULT_CATEGORIES = [
  'SEO - New Content',
  'SEO - Rewrite Content',
  'Content Marketing',
  'Social Media',
  'PPC / Ads',
  'Email Marketing',
  'Web Development',
  'Analytics',
  'Design',
  'Reviewed',
  'Other',
];

// Seed colours for categories. The first entries back the built-ins, the rest
// are offered as free picks when adding new ones. Each is visually distinct so
// the donut chart and its legend stay readable.
export const CATEGORY_PALETTE = [
  '#7c3aed', '#0284c7', '#059669', '#d97706', '#db2777',
  '#e11d48', '#4f46e5', '#0891b2', '#65a30d', '#ea580c',
  '#9333ea', '#0d9488', '#475569', '#c026d3', '#2563eb',
  '#16a34a', '#ca8a04', '#dc2626', '#7e22ce', '#0369a1',
  '#be123c', '#15803d', '#a16207', '#1d4ed8',
];

// Accepts '#abc', 'abc', '#AABBCC' → '#aabbcc'; returns '' when unparseable.
export function normalizeHex(hex) {
  if (!hex) return '';
  let h = String(hex).trim().toLowerCase();
  if (!h.startsWith('#')) h = `#${h}`;
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = `#${h.slice(1).split('').map(c => c + c).join('')}`;
  }
  return /^#[0-9a-f]{6}$/.test(h) ? h : '';
}

// Mixes a colour toward white — used for the lighter stop of each pie gradient.
export function lighten(hex, amount = 0.4) {
  const h = normalizeHex(hex) || CATEGORY_PALETTE[0];
  const n = parseInt(h.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function defaultCategoryColor(index) {
  return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
}
