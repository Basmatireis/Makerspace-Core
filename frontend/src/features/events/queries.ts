import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  getEvent,
  getEventHelpers,
  getEventParticipation,
  listEventEligibilityRoles,
  listEventFiles,
  listEventPeople,
  listEventSessions,
  listEventShifts,
  listEventTaskLists,
  listEventTasks,
  listEvents,
} from '../../api/generated/events/events';
import type { ListEventsParams, ListEventTasksParams } from '../../api/generated/models';
import { getPublicEvent, listOwnPublicEventAssignments } from '../../api/generated/public-events/public-events';
import { dashboardKeys } from '../dashboard/queries';

export const eventKeys = {
  all: ['events'] as const,
  list: (params: ListEventsParams) => ['events', 'list', params] as const,
  detail: (id: string) => ['events', id] as const,
  participation: (id: string) => ['events', id, 'participation'] as const,
  sessions: (id: string) => ['events', id, 'sessions'] as const,
  taskLists: (id: string) => ['events', id, 'task-lists'] as const,
  tasks: (id: string, params: ListEventTasksParams = {}) => ['events', id, 'tasks', params] as const,
  shifts: (id: string) => ['events', id, 'shifts'] as const,
  helpers: (id: string) => ['events', id, 'helpers'] as const,
  files: (id: string) => ['events', id, 'files'] as const,
  roles: ['events', 'roles'] as const,
  people: (search: string) => ['events', 'people', search] as const,
  public: (publicId: string) => ['public-event', publicId] as const,
  own: (publicId: string) => ['public-event', publicId, 'own-assignments'] as const,
};

/** Every event screen reads the same few resources, so a change refreshes all of them plus the dashboard's shifts. */
export async function invalidateEvents(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: eventKeys.all }),
    client.invalidateQueries({ queryKey: dashboardKeys.all }),
  ]);
}

export const eventListQueryOptions = (params: ListEventsParams) =>
  queryOptions({ queryKey: eventKeys.list(params), queryFn: ({ signal }) => listEvents(params, { signal }) });
export const eventQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.detail(id),
    queryFn: ({ signal }) => getEvent(id, { signal }),
    enabled: Boolean(id),
  });
export const eventParticipationQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.participation(id),
    queryFn: ({ signal }) => getEventParticipation(id, { signal }),
    enabled: Boolean(id),
  });
export const eventSessionsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.sessions(id),
    queryFn: ({ signal }) => listEventSessions(id, { signal }),
    enabled: Boolean(id),
  });
export const eventShiftsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.shifts(id),
    queryFn: ({ signal }) => listEventShifts(id, { signal }),
    enabled: Boolean(id),
  });
export const eventHelpersQueryOptions = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: eventKeys.helpers(id),
    queryFn: ({ signal }) => getEventHelpers(id, { signal }),
    enabled: Boolean(id) && enabled,
  });
export const eventTaskListsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.taskLists(id),
    queryFn: ({ signal }) => listEventTaskLists(id, { signal }),
    enabled: Boolean(id),
  });
export const eventTasksQueryOptions = (id: string, params: ListEventTasksParams = {}) =>
  queryOptions({
    queryKey: eventKeys.tasks(id, params),
    queryFn: ({ signal }) => listEventTasks(id, params, { signal }),
    enabled: Boolean(id),
  });
export const eventFilesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: eventKeys.files(id),
    queryFn: ({ signal }) => listEventFiles(id, { signal }),
    enabled: Boolean(id),
  });
export const eventRolesQueryOptions = () =>
  queryOptions({ queryKey: eventKeys.roles, queryFn: ({ signal }) => listEventEligibilityRoles({ signal }) });
export const eventPeopleQueryOptions = (search: string) =>
  queryOptions({
    queryKey: eventKeys.people(search),
    queryFn: ({ signal }) => listEventPeople({ search: search || undefined }, { signal }),
  });
export const publicEventQueryOptions = (publicId: string) =>
  queryOptions({
    queryKey: eventKeys.public(publicId),
    queryFn: ({ signal }) => getPublicEvent(publicId, { signal }),
    enabled: Boolean(publicId),
    retry: false,
  });
export const ownEventAssignmentsQueryOptions = (publicId: string, enabled: boolean) =>
  queryOptions({
    queryKey: eventKeys.own(publicId),
    queryFn: ({ signal }) => listOwnPublicEventAssignments(publicId, { signal }),
    enabled: Boolean(publicId) && enabled,
    retry: false,
  });
