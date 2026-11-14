import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ListPeopleParams } from '../../api/generated/models';
import { getPerson, listPeople, listPeopleRoleOptions } from '../../api/generated/people/people';

export const peopleKeys = {
  all: ['people'] as const,
  lists: () => [...peopleKeys.all, 'list'] as const,
  list: (params: ListPeopleParams) => [...peopleKeys.lists(), params] as const,
  details: () => [...peopleKeys.all, 'detail'] as const,
  detail: (personId: string) => [...peopleKeys.details(), personId] as const,
  roleOptions: () => [...peopleKeys.all, 'role-options'] as const,
};

export function peopleListOptions(params: ListPeopleParams) {
  return queryOptions({
    queryKey: peopleKeys.list(params),
    queryFn: ({ signal }) => listPeople(params, { signal }),
  });
}

// Role names for the People list filter, readable with people.read.all and without roles.read.
export const peopleRoleOptions = queryOptions({
  queryKey: peopleKeys.roleOptions(),
  queryFn: ({ signal }) => listPeopleRoleOptions({ signal }),
  select: (list) => list.items,
});

export function personOptions(personId: string) {
  return queryOptions({
    queryKey: peopleKeys.detail(personId),
    queryFn: ({ signal }) => getPerson(personId, { signal }),
  });
}

export async function refreshPersonData(queryClient: QueryClient, personId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: peopleKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: peopleKeys.detail(personId) }),
  ]);
}
