import { InlineNotification, Modal, RadioButton, RadioButtonGroup } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { linkEventAssignmentPerson } from '../../../api/generated/events/events';
import type { EventPersonOption } from '../../../api/generated/models';
import { FormSection, FormSections, KeyValueList } from '../components/FormSection';
import { PersonCombo, type PersonChoice } from '../components/PersonCombo';
import { eventMutationMessage } from '../errors';
import { invalidateEvents } from '../queries';

const choice = (person: EventPersonOption): PersonChoice => ({
  id: person.id,
  label: `${person.firstName} ${person.lastName}`,
});

/** Links a public signup to a person record; the server checks eligibility and overlaps like for a new assignment. */
export function LinkPersonDialog({
  eventId,
  assignment,
  onClose,
}: {
  eventId: string;
  assignment: { id: string; version: number; name: string; contact: string; suggestions: EventPersonOption[] };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const suggestions = assignment.suggestions.map(choice);
  const [person, setPerson] = useState<PersonChoice | null>(suggestions[0] ?? null);
  const link = useMutation({
    mutationFn: (personId: string) =>
      linkEventAssignmentPerson(eventId, assignment.id, { personId, expectedVersion: assignment.version }),
    onSuccess: async () => {
      await invalidateEvents(client);
      onClose();
    },
  });
  return (
    <Modal
      open
      size="md"
      modalHeading="Link person"
      modalLabel={assignment.name}
      primaryButtonText={link.isPending ? 'Linking…' : 'Link person'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!person || link.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!link.isPending) onClose();
      }}
      onRequestSubmit={() => person && link.mutate(person.id)}
    >
      <FormSections>
        {link.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Person not linked"
            subtitle={eventMutationMessage(link.error)}
          />
        )}
        <FormSection title="Signup">
          <KeyValueList
            label="Signup"
            rows={[
              ['Name', assignment.name],
              ['Contact', assignment.contact || 'No contact details'],
            ]}
          />
        </FormSection>
        <FormSection title="Person" hint="Linking connects the signup to a person record.">
          {suggestions.length > 0 ? (
            <RadioButtonGroup
              legendText="Suggested matches (same email address or phone number)"
              name="ev-link-suggestion"
              orientation="vertical"
              valueSelected={person?.id ?? ''}
              onChange={(value) => setPerson(suggestions.find((item) => item.id === value) ?? null)}
            >
              {suggestions.map((item) => (
                <RadioButton
                  key={item.id}
                  id={`ev-link-suggestion-${item.id}`}
                  value={item.id}
                  labelText={item.label}
                />
              ))}
            </RadioButtonGroup>
          ) : (
            <p className="ev-secondary">No person with the same email address or phone number was found.</p>
          )}
          <PersonCombo
            id="ev-link-person"
            titleText={suggestions.length > 0 ? 'Or search another person' : 'Search a person'}
            suggestions={suggestions}
            value={person && !suggestions.some((item) => item.id === person.id) ? person : null}
            onChange={setPerson}
          />
        </FormSection>
      </FormSections>
    </Modal>
  );
}
