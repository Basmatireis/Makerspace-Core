import { InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { updateEvent } from '../../../api/generated/events/events';
import type { Event } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { FormSection, FormSections } from '../components/FormSection';
import { PersonCombo, type PersonChoice } from '../components/PersonCombo';
import { eventMutationMessage } from '../errors';
import { invalidateEvents } from '../queries';
import { eventBody } from '../requestBodies';

type Values = { name: string; location: string; description: string; owner: PersonChoice | null };

/** Edit of the internal fields: name, location, description and owner. */
export function EditDetailsDialog({ event, onClose }: { event: Event; onClose: () => void }) {
  const client = useQueryClient();
  const form = useForm<Values>({
    defaultValues: {
      name: event.name,
      location: event.location ?? '',
      description: event.internalDescription ?? '',
      owner: event.ownerPersonId ? { id: event.ownerPersonId, label: event.ownerName ?? 'Current owner' } : null,
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const save = useMutation({
    mutationFn: (value: Values) =>
      updateEvent(
        event.id,
        eventBody(event, {
          name: value.name.trim(),
          location: value.location.trim() || null,
          internalDescription: value.description.trim() || null,
          ownerPersonId: value.owner?.id ?? null,
        }),
      ),
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
  return (
    <>
      <Modal
        open={!guard.dialogOpen}
        size="md"
        modalHeading="Edit details"
        modalLabel={event.name}
        primaryButtonText={save.isPending ? 'Saving…' : 'Save'}
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
              title="Details not saved"
              subtitle={eventMutationMessage(save.error)}
            />
          )}
          <FormSection title="Basics">
            <TextInput
              id="ev-edit-name"
              labelText="Internal name"
              invalid={Boolean(form.formState.errors.name)}
              invalidText="Enter a name."
              {...form.register('name', { validate: (value) => value.trim().length > 0 && value.length <= 200 })}
            />
            <TextInput
              id="ev-edit-location"
              labelText="Internal location"
              maxLength={500}
              {...form.register('location')}
            />
            <TextArea
              id="ev-edit-description"
              labelText="Internal description"
              rows={3}
              maxLength={10000}
              {...form.register('description')}
            />
          </FormSection>
          <FormSection title="Responsibility">
            <Controller
              name="owner"
              control={form.control}
              render={({ field }) => (
                <PersonCombo
                  id="ev-edit-owner"
                  titleText="Owner"
                  helperText="Needed to confirm the event and to put the public page live."
                  value={field.value}
                  onChange={field.onChange}
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
