import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SentNotificationMessage } from '../../api/generated/models';
import { retractNotificationMessage } from '../../api/generated/notifications/notifications';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { notificationKeys } from './queries';

/** Deletes a sent message together with every recipient's copy. */
export function RetractMessageModal({ message, onClose }: { message: SentNotificationMessage; onClose: () => void }) {
  const queryClient = useQueryClient();
  const retract = useMutation({
    mutationFn: () => retractNotificationMessage(message.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      onClose();
    },
  });
  return (
    <DestructiveActionDialog
      open
      title="Retract this message?"
      confirmLabel="Retract message"
      pending={retract.isPending}
      error={retract.isError ? 'The message could not be retracted. Check the connection and try again.' : undefined}
      onConfirm={() => retract.mutate()}
      onClose={onClose}
    >
      <p>It disappears for everyone, including people who already read it.</p>
      <p>
        <strong>{message.title}</strong>
      </p>
    </DestructiveActionDialog>
  );
}
