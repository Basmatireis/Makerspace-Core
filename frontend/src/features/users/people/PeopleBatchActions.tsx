import { TableBatchAction, TableBatchActions } from '@carbon/react';
import type { ComponentProps } from 'react';
import { Merge, TrashCan, UserFollow, UserRole } from '@carbon/icons-react';
import { useNavigate } from 'react-router-dom';
import type { Person } from '../../../api/generated/models';
import { peopleEligibleForDeletion, peopleWithAccounts } from './peopleList';
import { MAX_MERGE_PEOPLE } from '../merge/mergeFields';
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
  can: {
    createAccounts: boolean;
    assignRoles: boolean;
    deleteAccounts: boolean;
    deletePeople: boolean;
    merge: boolean;
  };
  canDeleteAccounts: boolean;
  hasAssignableRoles: boolean;
  batch: ReturnType<typeof useBatchPeopleActions>;
}) {
  const navigate = useNavigate();
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
      {can.merge && (
        <TableBatchAction
          renderIcon={Merge}
          iconDescription="Merge people"
          disabled={selectedMembers.length < 2 || selectedMembers.length > MAX_MERGE_PEOPLE}
          onClick={() => {
            const query = new URLSearchParams(selectedMembers.map((member) => ['person', member.id]));
            navigate(`/people/merge?${query}`);
          }}
        >
          Merge people
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
