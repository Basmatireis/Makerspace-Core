import { InlineNotification, Modal, MultiSelect, Stack, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import type { Role } from '../../api/generated/models';
import { sendNotificationMessage } from '../../api/generated/notifications/notifications';
import { ApiError } from '../../api/http-client';
import { fullRoleCatalogOptions } from '../roles/queries';
import { notificationKeys } from './queries';

export const MAX_TITLE = 120;
export const MAX_BODY = 2000;

type Values = { title: string; body: string; link: string; roleIds: string[] };

function sendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.data?.code;
    if (error.status === 429) return 'You sent many messages recently. Try again later.';
    if (code === 'no_recipients') return 'Nobody with an active account holds the chosen roles.';
    if (code === 'unknown_role') return 'One of the chosen roles no longer exists. Reload and choose again.';
    if (error.status === 422) return error.message;
  }
  return 'The message could not be sent. Check the connection and try again.';
}

/** Writes a plain-text message to the people who currently hold any of the chosen roles. */
export function NewMessageModal({ canListRoles, onClose }: { canListRoles: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const roles = useQuery({ ...fullRoleCatalogOptions, enabled: canListRoles });
  const form = useForm<Values>({ defaultValues: { title: '', body: '', link: '', roleIds: [] } });
  const { errors } = form.formState;
  const send = useMutation({
    mutationFn: (values: Values) =>
      sendNotificationMessage({
        title: values.title.trim(),
        body: values.body.trim(),
        roleIds: values.roleIds,
        ...(values.link.trim() ? { link: values.link.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      onClose();
    },
  });
  const options: Role[] = roles.data ?? [];

  return (
    <Modal
      open
      size="md"
      modalHeading="New message"
      modalLabel="Messages"
      primaryButtonText={send.isPending ? 'Sending…' : 'Send message'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={send.isPending || !canListRoles}
      onRequestClose={() => {
        if (!send.isPending) onClose();
      }}
      onRequestSubmit={() => void form.handleSubmit((values) => send.mutate(values))()}
    >
      <form noValidate onSubmit={(event) => event.preventDefault()}>
        <Stack gap={5}>
          <p className="notification-form__hint">
            The message goes to everyone who holds one of the chosen roles right now and appears in their notifications
            for 90 days. It is plain text.
          </p>
          <TextInput
            id="message-title"
            labelText="Title"
            maxCount={MAX_TITLE}
            invalid={Boolean(errors.title)}
            invalidText={errors.title?.message}
            {...form.register('title', {
              validate: (value) => {
                const length = value.trim().length;
                if (length === 0) return 'Enter a title.';
                return length <= MAX_TITLE || `Use at most ${MAX_TITLE} characters.`;
              },
            })}
          />
          <TextArea
            id="message-body"
            labelText="Text"
            rows={5}
            enableCounter
            maxCount={MAX_BODY}
            invalid={Boolean(errors.body)}
            invalidText={errors.body?.message}
            {...form.register('body', {
              validate: (value) => {
                const length = value.trim().length;
                if (length === 0) return 'Enter the text of the message.';
                return length <= MAX_BODY || `Use at most ${MAX_BODY} characters.`;
              },
            })}
          />
          <TextInput
            id="message-link"
            labelText="Link (optional)"
            helperText="A page in this application, for example /open-days."
            invalid={Boolean(errors.link)}
            invalidText={errors.link?.message}
            {...form.register('link', {
              validate: (value) => {
                const link = value.trim();
                if (!link) return true;
                return (
                  (link.startsWith('/') && !link.startsWith('//') && !/[\s\\]/.test(link)) ||
                  'Enter a path that starts with a single “/”, without spaces.'
                );
              },
            })}
          />
          {canListRoles ? (
            <Controller
              control={form.control}
              name="roleIds"
              rules={{ validate: (value) => value.length > 0 || 'Choose at least one role.' }}
              render={({ field }) => (
                <MultiSelect
                  autoAlign
                  id="message-roles"
                  titleText="Send to roles"
                  label={roles.isPending ? 'Loading roles…' : 'Choose roles'}
                  items={options}
                  itemToString={(role: Role | null) => role?.name ?? ''}
                  selectedItems={options.filter((role) => field.value.includes(role.id))}
                  invalid={Boolean(errors.roleIds)}
                  invalidText={errors.roleIds?.message}
                  disabled={roles.isPending}
                  onChange={({ selectedItems }: { selectedItems: Role[] | null }) =>
                    field.onChange((selectedItems ?? []).map((role) => role.id))
                  }
                />
              )}
            />
          ) : (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Roles cannot be listed"
              subtitle="Choosing roles needs the permission to view roles. Ask an administrator to add it to your role."
            />
          )}
          {roles.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Roles could not be loaded"
              subtitle="Close this dialog and try again."
            />
          )}
          {send.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Message not sent"
              subtitle={sendErrorMessage(send.error)}
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
