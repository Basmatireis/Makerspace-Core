import type { PdfTemplateExport } from '../../api/generated/models';

export const EXPORT_LABELS: Record<PdfTemplateExport, string> = {
  wiref: 'wiRef invoice request',
  cashbook: 'Cashbook (Kassabuch)',
  receipt: 'Order receipt',
  projektantrag: 'Projektantrag (working-group project)',
};

export const EXPORT_KINDS = Object.keys(EXPORT_LABELS) as PdfTemplateExport[];
