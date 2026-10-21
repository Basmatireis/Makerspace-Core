import { TableBatchAction, TableBatchActions } from '@carbon/react';
import type { ComponentProps } from 'react';
import { TrashCan, UserFollow, UserRole } from '@carbon/icons-react';
import type { Person } from '../../../api/generated/models';
import { peopleEligibleForDeletion, peopleWithAccounts } from './peopleList';
import type { useBatchPeopleActions } from './useBatchPeopleActions';

/** The bulk actions the person may use on the selected rows of the People table. */
export function PeopleBatchActions({
  batchActionProps,
  selectedMembers,
  can,
  canDeleteAccounts,
  hasAssignableRoles,
  batch,
}: {
  batchActionProps: ComponentProps<typeof TableBatchActions>;
  selectedMembers: Person[];
  can: { createAccounts: boolean; assignRoles: boolean; deleteAccounts: boolean; deletePeople: boolean };
  canDeleteAccounts: boolean;
  hasAssignableRoles: boolean;
  batch: ReturnType<typeof useBatchPeopleActions>;
}) {
  const { setBatchMembers, setBatchAction, openDeleteAccounts, openDeletePeople } = batch;
  const selectedForAccountCreation = selectedMembers.filter((member) => member.account === null);
  const selectedForRoleAssignment = selectedMembers;
  const selectedForAccountDeletion = peopleWithAccounts(selectedMembers);
  const selectedForPersonDeletion = peopleEligibleForDeletion(selectedMembers, canDeleteAccounts);

  return (
    <TableBatchActions {...batchActionProps}>
      {can.createAccounts && (
        <TableBatchAction
          renderIcon={UserFollow}
          iconDescription="Create login accounts"
          disabled={selectedForAccountCreation.length === 0}
          onClick={() => {
            setBatchMembers(selectedMembers);
            setBatchAction('create-accounts');
          }}
        >
          Create accounts
        </TableBatchAction>
      )}
      {can.assignRoles && (
        <TableBatchAction
          renderIcon={UserRole}
          iconDescription="Assign role"
          disabled={selectedForRoleAssignment.length === 0 || !hasAssignableRoles}
          onClick={() => {
            setBatchMembers(selectedMembers);
            setBatchAction('assign-role');
          }}
        >
          Assign role
        </TableBatchAction>
      )}
      {can.deleteAccounts && (
        <TableBatchAction
          renderIcon={TrashCan}
          iconDescription="Delete login accounts"
          disabled={selectedForAccountDeletion.length === 0}
          onClick={(event) => openDeleteAccounts(event.currentTarget, selectedMembers)}
        >
          Delete accounts
        </TableBatchAction>
      )}
      {can.deletePeople && (
        <TableBatchAction
          renderIcon={TrashCan}
          iconDescription="Delete people"
          disabled={selectedForPersonDeletion.length === 0}
          onClick={(event) => openDeletePeople(event.currentTarget, selectedMembers)}
        >
          Delete people
        </TableBatchAction>
      )}
    </TableBatchActions>
  );
}
