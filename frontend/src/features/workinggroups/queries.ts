import { queryOptions } from '@tanstack/react-query';
import type { CurrentUser, WorkingGroupSummary } from '../../api/generated/models';
import {
  getWorkingGroup,
  getWorkingGroupTicket,
  getWorkingGroupTodo,
  listWorkingGroupMachines,
  listWorkingGroupNotes,
  listWorkingGroupStatus,
  listWorkingGroupPeople,
  listWorkingGroups,
  listWorkingGroupTickets,
  listWorkingGroupTodos,
} from '../../api/generated/working-groups/working-groups';
import { hasPermission, PermissionId } from '../auth/permissions';

export const workingGroupKeys = {
  all: ['working-groups'] as const,
  list: () => [...workingGroupKeys.all, 'list'] as const,
  detail: (id: string) => [...workingGroupKeys.all, 'detail', id] as const,
  people: (search: string) => [...workingGroupKeys.all, 'people', search] as const,
  machines: () => [...workingGroupKeys.all, 'machines'] as const,
  tickets: () => [...workingGroupKeys.all, 'tickets'] as const,
  todos: () => [...workingGroupKeys.all, 'todos'] as const,
  notes: (groupId: string | undefined) => [...workingGroupKeys.all, 'notes', groupId ?? 'all'] as const,
  status: () => [...workingGroupKeys.all, 'status'] as const,
  ticket: (id: string) => [...workingGroupKeys.all, 'ticket', id] as const,
  todo: (id: string) => [...workingGroupKeys.all, 'todo', id] as const,
};

export const workingGroupTicketsOptions = queryOptions({
  queryKey: workingGroupKeys.tickets(),
  queryFn: ({ signal }) => listWorkingGroupTickets(undefined, { signal }),
});

/** The API returns only the to-dos of groups the caller is inside. */
export const workingGroupTodosOptions = queryOptions({
  queryKey: workingGroupKeys.todos(),
  queryFn: ({ signal }) => listWorkingGroupTodos(undefined, { signal }),
});

export const workingGroupTicketOptions = (id: string) =>
  queryOptions({
    queryKey: workingGroupKeys.ticket(id),
    queryFn: ({ signal }) => getWorkingGroupTicket(id, { signal }),
  });

export const workingGroupTodoOptions = (id: string) =>
  queryOptions({
    queryKey: workingGroupKeys.todo(id),
    queryFn: ({ signal }) => getWorkingGroupTodo(id, { signal }),
  });

/** The caller's own groups first, then the others, each by name. */
export function orderGroups(groups: readonly WorkingGroupSummary[]): WorkingGroupSummary[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const own = groups.filter((group) => group.isMember || group.isLead).sort(byName);
  const others = groups.filter((group) => !group.isMember && !group.isLead).sort(byName);
  return [...own, ...others];
}

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

/** Pinned notes the caller may see; with a group, only that group's (inside: group and public notes; outside: public). */
export const workingGroupNotesOptions = (groupId?: string) =>
  queryOptions({
    queryKey: workingGroupKeys.notes(groupId),
    queryFn: ({ signal }) => listWorkingGroupNotes(groupId ? { groupId } : undefined, { signal }),
  });

/** Every machine and place with its status and the days it was not ok in the last 90. */
export const workingGroupStatusOptions = queryOptions({
  queryKey: workingGroupKeys.status(),
  queryFn: ({ signal }) => listWorkingGroupStatus({ signal }),
});
