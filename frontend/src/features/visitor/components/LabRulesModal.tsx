import { Modal } from '@carbon/react';
import { useEffect } from 'react';
import { PdfPages } from './PdfPages';

export const labRulesPdfUrl = '/api/v1/visitor-enrollment/lab-rules.pdf';

/** Large modal showing the current Lab Rules PDF inline; pdf.js is fetched only once the modal is first opened. */
export function LabRulesModal({ open, revision, onClose }: { open: boolean; revision: string; onClose: () => void }) {
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
      {open && <PdfPages url={labRulesPdfUrl} />}
    </Modal>
  );
}
