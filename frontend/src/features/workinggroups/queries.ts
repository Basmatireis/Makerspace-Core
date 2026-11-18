import { queryOptions } from '@tanstack/react-query';
import type { CurrentUser, WorkingGroupSummary } from '../../api/generated/models';
import {
  getWorkingGroup,
  listWorkingGroupMachines,
  listWorkingGroupPeople,
  listWorkingGroups,
} from '../../api/generated/working-groups/working-groups';
import { hasPermission, PermissionId } from '../auth/permissions';

export const workingGroupKeys = {
  all: ['working-groups'] as const,
  list: () => [...workingGroupKeys.all, 'list'] as const,
  detail: (id: string) => [...workingGroupKeys.all, 'detail', id] as const,
  people: (search: string) => [...workingGroupKeys.all, 'people', search] as const,
  machines: () => [...workingGroupKeys.all, 'machines'] as const,
};

export const workingGroupsOptions = queryOptions({
  queryKey: workingGroupKeys.list(),
  queryFn: ({ signal }) => listWorkingGroups({ signal }),
});

export const workingGroupOptions = (id: string) =>
  queryOptions({
    queryKey: workingGroupKeys.detail(id),
    queryFn: ({ signal }) => getWorkingGroup(id, { signal }),
  });

export const workingGroupPeopleOptions = (search: string) =>
  queryOptions({
    queryKey: workingGroupKeys.people(search),
    queryFn: ({ signal }) => listWorkingGroupPeople({ search: search || undefined }, { signal }),
  });

export const workingGroupMachinesOptions = queryOptions({
  queryKey: workingGroupKeys.machines(),
  queryFn: ({ signal }) => listWorkingGroupMachines({ signal }),
});

export const canManageWorkingGroups = (currentUser: CurrentUser) =>
  hasPermission(currentUser, PermissionId.working_groupsmanage);

/** The groups the caller may edit: all with `working_groups.manage`, otherwise the ones they lead. The API enforces it again. */
export function editableWorkingGroups(currentUser: CurrentUser, groups: readonly WorkingGroupSummary[]) {
  if (!hasPermission(currentUser, PermissionId.working_groupsread)) return [];
  return canManageWorkingGroups(currentUser) ? [...groups] : groups.filter((group) => group.isLead);
}
