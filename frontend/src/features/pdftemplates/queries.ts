import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import {
  getPdfTemplate,
  listPdfTemplateAssets,
  listPdfTemplateVersions,
  previewPdfTemplate,
} from '../../api/generated/pdf-templates/pdf-templates';
import type {
  PdfTemplateDocument,
  PdfTemplateExport,
  PdfTemplatePreview,
  PdfTemplateSource,
} from '../../api/generated/models';

export const pdfTemplateKey = (kind: PdfTemplateExport) => ['pdf-templates', kind] as const;

export const pdfTemplateQuery = (kind: PdfTemplateExport) =>
  queryOptions({ queryKey: pdfTemplateKey(kind), queryFn: ({ signal }) => getPdfTemplate(kind, { signal }) });

export const pdfTemplateVersionsQuery = (kind: PdfTemplateExport, enabled: boolean) =>
  queryOptions({
    queryKey: [...pdfTemplateKey(kind), 'versions'] as const,
    queryFn: ({ signal }) => listPdfTemplateVersions(kind, { signal }),
    enabled,
  });

/** Which data a preview is rendered with. */
export type PreviewSourceChoice = { kind: 'sample' } | { kind: 'record'; id: string };
export const toApiSource = (choice: PreviewSourceChoice): PdfTemplateSource =>
  choice.kind === 'sample' ? { kind: 'sample' } : { kind: 'record', id: choice.id };

/** A preview with how long the server round trip took. */
export type TimedPreview = PdfTemplatePreview & { ms: number };

/**
 * The render of a working document. The key carries a small serial number of the (immutable) document object instead of
 * the document itself, which can be hundreds of kilobytes; `placeholderData` keeps the previous render on screen while the
 * next one is made.
 */
export const pdfPreviewQuery = (
  kind: PdfTemplateExport,
  serial: number,
  document: PdfTemplateDocument,
  source: PreviewSourceChoice,
) =>
  queryOptions({
    queryKey: [...pdfTemplateKey(kind), 'preview', source, serial] as const,
    queryFn: async ({ signal }): Promise<TimedPreview> => {
      const started = performance.now();
      const preview = await previewPdfTemplate(kind, { document, source: toApiSource(source) }, { signal });
      return { ...preview, ms: Math.round(performance.now() - started) };
    },
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });

const serials = new WeakMap<object, number>();
let lastSerial = 0;
/** A stable small number for an immutable object, for query keys. */
export function serialOf(value: object): number {
  let serial = serials.get(value);
  if (serial === undefined) {
    lastSerial += 1;
    serial = lastSerial;
    serials.set(value, serial);
  }
  return serial;
}

export const pdfTemplateAssetsKey = ['pdf-templates', 'assets'] as const;

/** The images and SVG artwork uploaded for templates. */
export const pdfTemplateAssetsQuery = () =>
  queryOptions({
    queryKey: pdfTemplateAssetsKey,
    queryFn: ({ signal }) => listPdfTemplateAssets({ signal }),
  });
