import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useEffect, useRef } from 'react';
import { drawPage } from '../renderPreview';
import { useDebouncedValue } from '../useDebouncedValue';

/** One page of the preview PDF. It is drawn at the resolution of the zoom it settled on, so zooming does not redraw per step. */
export function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  label,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** Current zoom (1 = 100 %). */
  scale: number;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settled = useDebouncedValue(scale, 250);
  // Sharp at the zoom the person stopped on, but never an enormous bitmap.
  const resolution = Math.min(Math.max(settled, 1) * Math.max(1, window.devicePixelRatio || 1), 3);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const controller = new AbortController();
    drawPage(doc, pageNumber, target, resolution, controller.signal).catch(() => {
      /* cancelled by a newer render, or the document was replaced: the next effect run draws the page */
    });
    return () => controller.abort();
  }, [doc, pageNumber, resolution]);

  return <canvas ref={canvas} className="pdft-page__canvas" role="img" aria-label={label} />;
}
