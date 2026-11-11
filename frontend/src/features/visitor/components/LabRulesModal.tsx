import { Modal } from '@carbon/react';
import { useEffect, useRef } from 'react';
import { PdfPages } from '../../../app/pdf/PdfPages';
import { scrolledToEnd } from '../../../app/pdf/useReadToEnd';

export const labRulesPdfUrl = '/api/v1/visitor-enrollment/lab-rules.pdf';

/** Large modal showing the current Lab Rules PDF inline; pdf.js is fetched only once the modal is first opened. */
export function LabRulesModal({
  open,
  revision,
  onClose,
  onReadToEnd,
}: {
  open: boolean;
  revision: string;
  onClose: () => void;
  /** Called once the PDF has been scrolled to its end (or fits without scrolling, or could not be shown). */
  onReadToEnd: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  // Carbon's modal body is the scrolling box around the pages.
  const scroller = () => content.current?.closest<HTMLElement>('.cds--modal-content');
  const check = () => {
    const box = scroller();
    if (box && scrolledToEnd(box)) onReadToEnd();
  };
  useEffect(() => {
    const box = open ? scroller() : undefined;
    if (!box) return;
    box.addEventListener('scroll', check, { passive: true });
    return () => box.removeEventListener('scroll', check);
  });
  // The focused close button's tooltip swallows Escape before Carbon's document listener sees it, so listen on capture.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  return (
    <Modal
      open={open}
      size="lg"
      passiveModal
      modalHeading={`Lab Rules, revision ${revision}`}
      aria-label={`Lab Rules, revision ${revision}`}
      onRequestClose={onClose}
      className="visitor-pdf-modal"
    >
      <div ref={content}>
        {open && <PdfPages url={labRulesPdfUrl} onDone={(ok) => (ok ? check() : onReadToEnd())} />}
      </div>
    </Modal>
  );
}
