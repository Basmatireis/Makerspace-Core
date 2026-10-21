import { InlineNotification, Modal, Stack } from '@carbon/react';
import type { ReactNode } from 'react';

/**
 * Confirmation for lifecycle changes and deletions. Body order: the blocking reason (if any), one sentence of
 * consequence (children), then an optional list of details. When the rules block the action the confirm button stays
 * disabled; a server error appears below.
 */
export function ConfirmDialog({
  heading,
  label,
  confirmText,
  danger = false,
  blocked,
  pending = false,
  error,
  details,
  onClose,
  onConfirm,
  children,
}: {
  heading: string;
  label?: string;
  confirmText: string;
  danger?: boolean;
  blocked?: string;
  pending?: boolean;
  error?: string;
  details?: string[];
  onClose: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open
      size="sm"
      danger={danger && !blocked}
      modalHeading={heading}
      modalLabel={label}
      primaryButtonText={pending ? 'Working…' : confirmText}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={Boolean(blocked) || pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={onConfirm}
    >
      <Stack gap={5}>
        {blocked && (
          <InlineNotification kind="warning" lowContrast hideCloseButton title="Not possible" subtitle={blocked} />
        )}
        <div className="evf-confirm">
          {children}
          {details && details.length > 0 && (
            <ul>
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Action failed" subtitle={error} />
        )}
      </Stack>
    </Modal>
  );
}
