import { ActionableNotification, Button, Form, Stack, StructuredListBody, StructuredListWrapper } from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import type { Person } from '../../../api/generated/models';
import { formatDate } from '../../../app/dateTime';
import { PersonFields } from '../PersonForm';
import { DetailRow, DetailSection } from '../PersonDetailComponents';
import type { PersonDetailActions } from './usePersonDetailActions';

export function PersonalInformationSection({
  person,
  ctrl,
  canEditPerson,
  canReadMatriculation,
  canEditMatriculation,
  canEditMemberSince,
  hasAccount,
  emailLocked,
  missingLoginEmail,
  canSetLoginEmail,
}: {
  person: Person;
  ctrl: PersonDetailActions;
  canEditPerson: boolean;
  canReadMatriculation: boolean;
  canEditMatriculation: boolean;
  canEditMemberSince: boolean;
  /** The person has an account, so the email is the login email. */
  hasAccount: boolean;
  /** An account holder's email cannot be changed by the current user. */
  emailLocked: boolean;
  /** The account exists without a login email. */
  missingLoginEmail: boolean;
  canSetLoginEmail: boolean;
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
      {missingLoginEmail && (
        <ActionableNotification
          inline
          kind="warning"
          lowContrast
          hideCloseButton
          title="This account has no login email"
          subtitle={
            canSetLoginEmail
              ? 'Set one so the person has a single email for sign-in and contact.'
              : 'An administrator with permission to change login emails needs to set one.'
          }
          actionButtonLabel={canSetLoginEmail ? 'Set login email' : undefined}
          onActionButtonClick={canSetLoginEmail ? () => ctrl.setLoginEmailModalOpen(true) : undefined}
        />
      )}
      {editingPerson ? (
        <Form onSubmit={submitPerson}>
          <Stack gap={6}>
            <PersonFields
              form={personForm}
              showMatriculation={canReadMatriculation}
              editMatriculation={canEditMatriculation}
              hasAccount={hasAccount}
              emailLocked={emailLocked}
              showMemberSince={canEditMemberSince}
              editMemberSince={canEditMemberSince}
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
            <DetailRow label="Email" value={person.email ?? 'Not provided'} />
            <DetailRow label="Phone" value={person.phone ?? 'Not provided'} />
            <DetailRow label="Member since" value={formatDate(person.memberSince)} />
            {canReadMatriculation && (
              <DetailRow label="Matriculation number" value={person.matriculationNumber ?? 'Not provided'} />
            )}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </DetailSection>
  );
}
