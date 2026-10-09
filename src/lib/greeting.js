// Rotates the Dashboard welcome banner's greeting term once per calendar day —
// same greeting for everyone on a given day, deterministically re-derived from
// the date each render, so no localStorage entry is needed to remember it.
export const GREETING_TERMS = [
  'Howdy',
  'Hello',
  'Hi there',
  'Good day',
  'Welcome back',
  'Greetings',
  'Good to see you',
  'Hey there',
];

export function getGreeting(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return GREETING_TERMS[dayOfYear % GREETING_TERMS.length];
}
