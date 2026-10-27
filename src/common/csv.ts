type Cell = string | number | null | undefined;

const escape = (v: Cell) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Leading = + - @ would run as formulas when opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV with a BOM so Excel opens it as UTF-8 (₦, accents, curly quotes). */
export function toCsv(header: string[], rows: Cell[][]) {
  return (
    '\uFEFF' +
    [header, ...rows].map((r) => r.map(escape).join(',')).join('\r\n') +
    '\r\n'
  );
}
