import type { PrinterErrorSeverity } from '../../../api/generated/models';

type TagType = 'red' | 'outline' | 'blue' | 'purple';

export const severityLabel: Record<PrinterErrorSeverity, string> = {
  fatal: 'Fatal',
  serious: 'Serious',
  common: 'Common',
  info: 'Info',
};

export const severityHelp: Record<PrinterErrorSeverity, string> = {
  fatal: 'The printer cannot continue and needs attention right away.',
  serious: 'Something is wrong that will probably ruin or stop the print.',
  common: 'Frequent, usually harmless messages such as a filament run-out or a door left open.',
  info: 'Notices that need no action.',
};

export const severityOrder: PrinterErrorSeverity[] = ['fatal', 'serious', 'common', 'info'];

type ErrorLike = { sourceFamily: string; severity?: PrinterErrorSeverity | null };

/** Common and info HMS notices are not the printer's real problems; print errors and unrated codes always count. */
export const isNotice = (error: ErrorLike) =>
  error.sourceFamily !== 'print' && (error.severity === 'common' || error.severity === 'info');

export function severityTag(error: ErrorLike): { label: string; type: TagType } {
  if (error.sourceFamily === 'print') return { label: 'Print error', type: 'red' };
  switch (error.severity) {
    case 'fatal':
    case 'serious':
      return { label: severityLabel[error.severity], type: 'red' };
    case 'common':
      return { label: severityLabel.common, type: 'outline' };
    case 'info':
      return { label: severityLabel.info, type: 'blue' };
    default:
      return { label: 'Warning', type: 'purple' };
  }
}

/** Only web links are rendered as anchors; the catalog is edited by people, so never trust a scheme. */
export const safeLink = (link: string | null | undefined) => (link && /^https?:\/\//i.test(link) ? link : null);

const levelSeverity: Record<number, PrinterErrorSeverity> = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };

/** The level a Bambu HMS code carries in its third group (AAAA-BBBB-CCCC-DDDD), read as the server reads it. */
export function codeSeverity(sourceFamily: string, code: string): PrinterErrorSeverity | null {
  if (sourceFamily !== 'hms') return null;
  const groups = code.trim().split('-');
  if (groups.length !== 4 || !/^[0-9a-f]{1,4}$/i.test(groups[2])) return null;
  return levelSeverity[parseInt(groups[2], 16)] ?? null;
}

/** Printer modules named by the first byte of a Bambu code, for HMS codes and print errors alike. */
export const printerComponents = [
  { id: '03', label: 'Motion controller' },
  { id: '05', label: 'Mainboard' },
  { id: '07', label: 'AMS' },
  { id: '08', label: 'Toolhead' },
  { id: '0C', label: 'Camera' },
] as const;

/** The module id (the first two hex digits) of a code, or null when the code does not start with them. */
export const codeComponentId = (code: string) => {
  const head = code.trim().slice(0, 2).toUpperCase();
  return /^[0-9A-F]{2}$/.test(head) ? head : null;
};

/** Human name of the module a code belongs to; other modules show their id. */
export function codeComponent(code: string): string | null {
  const id = codeComponentId(code);
  if (!id) return null;
  return printerComponents.find((component) => component.id === id)?.label ?? `Module ${id}`;
}
