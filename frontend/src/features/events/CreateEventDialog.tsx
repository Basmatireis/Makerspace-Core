import { InlineNotification, Modal, TextInput, TimePicker } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createEvent } from '../../api/generated/events/events';
import { DateInput } from '../../app/DateInput';
import { dateInAppTimeZone } from '../../app/dateTime';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../app/useLatestCallback';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { FieldRow, FormSection, FormSections } from './components/FormSection';
import { PersonCombo, type PersonChoice } from './components/PersonCombo';
import { eventMutationMessage } from './errors';
import { toInstant } from './format';
import { invalidateEvents } from './queries';

type Values = {
  name: string;
  location: string;
  date: string;
  start: string;
  end: string;
  owner: PersonChoice | null;
};

const inOneWeek = () => dateInAppTimeZone(new Date(Date.now() + 7 * 86_400_000));

/** The first day with start and end time creates the first session; the result is a draft in edit mode. */
export function CreateEventDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<Values>({
    defaultValues: { name: '', location: '', date: inOneWeek(), start: '10:00', end: '14:00', owner: null },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty, onDiscard: () => form.reset() });
  const create = useMutation({
    mutationFn: (value: Values) => {
      const location = value.location.trim() || null;
      return createEvent({
        name: value.name.trim(),
        location,
        ownerPersonId: value.owner?.id ?? null,
        firstSession: {
          name: null,
          location,
          startsAt: toInstant(value.date, value.start),
          endsAt: toInstant(value.date, value.end),
          isPublic: true,
        },
      });
    },
    onSuccess: async (event) => {
      await invalidateEvents(client);
      guard.bypassAfterSubmit(() => navigate(`/events/${event.id}?mode=edit`, { replace: true }));
    },
  });
  const requestClose = useLatestCallback(() => {
    if (!create.isPending) guard.requestDiscard(onClose);
    return false;
  });
  const submit = form.handleSubmit((value) => {
    if (!create.isPending) create.mutate(value);
  });

  return (
    <>
      <Modal
        open={open && !guard.dialogOpen}
        size="md"
        modalHeading="Create event"
        modalLabel="Events"
        primaryButtonText={create.isPending ? 'Creating…' : 'Create event'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={create.isPending}
        preventCloseOnClickOutside
        selectorPrimaryFocus="#ev-new-name"
        onRequestClose={requestClose}
        onRequestSubmit={() => void submit()}
      >
        <FormSections>
          {create.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Event not created"
              subtitle={eventMutationMessage(create.error)}
            />
          )}
          <FormSection title="Basics">
            <TextInput
              id="ev-new-name"
              labelText="Internal name"
              helperText="Only the team sees this name."
              invalid={Boolean(form.formState.errors.name)}
              invalidText="Enter a name."
              {...form.register('name', { validate: (value) => value.trim().length > 0 && value.length <= 200 })}
            />
            <TextInput id="ev-new-location" labelText="Location" maxLength={500} {...form.register('location')} />
          </FormSection>
          <FormSection
            title="First day"
            hint="The event starts as a draft with one session on this day. Add more sessions and helper shifts afterwards."
          >
            <FieldRow cols={3}>
              <Controller
                name="date"
                control={form.control}
                rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <DateInput
                    id="ev-new-date"
                    labelText="Day"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={Boolean(fieldState.error)}
                    invalidText="Choose the first day."
                  />
                )}
              />
              <TimePicker
                id="ev-new-start"
                labelText="Start (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                {...form.register('start', { required: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ })}
              />
              <TimePicker
                id="ev-new-end"
                labelText="End (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                invalid={Boolean(form.formState.errors.end)}
                invalidText="The end must be after the start."
                {...form.register('end', {
                  required: true,
                  pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
                  validate: (value, values) => value > values.start,
                })}
              />
            </FieldRow>
          </FormSection>
          <FormSection title="Responsibility">
            <Controller
              name="owner"
              control={form.control}
              render={({ field }) => (
                <PersonCombo
                  id="ev-new-owner"
                  titleText="Owner"
                  helperText="Needed to confirm the event and to put the public page live."
                  value={field.value}
                  onChange={(choice) => field.onChange(choice)}
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
