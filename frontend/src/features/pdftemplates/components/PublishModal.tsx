import { InlineLoading, InlineNotification, Modal } from '@carbon/react';
import type { PdfTemplateExport } from '../../../api/generated/models';

/** What publishing changes, per document. */
const EFFECT: Record<PdfTemplateExport, string> = {
  wiref: 'Invoice requests forwarded to wiRef from now on are rendered with it.',
  cashbook: 'Cashbook exports use it from now on. Exports made earlier are not changed.',
  receipt: 'Receipts downloaded from now on use it.',
};

export interface PublishModalProps {
  kind: PdfTemplateExport;
  templateName: string;
  /** The number the version will get. */
  version: number;
  /** Unsaved edits are saved as the draft first. */
  unsaved: boolean;
  warnings: number;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function PublishModal({
  kind,
  templateName,
  version,
  unsaved,
  warnings,
  pending,
  error,
  onClose,
  onConfirm,
}: PublishModalProps) {
  return (
    <Modal
      open
      size="sm"
      modalLabel={templateName}
      modalHeading={`Publish version ${version}?`}
      primaryButtonText="Publish"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      onRequestClose={onClose}
      onRequestSubmit={onConfirm}
    >
      <p>{EFFECT[kind]}</p>
      <p className="pdft-modal__note">
        The previous version stays in the history and can be restored. Publishing is recorded in the audit log.
        {unsaved ? ' Your unsaved changes are saved as the draft first.' : ''}
      </p>
      {warnings > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${warnings} warning${warnings === 1 ? '' : 's'}`}
          subtitle="Some blocks render nothing where they are. You can still publish."
        />
      )}
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not published" subtitle={error} />}
      {pending && <InlineLoading description="Publishing…" />}
    </Modal>
  );
}
