import { InlineLoading, InlineNotification, Link } from '@carbon/react';
import { useEffect, useRef, useState } from 'react';
import './pdf.scss';

/** Shows a same-origin PDF as canvases; the pdf.js renderer is imported only when this mounts (when it is shown). */
export function PdfPages({
  url,
  onDone,
}: {
  url: string;
  /** Called once every page is rendered (true), or when the document could not be shown (false). */
  onDone?: (ok: boolean) => void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    const controller = new AbortController();
    const container = host.current;
    if (!container) return;
    import('./renderPdf')
      .then(({ renderPdf }) => renderPdf(url, container, controller.signal, () => setStatus('ready')))
      .then(() => {
        setStatus('ready');
        if (!controller.signal.aborted) done.current?.(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus('failed');
        done.current?.(false);
      });
    return () => controller.abort();
  }, [url]);

  return (
    <div className="pdf-viewer">
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
      <div ref={host} className="pdf-viewer__pages" />
    </div>
  );
}
