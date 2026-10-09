// Applies the saved theme before first paint. Without this the first frame
// is always light, because React's theme effect hasn't run yet. Barely
// noticeable on the dashboard; very noticeable on a full-screen login or
// loading screen.
//
// A real file, not inline in index.html: CSP's script-src 'self' (no
// 'unsafe-inline') blocks an inline <script> block outright — this ran as a
// blocked, silently-failing no-op on every single page load until that CSP
// violation was traced. A same-origin external file needs no CSP exception
// at all, unlike a hash- or nonce-based allowance, which would also have to
// be kept in sync by hand on every future edit to this script.
try {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('td_theme') || 'light');
} catch (e) { /* storage unavailable — React will set it shortly */ }
