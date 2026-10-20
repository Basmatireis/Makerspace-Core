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
import { updateEventShift } from '../../api/generated/events/events';
import type { EventSession, EventShift, UpdateEventShiftRequest } from '../../api/generated/models';
import { instantToZonedDateTimeValue } from '../../app/dateTime';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { toISO } from './format';
import { DialogProps } from './eventDialogProps';

type ShiftValues = {
  sessionId: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  signupOpensAt: string;
  signupClosesAt: string;
  isPublic: boolean;
  status: EventShift['status'];
};

export function ShiftEditDialog({
  eventId,
  shift,
  sessions,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { shift: EventShift; sessions: EventSession[] }) {
  const formId = `edit-event-shift-${shift.id}`;
  const form = useForm<ShiftValues>({
    defaultValues: {
      sessionId: shift.sessionId ?? '',
      name: shift.name,
      description: shift.description ?? '',
      startsAt: instantToZonedDateTimeValue(shift.startsAt),
      endsAt: instantToZonedDateTimeValue(shift.endsAt),
      signupOpensAt: shift.signupOpensAt ? instantToZonedDateTimeValue(shift.signupOpensAt) : '',
      signupClosesAt: shift.signupClosesAt ? instantToZonedDateTimeValue(shift.signupClosesAt) : '',
      isPublic: shift.isPublic,
      status: shift.status,
    },
  });
  const mutation = useMutation({
    mutationFn: (value: ShiftValues) =>
      updateEventShift(eventId, shift.id, {
        sessionId: value.sessionId || null,
        name: value.name,
        description: value.description || null,
        startsAt: toISO(value.startsAt),
        endsAt: toISO(value.endsAt),
        signupOpensAt: value.signupOpensAt ? toISO(value.signupOpensAt) : null,
        signupClosesAt: value.signupClosesAt ? toISO(value.signupClosesAt) : null,
        isPublic: value.isPublic,
        status: value.status,
        expectedVersion: shift.version,
      } satisfies UpdateEventShiftRequest),
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
      <ModalHeader title="Edit shift" />
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
                title="Shift not saved"
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
            <Controller
              name="sessionId"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-session`} labelText="Linked session (optional)">
                  <SelectItem value="" text="No linked session" />
                  {sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id} text={session.name ?? 'Official session'} />
                  ))}
                </Select>
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
              name="signupOpensAt"
              control={form.control}
              render={({ field }) => (
                <TextInput
                  {...field}
                  id={`${formId}-signup-opens`}
                  type="datetime-local"
                  labelText="Signup opens (optional)"
                />
              )}
            />
            <Controller
              name="signupClosesAt"
              control={form.control}
              render={({ field }) => (
                <TextInput
                  {...field}
                  id={`${formId}-signup-closes`}
                  type="datetime-local"
                  labelText="Signup closes (optional)"
                />
              )}
            />
            <Controller
              name="status"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-status`} labelText="Status">
                  <SelectItem value="draft" text="Draft" />
                  <SelectItem value="open" text="Open" />
                  <SelectItem value="closed" text="Closed" />
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
