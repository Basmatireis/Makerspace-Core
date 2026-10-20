import { Button, Form, Stack, StructuredListBody, StructuredListWrapper } from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import type { Person } from '../../../api/generated/models';
import { PersonFields } from '../PersonForm';
import { DetailRow, DetailSection } from '../PersonDetailComponents';
import type { PersonDetailActions } from './usePersonDetailActions';

export function PersonalInformationSection({
  person,
  ctrl,
  canEditPerson,
  canReadMatriculation,
  canEditMatriculation,
}: {
  person: Person;
  ctrl: PersonDetailActions;
  canEditPerson: boolean;
  canReadMatriculation: boolean;
  canEditMatriculation: boolean;
}) {
  const { editingPerson, setEditingPerson, personForm, personMutation, submitPerson } = ctrl;
  return (
    <DetailSection
      title="Personal information"
      action={
        canEditPerson && !editingPerson ? (
          <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditingPerson(true)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      {editingPerson ? (
        <Form onSubmit={submitPerson}>
          <Stack gap={6}>
            <PersonFields
              form={personForm}
              showMatriculation={canReadMatriculation}
              editMatriculation={canEditMatriculation}
            />
            <div className="form-actions">
              <Button
                kind="secondary"
                type="button"
                onClick={() => {
                  personForm.reset();
                  setEditingPerson(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!personForm.formState.isDirty || personMutation.isPending}>
                {personMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </Stack>
        </Form>
      ) : (
        <StructuredListWrapper isCondensed>
          <StructuredListBody>
            <DetailRow label="First name" value={person.firstName} />
            <DetailRow label="Last name" value={person.lastName} />
            <DetailRow label="Contact email" value={person.email ?? 'Not provided'} />
            <DetailRow label="Phone" value={person.phone ?? 'Not provided'} />
            {canReadMatriculation && (
              <DetailRow label="Matriculation number" value={person.matriculationNumber ?? 'Not provided'} />
            )}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </DetailSection>
  );
}
