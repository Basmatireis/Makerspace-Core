import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** CSS pixels per millimetre at 100 % (96 dpi). */
export const PX_PER_MM = 96 / 25.4;
/** CSS pixels per PDF point. */
const PX_PER_PT = 96 / 72;

/** Parses a base64 PDF with pdf.js; the renderer and its worker are loaded on first use. */
export async function openPdf(base64: string): Promise<PDFDocumentProxy> {
  const { loadPdfData } = await import('../../app/pdf/renderPdf');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return loadPdfData(bytes);
}

/**
 * Draws one page into `canvas` at `resolution` device pixels per CSS pixel (at 100 % zoom). The page is drawn into an
 * off-screen canvas first and copied over, so the visible canvas never flashes empty while a new render is made.
 */
export async function drawPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  resolution: number,
  signal: AbortSignal,
): Promise<void> {
  const page = await doc.getPage(pageNumber);
  signal.throwIfAborted();
  const viewport = page.getViewport({ scale: PX_PER_PT * resolution });
  const buffer = document.createElement('canvas');
  buffer.width = Math.floor(viewport.width);
  buffer.height = Math.floor(viewport.height);
  const task = page.render({ canvas: buffer, viewport });
  const cancel = () => task.cancel();
  signal.addEventListener('abort', cancel);
  try {
    await task.promise;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  signal.throwIfAborted();
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext('2d')?.drawImage(buffer, 0, 0);
}
