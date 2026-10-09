// Excel (and other spreadsheet apps) treats a cell value starting with
// =, +, -, @, tab, or CR as a formula to evaluate on open — a classic CSV/XLSX
// "formula injection" (CWE-1236). Every export in this app writes
// user-controlled strings (task titles/notes, and — via the public
// ingest_website_lead webhook — enquiry name/company/message/source URL
// submitted by anonymous website visitors) straight into exported cells, so
// an attacker-planted payload can run when a teammate later opens the file.
// Prefixing a lone `'` neutralizes it in Excel/LibreOffice/Google Sheets
// without changing what a normal value displays as.
const RISKY_LEADING_CHARS = ['=', '+', '-', '@', '\t', '\r'];

export function sanitizeExcelCell(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return RISKY_LEADING_CHARS.includes(value[0]) ? `'${value}` : value;
}

// Applies sanitizeExcelCell to every string value in a flat row object —
// call this on each row immediately before XLSX.utils.json_to_sheet().
export function sanitizeExcelRow(row) {
  const safe = {};
  for (const key of Object.keys(row)) {
    safe[key] = sanitizeExcelCell(row[key]);
  }
  return safe;
}
