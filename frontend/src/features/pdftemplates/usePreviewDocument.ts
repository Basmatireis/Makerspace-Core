import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfTemplatePreview } from '../../api/generated/models';
import { openPdf } from './renderPreview';

export interface ShownPreview<P extends PdfTemplatePreview = PdfTemplatePreview> {
  preview: P;
  /** Null when pdf.js could not open the PDF: the page frames and boxes still work. */
  doc: PDFDocumentProxy | null;
}

/**
 * Opens the PDF of the newest preview. The page boxes and the PDF are swapped in together, once the new PDF is parsed, so
 * the overlay never describes another render than the canvases below it.
 */
export function usePreviewDocument<P extends PdfTemplatePreview>(preview: P | undefined) {
  const [shown, setShown] = useState<ShownPreview<P> | null>(null);
  const current = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    const publish = (doc: PDFDocumentProxy | null) => {
      const previous = current.current;
      current.current = doc;
      setShown({ preview, doc });
      // A page of the old document may still be mid-render; give it a moment before freeing the worker's copy.
      if (previous && previous !== doc) window.setTimeout(() => void previous.loadingTask.destroy(), 1000);
    };
    openPdf(preview.pdf).then(
      (doc) => {
        if (cancelled) void doc.loadingTask.destroy();
        else publish(doc);
      },
      () => {
        if (!cancelled) publish(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [preview]);

  useEffect(
    () => () => {
      void current.current?.loadingTask.destroy();
    },
    [],
  );

  return shown;
}
