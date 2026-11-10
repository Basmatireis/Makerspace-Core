import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { getPublicLegalDocument } from '../../api/generated/branding/branding';
import { ErrorState, InlineLoadingState } from '../../app/PageState';

const QrCode = lazy(() => import('../auth/mfa/QrCode'));

export type LegalDocumentKind = 'imprint' | 'privacy';

/**
 * A legal document shown on top of a kiosk page. A kiosk cannot leave its page: the desktop app blocks other
 * websites and a kiosk browser has no way back. An external document is framed; a site that refuses to be framed
 * stays empty, so the QR code opens it on the visitor's phone instead. Links inside the frame stay inside it.
 */
export default function LegalDocumentModal({ kind, onClose }: { kind: LegalDocumentKind; onClose: () => void }) {
  const documentQuery = useQuery({
    queryKey: ['branding', 'legal', kind],
    queryFn: ({ signal }) => getPublicLegalDocument(kind, { signal }),
  });
  const fallbackTitle = kind === 'imprint' ? 'Imprint' : 'Privacy policy';
  const legalDocument = documentQuery.data;
  const externalUrl = legalDocument?.mode === 'external' ? legalDocument.externalUrl : undefined;
  const title = legalDocument?.title ?? fallbackTitle;

  // On document.body: inside a page header the overlay would neither cover nor darken the page.
  return createPortal(
    <ComposedModal open size="lg" onClose={onClose} aria-label={title} className="legal-document-modal">
      <ModalHeader title={title} />
      <ModalBody className="legal-document-modal__body">
        {documentQuery.isPending && <InlineLoadingState label={`Loading ${fallbackTitle.toLowerCase()}`} />}
        {documentQuery.isError && (
          <ErrorState
            title={`${fallbackTitle} unavailable`}
            message="The legal information could not be loaded."
            onRetry={() => void documentQuery.refetch()}
          />
        )}
        {externalUrl ? (
          <div className="legal-document-modal__external">
            <iframe
              className="legal-document-modal__frame"
              src={externalUrl}
              title={title}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
            />
            <div className="legal-document-modal__phone">
              <Suspense fallback={null}>
                <QrCode value={externalUrl} label={`QR code for ${externalUrl}`} size={96} />
              </Suspense>
              <p>Page stays empty? Scan the code to read it on your phone.</p>
            </div>
          </div>
        ) : legalDocument?.markdown ? (
          <div className="markdown-content">
            <ReactMarkdown
              components={{
                // The kiosk cannot follow links to other websites.
                a: ({ children }) => <span>{children}</span>,
              }}
            >
              {legalDocument.markdown}
            </ReactMarkdown>
          </div>
        ) : (
          legalDocument && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Not configured"
              subtitle="No content has been published for this legal document."
            />
          )
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="primary" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </ComposedModal>,
    document.body,
  );
}
