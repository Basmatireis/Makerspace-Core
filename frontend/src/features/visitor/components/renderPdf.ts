import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';

// A Vite worker entry: it is emitted as a hashed .js file on our own origin (nginx serves .mjs as octet-stream).
GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
  type: 'module',
});

/**
 * Renders every page of a same-origin PDF into canvases appended to `container` with pdf.js. The Android terminal
 * WebView cannot show PDFs natively and the CSP forbids object/embed, so this is the only inline path. This module
 * and the worker it points at are loaded lazily, only when the Lab Rules modal opens. pdf.js 6 never evaluates
 * code, so no CSP exception is needed. Resolves after the last page; `onFirstPage` fires as soon as page 1 is drawn.
 */
export async function renderPdf(url: string, container: HTMLElement, signal: AbortSignal, onFirstPage: () => void) {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('PDF request failed');
  const data = new Uint8Array(await response.arrayBuffer());
  const task = getDocument({ data });
  const onAbort = () => void task.destroy();
  signal.addEventListener('abort', onAbort);
  try {
    const pdf = await task.promise;
    container.replaceChildren();
    const width = Math.max(container.clientWidth, 280);
    const ratio = window.devicePixelRatio || 1;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      signal.throwIfAborted();
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const canvas = document.createElement('canvas');
      canvas.className = 'visitor-pdf__page';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(base.height * scale * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${Math.floor(base.height * scale)}px`;
      container.append(canvas);
      await page.render({ canvas, viewport: page.getViewport({ scale: scale * ratio }) }).promise;
      if (number === 1) onFirstPage();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    void task.destroy();
  }
}
