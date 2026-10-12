import {
  Button,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createEvent } from '../../api/generated/events/events';
import type { CreateEventRequest } from '../../api/generated/models';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { eventKeys } from './queries';

type EventCreateDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function EventCreateDialog({ open, onClose }: EventCreateDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<CreateEventRequest>({
    defaultValues: { name: '', internalDescription: null, location: null, ownerPersonId: null },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty, onDiscard: () => form.reset() });
  const mutation = useMutation({
    mutationFn: (input: CreateEventRequest) => createEvent(input),
    onSuccess: async (event) => {
      await queryClient.invalidateQueries({ queryKey: eventKeys.all });
      guard.bypassAfterSubmit(() => navigate(`/events/${event.id}`, { replace: true }));
    },
  });
  const requestClose = useLatestCallback(() => {
    if (!mutation.isPending) guard.requestDiscard(onClose);
    return false;
  });
  const submit = form.handleSubmit((value) => {
    if (!mutation.isPending) mutation.mutate(value);
  });

  return <>
    <ComposedModal
      open={open && !guard.dialogOpen}
      onClose={requestClose}
      size="sm"
      preventCloseOnClickOutside
      selectorPrimaryFocus="#event-name"
      aria-label="Create event"
    >
      <ModalHeader
        title="Create event"
        label="Start with the internal details. The owner is assigned later in Settings."
        closeModal={requestClose}
      />
      <ModalBody hasScrollingContent>
        <form id="create-event-form" onSubmit={submit}>
          <Stack gap={5}>
            {mutation.isError && <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Event not created"
              subtitle={eventMutationMessage(mutation.error)}
            />}
            <Controller
              name="name"
              control={form.control}
              rules={{ required: 'Enter an internal event name.', maxLength: { value: 200, message: 'Use 200 characters or fewer.' } }}
              render={({ field, fieldState }) => <TextInput {...field} id="event-name" labelText="Internal event name" invalid={Boolean(fieldState.error)} invalidText={fieldState.error?.message} />}
            />
            <Controller
              name="location"
              control={form.control}
              rules={{ maxLength: { value: 500, message: 'Use 500 characters or fewer.' } }}
              render={({ field, fieldState }) => <TextInput id="event-location" labelText="Internal location" value={field.value ?? ''} onBlur={field.onBlur} onChange={(event) => field.onChange(event.target.value || null)} invalid={Boolean(fieldState.error)} invalidText={fieldState.error?.message} />}
            />
            <Controller
              name="internalDescription"
              control={form.control}
              rules={{ maxLength: { value: 10_000, message: 'Use 10,000 characters or fewer.' } }}
              render={({ field, fieldState }) => <TextArea id="event-description" labelText="Internal description" value={field.value ?? ''} onBlur={field.onBlur} onChange={(event) => field.onChange(event.target.value || null)} rows={7} invalid={Boolean(fieldState.error)} invalidText={fieldState.error?.message} />}
            />
          </Stack>
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" type="button" onClick={requestClose} disabled={mutation.isPending}>Cancel</Button>
        <Button type="submit" form="create-event-form" disabled={mutation.isPending}>{mutation.isPending ? 'Creating…' : 'Create event'}</Button>
      </ModalFooter>
    </ComposedModal>
    <UnsavedChangesDialog guard={guard} />
  </>;
}
