import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ListPeopleParams } from '../../api/generated/models';
import { getPerson, listPeople } from '../../api/generated/people/people';

export const peopleKeys = {
  all: ['people'] as const,
  lists: () => [...peopleKeys.all, 'list'] as const,
  list: (params: ListPeopleParams) => [...peopleKeys.lists(), params] as const,
  details: () => [...peopleKeys.all, 'detail'] as const,
  detail: (personId: string) => [...peopleKeys.details(), personId] as const,
};

export function peopleListOptions(params: ListPeopleParams) {
  return queryOptions({
    queryKey: peopleKeys.list(params),
    queryFn: ({ signal }) => listPeople(params, { signal }),
  });
}

export function personOptions(personId: string) {
  return queryOptions({
    queryKey: peopleKeys.detail(personId),
    queryFn: ({ signal }) => getPerson(personId, { signal }),
  });
}

export async function refreshPersonData(
  queryClient: QueryClient,
  personId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: peopleKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: peopleKeys.detail(personId) }),
  ]);
}
