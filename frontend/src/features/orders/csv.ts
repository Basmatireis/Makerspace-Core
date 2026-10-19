// Client-side CSV for the cashbook export, in the form German and Austrian spreadsheets open directly: semicolon separated, amounts with a
// decimal comma (12,50), UTF-8 with a byte order mark so umlauts are right. No "sep=;" line: it would push the byte order mark out of first place and
// Excel would stop reading the file as UTF-8. Cells with a semicolon, a quote or a line break are quoted. Text that a spreadsheet could read as a formula
// is prefixed with an apostrophe; plain numbers are left alone.

const BOM = String.fromCharCode(0xfeff);
const FORMULA = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+([.,]\d+)?$/;

export type CsvCell = string | number | null | undefined;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value).replace('.', ',');
  const text = FORMULA.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return `${BOM}${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

/** Hands the text to the browser as a file download. */
export function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
