import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { SentNotificationMessage } from '../../api/generated/models';
import { updateNotificationMessage } from '../../api/generated/notifications/notifications';
import { ApiError } from '../../api/http-client';
import { MessageFields, type MessageFieldValues } from './MessageFields';
import { notificationKeys } from './queries';

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'The message no longer exists. Close this dialog and reload the list.';
    if (error.status === 422) return error.message;
  }
  return 'The message could not be changed. Check the connection and try again.';
}

/** Changes title, text and link of a sent message for every recipient; the roles stay as they were. */
export function EditMessageModal({ message, onClose }: { message: SentNotificationMessage; onClose: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<MessageFieldValues>({
    defaultValues: { title: message.title, body: message.body, link: message.link ?? '' },
  });
  const save = useMutation({
    mutationFn: (values: MessageFieldValues) =>
      updateNotificationMessage(message.id, {
        title: values.title.trim(),
        body: values.body.trim(),
        link: values.link.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      onClose();
    },
  });

  return (
    <Modal
      open
      size="md"
      modalHeading="Edit message"
      modalLabel="Messages"
      primaryButtonText={save.isPending ? 'Saving…' : 'Save changes'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      onRequestClose={() => {
        if (!save.isPending) onClose();
      }}
      onRequestSubmit={() => void form.handleSubmit((values) => save.mutate(values))()}
    >
      <form noValidate onSubmit={(event) => event.preventDefault()}>
        <Stack gap={5}>
          <p className="notification-form__hint">
            The change reaches everyone who got the message, including people who already read it. The roles cannot be
            changed.
          </p>
          <MessageFields form={form} />
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Message not changed"
              subtitle={saveErrorMessage(save.error)}
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
