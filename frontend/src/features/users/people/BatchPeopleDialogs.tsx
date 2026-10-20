import {
  Button,
  ComposedModal,
  Dropdown,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
} from '@carbon/react';
import type { Role } from '../../../api/generated/models';
import { peopleEligibleForDeletion, peopleWithAccounts } from './peopleList';
import type { useBatchPeopleActions } from './useBatchPeopleActions';

/** Confirmation dialogs of the People table's bulk actions. */
export function BatchPeopleDialogs({ batch, assignableRoles, currentPersonId, canDeleteAccounts }: {
  batch: ReturnType<typeof useBatchPeopleActions>;
  assignableRoles: Role[];
  currentPersonId: string;
  canDeleteAccounts: boolean;
}) {
  const {
    batchAction, setBatchAction, batchMembers, batchRole, setBatchRole,
    batchCreateAccounts, batchAssignRole, batchDeleteAccounts, batchDeletePeople,
    deleteAccountsLauncher, deletePeopleLauncher, closeDeleteAccounts, closeDeletePeople,
  } = batch;
  const membersEligibleForAccountCreation = batchMembers.filter((member) => member.account === null);
  const membersEligibleForAccountDeletion = peopleWithAccounts(batchMembers);
  const membersEligibleForPersonDeletion = peopleEligibleForDeletion(batchMembers, canDeleteAccounts);
  const membersEligibleForRoleAssignment = batchRole
    ? batchMembers.filter(
        (member) => !member.roles.some((assigned) => assigned.id === batchRole.id),
      )
    : batchMembers;

  return (
    <>
      <ComposedModal
        open={batchAction === 'create-accounts'}
        onClose={() => setBatchAction(null)}
      >
        <ModalHeader title="Create login accounts" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This creates active accounts for {membersEligibleForAccountCreation.length}{' '}
              selected {membersEligibleForAccountCreation.length === 1 ? 'person' : 'people'}.
              Authentication methods can be configured separately afterwards; without one, the person cannot sign in.
            </p>
            {batchMembers.length !== membersEligibleForAccountCreation.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="People who already have an account are not changed."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => setBatchAction(null)}>
            Cancel
          </Button>
          <Button
            disabled={
              membersEligibleForAccountCreation.length === 0 || batchCreateAccounts.isPending
            }
            onClick={() => batchCreateAccounts.mutate(batchMembers)}
          >
            {batchCreateAccounts.isPending ? 'Creating…' : 'Create accounts'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        open={batchAction === 'assign-role'}
        onClose={() => setBatchAction(null)}
      >
        <ModalHeader title="Assign role to people" />
        <ModalBody>
          <Form>
            <Stack gap={5}>
              <Dropdown
                id="batch-assign-role"
                titleText="Role"
                label="Choose a role"
                items={assignableRoles}
                itemToString={(role) => role?.name ?? ''}
                selectedItem={batchRole}
                onChange={({ selectedItem }) => setBatchRole(selectedItem ?? null)}
              />
              <p>
                The selected role will be assigned to {membersEligibleForRoleAssignment.length}{' '}
                {membersEligibleForRoleAssignment.length === 1 ? 'person' : 'people'}.
              </p>
              {batchMembers.length !== membersEligibleForRoleAssignment.length && (
                <InlineNotification
                  kind="info"
                  lowContrast
                  hideCloseButton
                  title="Some people will be skipped"
                  subtitle="People who already have the role are not changed."
                />
              )}
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => setBatchAction(null)}>
            Cancel
          </Button>
          <Button
            disabled={
              !batchRole ||
              membersEligibleForRoleAssignment.length === 0 ||
              batchAssignRole.isPending
            }
            onClick={() =>
              batchRole && batchAssignRole.mutate({ members: batchMembers, role: batchRole })
            }
          >
            {batchAssignRole.isPending ? 'Assigning…' : 'Assign role'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Delete accounts permanently?"
        danger
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        open={batchAction === 'delete-accounts'}
        launcherButtonRef={deleteAccountsLauncher}
        onClose={closeDeleteAccounts}
      >
        <ModalHeader title="Delete accounts permanently?" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This permanently deletes {membersEligibleForAccountDeletion.length}{' '}
              selected {membersEligibleForAccountDeletion.length === 1 ? 'account' : 'accounts'},
              including their authentication methods and sessions. The people records and their
              assigned roles remain. This cannot be undone.
            </p>
            {batchMembers.some((member) => member.id === currentPersonId && member.account) && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Your own account is selected"
                subtitle="Deleting it will end your access to the application."
              />
            )}
            {batchMembers.length !== membersEligibleForAccountDeletion.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="A visible account is required."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            disabled={batchDeleteAccounts.isPending}
            onClick={() => setBatchAction(null)}
          >
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={
              membersEligibleForAccountDeletion.length === 0 ||
              batchDeleteAccounts.isPending
            }
            onClick={() => batchDeleteAccounts.mutate(batchMembers)}
          >
            {batchDeleteAccounts.isPending ? 'Deleting…' : 'Delete accounts'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Delete people permanently?"
        danger
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        open={batchAction === 'delete-people'}
        launcherButtonRef={deletePeopleLauncher}
        onClose={closeDeletePeople}
      >
        <ModalHeader title="Delete people permanently?" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This permanently deletes {membersEligibleForPersonDeletion.length}{' '}
              selected {membersEligibleForPersonDeletion.length === 1 ? 'person' : 'people'},
              including their accounts, authentication methods, and role assignments. Operational
              links are detached and assignment identity data is scrubbed. Existing order customer
              and external-invoice recipient snapshots are retained as financial records. This
              cannot be undone.
            </p>
            {membersEligibleForPersonDeletion.some(
              (member) => member.id === currentPersonId,
            ) && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Your own person record is selected"
                subtitle="Deleting it will end your access to the application."
              />
            )}
            {batchMembers.length !== membersEligibleForPersonDeletion.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="Deleting a person with an account requires permission to delete accounts."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            disabled={batchDeletePeople.isPending}
            onClick={() => setBatchAction(null)}
          >
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={
              membersEligibleForPersonDeletion.length === 0 ||
              batchDeletePeople.isPending
            }
            onClick={() => batchDeletePeople.mutate(batchMembers)}
          >
            {batchDeletePeople.isPending ? 'Deleting…' : 'Delete people'}
          </Button>
        </ModalFooter>
      </ComposedModal>
    </>
  );
}
