import { InlineNotification } from '@carbon/react';
import { ApiError } from '../../../api/http-client';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { Confirmation } from './deviceShared';

export function ConfirmationModal({
  value,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  value: Confirmation;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const revoke = value?.kind === 'revoke';
  const deletingType = value?.kind === 'delete-type';
  const name = value?.kind === 'delete-type' ? value.type.name : value?.device.name;
  const errorMessage =
    error instanceof ApiError && error.status === 409
      ? deletingType
        ? 'This type is still used by a device or role permission.'
        : 'The device changed in another session. Reload and try again.'
      : error?.message;
  return (
    <DestructiveActionDialog
      open={Boolean(value)}
      title={revoke ? `Revoke ${name}?` : deletingType ? `Delete device type ${name}?` : `Delete ${name}?`}
      confirmLabel={revoke ? 'Revoke device' : deletingType ? 'Delete device type' : 'Delete device'}
      pending={pending}
      error={errorMessage}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p>
        {revoke
          ? 'Its token and all device-scoped privileges stop working immediately. Revocation cannot be reversed.'
          : deletingType
            ? 'The device type will be permanently deleted. Deletion is blocked while a device or role permission still references it.'
            : 'The revoked device record, capability configuration, and device reports will be permanently deleted. Audit history is retained.'}
      </p>
    </DestructiveActionDialog>
  );
}

export function MutationError({
  title,
  error,
  conflictMessage,
}: {
  title: string;
  error: Error;
  conflictMessage?: string;
}) {
  const message =
    conflictMessage && error instanceof ApiError && error.status === 409 ? conflictMessage : error.message;
  return <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={message} />;
}
