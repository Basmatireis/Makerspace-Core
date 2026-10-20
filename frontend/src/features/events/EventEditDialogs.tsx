import {
  Button,
  Checkbox,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { updateEventSession, updateEventTaskList } from '../../api/generated/events/events';
import type {
  EventSession,
  EventTaskList,
  UpdateEventSessionRequest,
  UpdateEventTaskListRequest,
} from '../../api/generated/models';
import { instantToZonedDateTimeValue } from '../../app/dateTime';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { toISO } from './format';
import { DialogProps } from './eventDialogProps';

type SessionValues = {
  name: string;
  location: string;
  description: string;
  startsAt: string;
  endsAt: string;
  isPublic: boolean;
  status: EventSession['status'];
};

export function SessionEditDialog({
  eventId,
  session,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { session: EventSession }) {
  const formId = `edit-event-session-${session.id}`;
  const form = useForm<SessionValues>({
    defaultValues: {
      name: session.name ?? '',
      location: session.location ?? '',
      description: session.description ?? '',
      startsAt: instantToZonedDateTimeValue(session.startsAt),
      endsAt: instantToZonedDateTimeValue(session.endsAt),
      isPublic: session.isPublic,
      status: session.status,
    },
  });
  const mutation = useMutation({
    mutationFn: (value: SessionValues) =>
      updateEventSession(eventId, session.id, {
        name: value.name || null,
        location: value.location || null,
        description: value.description || null,
        startsAt: toISO(value.startsAt),
        endsAt: toISO(value.endsAt),
        isPublic: value.isPublic,
        status: value.status,
        expectedVersion: session.version,
      } satisfies UpdateEventSessionRequest),
    onSuccess: onSaved,
  });
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);
  const close = useLatestCallback(() => {
    if (!mutation.isPending) onClose();
    return false;
  });
  return (
    <ComposedModal open={open} onClose={close} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Edit session" />
      <ModalBody hasScrollingContent>
        <form
          id={formId}
          onSubmit={form.handleSubmit((value) => {
            if (!mutation.isPending) mutation.mutate(value);
          })}
        >
          <Stack gap={5}>
            {mutation.error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Session not saved"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <Controller
              name="name"
              control={form.control}
              render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name (optional)" />}
            />
            <Controller
              name="location"
              control={form.control}
              render={({ field }) => <TextInput {...field} id={`${formId}-location`} labelText="Location (optional)" />}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field }) => (
                <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />
              )}
            />
            <Controller
              name="startsAt"
              control={form.control}
              rules={{ required: true }}
              render={({ field }) => (
                <TextInput {...field} id={`${formId}-starts`} type="datetime-local" labelText="Starts" required />
              )}
            />
            <Controller
              name="endsAt"
              control={form.control}
              rules={{ required: true }}
              render={({ field }) => (
                <TextInput {...field} id={`${formId}-ends`} type="datetime-local" labelText="Ends" required />
              )}
            />
            <Controller
              name="status"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-status`} labelText="Status">
                  <SelectItem value="scheduled" text="Scheduled" />
                  <SelectItem value="cancelled" text="Cancelled" />
                </Select>
              )}
            />
            <Controller
              name="isPublic"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id={`${formId}-public`}
                  labelText="Show publicly"
                  checked={field.value}
                  onChange={(_, data) => field.onChange(data.checked)}
                />
              )}
            />
          </Stack>
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={mutation.isPending}>
          Save changes
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

type TaskListValues = { name: string; description: string };

export function TaskListEditDialog({
  eventId,
  list,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { list: EventTaskList }) {
  const formId = `edit-event-task-list-${list.id}`;
  const form = useForm<TaskListValues>({ defaultValues: { name: list.name, description: list.description ?? '' } });
  const mutation = useMutation({
    mutationFn: (value: TaskListValues) =>
      updateEventTaskList(eventId, list.id, {
        name: value.name,
        description: value.description || null,
        sortOrder: list.sortOrder,
        expectedVersion: list.version,
      } satisfies UpdateEventTaskListRequest),
    onSuccess: onSaved,
  });
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);
  const close = useLatestCallback(() => {
    if (!mutation.isPending) onClose();
    return false;
  });
  return (
    <ComposedModal open={open} onClose={close} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Edit task list" />
      <ModalBody>
        <form
          id={formId}
          onSubmit={form.handleSubmit((value) => {
            if (!mutation.isPending) mutation.mutate(value);
          })}
        >
          <Stack gap={5}>
            {mutation.error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Task list not saved"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <Controller
              name="name"
              control={form.control}
              rules={{ required: true }}
              render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name" required />}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field }) => (
                <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />
              )}
            />
          </Stack>
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={mutation.isPending}>
          Save changes
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
