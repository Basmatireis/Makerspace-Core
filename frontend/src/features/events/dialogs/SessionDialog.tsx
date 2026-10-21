import { Checkbox, InlineNotification, Modal, TextArea, TextInput, TimePicker } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { createEventSession, updateEventSession } from '../../../api/generated/events/events';
import type { Event, EventSession } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { dateInAppTimeZone, timeInAppTimeZone } from '../../../app/dateTime';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { FieldRow, FormSection, FormSections, OvernightHint } from '../components/FormSection';
import { eventMutationMessage } from '../errors';
import { endDayOf, overnightHint, toInstant } from '../format';
import { invalidateEvents } from '../queries';
import { sessionBody } from '../requestBodies';

type Values = {
  name: string;
  location: string;
  description: string;
  date: string;
  start: string;
  endDate: string;
  end: string;
  isPublic: boolean;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Adds or edits a programme session: what visitors attend. */
export function SessionDialog({
  event,
  session,
  lastDate,
  onClose,
}: {
  event: Event;
  session?: EventSession;
  /** The day of the latest session, so the next one starts on the same day. */
  lastDate?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const initialDate = session
    ? dateInAppTimeZone(session.startsAt)
    : (lastDate ?? dateInAppTimeZone(new Date(Date.now() + 7 * 86_400_000)));
  const form = useForm<Values>({
    defaultValues: {
      name: session?.name ?? '',
      location: session ? (session.location ?? '') : (event.location ?? ''),
      description: session?.description ?? '',
      date: initialDate,
      start: session ? timeInAppTimeZone(session.startsAt) : '10:00',
      endDate: session ? dateInAppTimeZone(session.endsAt) : initialDate,
      end: session ? timeInAppTimeZone(session.endsAt) : '14:00',
      isPublic: session?.isPublic ?? true,
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const save = useMutation({
    mutationFn: (value: Values) => {
      const input = {
        name: value.name.trim() || null,
        location: value.location.trim() || null,
        description: value.description.trim() || null,
        startsAt: toInstant(value.date, value.start),
        endsAt: toInstant(endDayOf(value.date, value.start, value.end, value.endDate), value.end),
        isPublic: value.isPublic,
      };
      return session
        ? updateEventSession(event.id, session.id, sessionBody(session, input))
        : createEventSession(event.id, { ...input, status: 'scheduled' });
    },
    onSuccess: async () => {
      await invalidateEvents(client);
      guard.bypassAfterSubmit(onClose);
    },
  });
  const requestClose = useLatestCallback(() => {
    if (!save.isPending) guard.requestDiscard(onClose);
  });
  const submit = form.handleSubmit((value) => {
    if (!save.isPending) save.mutate(value);
  });
  const isPublic = form.watch('isPublic');
  const date = form.watch('date');
  const endDate = form.watch('endDate');
  return (
    <>
      <Modal
        open={!guard.dialogOpen}
        size="md"
        modalHeading={session ? 'Edit session' : 'Add session'}
        modalLabel={event.name}
        primaryButtonText={save.isPending ? 'Saving…' : session ? 'Save session' : 'Add session'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={save.isPending}
        preventCloseOnClickOutside
        onRequestClose={requestClose}
        onRequestSubmit={() => void submit()}
      >
        <FormSections>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Session not saved"
              subtitle={eventMutationMessage(save.error)}
            />
          )}
          <FormSection title="Basics">
            <TextInput
              id="ev-session-name"
              labelText="Name (optional)"
              helperText="Shown on the public page."
              maxLength={200}
              {...form.register('name')}
            />
            <TextInput id="ev-session-location" labelText="Location" maxLength={500} {...form.register('location')} />
            <TextArea
              id="ev-session-description"
              labelText="Description (optional)"
              rows={3}
              maxLength={10000}
              {...form.register('description')}
            />
          </FormSection>
          <FormSection title="When">
            <FieldRow cols={3}>
              <Controller
                name="date"
                control={form.control}
                rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <DateInput
                    id="ev-session-date"
                    labelText="Day"
                    value={field.value}
                    onChange={(next) => {
                      // The end day follows the start day until someone sets a different one.
                      if (form.getValues('endDate') === field.value)
                        form.setValue('endDate', next, { shouldDirty: true });
                      field.onChange(next);
                    }}
                    invalid={Boolean(fieldState.error)}
                    invalidText="Choose a day."
                  />
                )}
              />
              <TimePicker
                id="ev-session-start"
                labelText="Start (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                invalid={Boolean(form.formState.errors.start)}
                invalidText="Use HH:MM."
                {...form.register('start', { required: true, pattern: CLOCK })}
              />
              <TimePicker
                id="ev-session-end"
                labelText="End (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                invalid={Boolean(form.formState.errors.end)}
                invalidText="The end must be after the start."
                {...form.register('end', {
                  required: true,
                  pattern: CLOCK,
                  validate: (value, values) =>
                    `${endDayOf(values.date, values.start, value, values.endDate)}T${value}` >
                    `${values.date}T${values.start}`,
                })}
              />
            </FieldRow>
            <OvernightHint text={overnightHint(date, form.watch('start'), form.watch('end'), endDate)} />
            {endDate !== date && (
              <Controller
                name="endDate"
                control={form.control}
                render={({ field }) => (
                  <DateInput
                    id="ev-session-end-date"
                    labelText="Ends on"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </FormSection>
          <FormSection title="Visibility">
            <Controller
              name="isPublic"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id="ev-session-public"
                  labelText="Show on the public page"
                  helperText={
                    isPublic
                      ? 'Public: visitors see this session in the programme.'
                      : 'Internal: only the team sees this session.'
                  }
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
          </FormSection>
        </FormSections>
      </Modal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}
