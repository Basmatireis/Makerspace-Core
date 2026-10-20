import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createPersonAccount, deleteAccount } from '../../../api/generated/accounts/accounts';
import type { Person, Role } from '../../../api/generated/models';
import { assignPersonRole, deletePerson } from '../../../api/generated/people/people';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { deletionFailureReasons } from '../deletionErrors';
import { peopleKeys } from '../queries';
import {
  fullName,
  peopleEligibleForDeletion,
  peopleWithAccounts,
  type BatchAction,
  type BatchResult,
} from './peopleList';

/** Selection, confirmation state and the four bulk operations of the People table. */
export function useBatchPeopleActions({
  canDeleteAccounts,
  onChanged,
}: {
  canDeleteAccounts: boolean;
  onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [batchAction, setBatchAction] = useState<BatchAction>(null);
  const [batchMembers, setBatchMembers] = useState<Person[]>([]);
  const [batchRole, setBatchRole] = useState<Role | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const batchCreateAccounts = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = members.filter((member) => member.account === null);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          createPersonAccount(person.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        created: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ created, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0 ? 'Accounts created' : 'Some accounts were not created',
        subtitle: `${created} created${skipped ? `; ${skipped} skipped because an account already exists` : ''}${failed ? `; ${failed} could not be created` : ''}.`,
      });
      await onChanged();
    },
  });
  const batchAssignRole = useMutation({
    mutationFn: async ({ members, role }: { members: Person[]; role: Role }) => {
      const eligible = members.filter((person) => !person.roles.some((assigned) => assigned.id === role.id));
      const results = await Promise.allSettled(
        eligible.map((person) =>
          assignPersonRole(person.id, role.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        assigned: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ assigned, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      setBatchRole(null);
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0 ? 'Roles assigned' : 'Some roles were not assigned',
        subtitle: `${assigned} assigned${skipped ? `; ${skipped} skipped because the role is already assigned` : ''}${failed ? `; ${failed} could not be assigned` : ''}.`,
      });
      await onChanged();
    },
  });
  const batchDeleteAccounts = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = peopleWithAccounts(members);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          deleteAccount(person.account!.id, {
            expectedVersion: person.account!.version,
          }),
        ),
      );
      return {
        deletedAccountIds: results.flatMap((result, index) =>
          result.status === 'fulfilled' ? [eligible[index].account!.id] : [],
        ),
        deleted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        failures: results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [{ name: fullName(eligible[index]), reasons: deletionFailureReasons(result.reason, 'account') }]
            : [],
        ),
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ deletedAccountIds, deleted, failed, failures, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      for (const accountId of deletedAccountIds) {
        queryClient.removeQueries({ queryKey: ['accounts', 'detail', accountId] });
      }
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title:
          failed === 0
            ? 'Accounts deleted'
            : deleted === 0
              ? 'Accounts were not deleted'
              : 'Some accounts were not deleted',
        subtitle: `${deleted} deleted${skipped ? `; ${skipped} skipped because no visible account exists` : ''}${failed ? `; ${failed} could not be deleted` : ''}.`,
        failures,
      });
      await onChanged();
    },
  });
  const batchDeletePeople = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = peopleEligibleForDeletion(members, canDeleteAccounts);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          deletePerson(person.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        deletedPersonIds: results.flatMap((result, index) =>
          result.status === 'fulfilled' ? [eligible[index].id] : [],
        ),
        deleted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        failures: results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [{ name: fullName(eligible[index]), reasons: deletionFailureReasons(result.reason, 'person') }]
            : [],
        ),
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ deletedPersonIds, deleted, failed, failures, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      for (const personId of deletedPersonIds) {
        queryClient.removeQueries({ queryKey: peopleKeys.detail(personId) });
      }
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title:
          failed === 0 ? 'People deleted' : deleted === 0 ? 'People were not deleted' : 'Some people were not deleted',
        subtitle: `${deleted} deleted${skipped ? `; ${skipped} skipped because deleting their account is not permitted` : ''}${failed ? `; ${failed} could not be deleted` : ''}.`,
        failures,
      });
      await onChanged();
    },
  });

  const deleteAccountsLauncher = useRef<HTMLButtonElement>(null);
  const deletePeopleLauncher = useRef<HTMLButtonElement>(null);
  const closeDeleteAccounts = useLatestCallback(() => {
    if (!batchDeleteAccounts.isPending) setBatchAction(null);
    return false;
  });
  const closeDeletePeople = useLatestCallback(() => {
    if (!batchDeletePeople.isPending) setBatchAction(null);
    return false;
  });

  return {
    batchAction,
    setBatchAction,
    batchMembers,
    setBatchMembers,
    batchRole,
    setBatchRole,
    batchResult,
    setBatchResult,
    batchCreateAccounts,
    batchAssignRole,
    batchDeleteAccounts,
    batchDeletePeople,
    deleteAccountsLauncher,
    deletePeopleLauncher,
    closeDeleteAccounts,
    closeDeletePeople,
  };
}
