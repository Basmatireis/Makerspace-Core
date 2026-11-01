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
