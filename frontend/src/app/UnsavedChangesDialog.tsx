import type { ReactNode } from 'react';
import { DestructiveActionDialog } from './DestructiveActionDialog';
import type { UnsavedChangesGuard } from './useUnsavedChanges';

export type UnsavedChangesDialogProps = {
  guard: UnsavedChangesGuard;
  title?: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
};

export function UnsavedChangesDialog({
  guard,
  title = 'Discard unsaved changes?',
  message = 'Your changes have not been saved.',
  confirmLabel = 'Discard changes',
  cancelLabel = 'Keep editing',
}: UnsavedChangesDialogProps) {
  return (
    <DestructiveActionDialog
      open={guard.dialogOpen}
      title={title}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onClose={guard.keepEditing}
      onConfirm={guard.confirmDiscard}
    >
      <p>{message}</p>
    </DestructiveActionDialog>
  );
}
