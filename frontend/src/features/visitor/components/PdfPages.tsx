import { InlineLoading, InlineNotification, Link } from '@carbon/react';
import { useEffect, useRef, useState } from 'react';

/** Shows a same-origin PDF as canvases; the pdf.js renderer is imported only when this mounts (the modal opens). */
export function PdfPages({ url }: { url: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const container = host.current;
    if (!container) return;
    import('./renderPdf')
      .then(({ renderPdf }) => renderPdf(url, container, controller.signal, () => setStatus('ready')))
      .then(() => setStatus('ready'))
      .catch(() => {
        if (!controller.signal.aborted) setStatus('failed');
      });
    return () => controller.abort();
  }, [url]);

  return (
    <div className="visitor-pdf">
      {status === 'loading' && <InlineLoading description="Loading Lab Rules…" />}
      {status === 'failed' && (
        <>
          {/* Carbon's InlineNotification throws on interactive children, so the link sits below it. */}
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The Lab Rules could not be displayed."
            subtitle="Try again, or open the document in a separate tab."
          />
          <Link href={url} target="_blank" rel="noreferrer">
            Open in new tab
          </Link>
        </>
      )}
      <div ref={host} className="visitor-pdf__pages" />
    </div>
  );
}
