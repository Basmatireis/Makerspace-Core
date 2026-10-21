import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useLatestCallback } from './useLatestCallback';

export type DestructiveActionDialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  error?: string;
  launcherButtonRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
};

export function DestructiveActionDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  pending = false,
  error,
  launcherButtonRef,
  onConfirm,
  onClose,
}: DestructiveActionDialogProps) {
  const wasOpenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // The element to return focus to must be captured during the render that opens the dialog: Carbon moves focus into
  // the modal in a child effect that runs before any effect of this component could read document.activeElement.
  /* eslint-disable react-hooks/refs */
  if (open && !wasOpenRef.current) {
    returnFocusRef.current =
      launcherButtonRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    wasOpenRef.current = true;
  }
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const returnFocus = returnFocusRef.current;
    // Selected-record dialogs can unmount outright when their target is cleared.
    // Restore on both that path and an ordinary open=false transition.
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open]);

  const close = useLatestCallback(() => {
    if (!pending) onClose();
  });
  const confirm = useLatestCallback(() => {
    if (!pending) onConfirm();
  });

  if (!open) return null;

  return (
    <Modal
      open={open}
      danger
      alert
      modalHeading={title}
      primaryButtonText={pending ? `${confirmLabel}…` : confirmLabel}
      secondaryButtonText={cancelLabel}
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      launcherButtonRef={launcherButtonRef}
      selectorPrimaryFocus=".cds--btn--secondary"
      shouldSubmitOnEnter={false}
      onRequestClose={close}
      onSecondarySubmit={close}
      onRequestSubmit={confirm}
    >
      <Stack gap={5}>
        {children}
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Action failed" subtitle={error} />
        )}
      </Stack>
    </Modal>
  );
}
