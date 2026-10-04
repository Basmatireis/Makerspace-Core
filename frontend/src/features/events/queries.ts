import { queryOptions } from '@tanstack/react-query';
import {
  getEvent,
  listEventAssignments,
  listEventFiles,
  listEventSessions,
  listEventShiftRequirements,
  listEventShifts,
  listEventTaskLists,
  listEventTasks,
  listEvents,
} from '../../api/generated/events/events';
import { getPublicEvent, listOwnPublicEventAssignments } from '../../api/generated/public-events/public-events';

export const eventKeys = {
  all: ['events'] as const,
  detail: (id: string) => ['events', id] as const,
  sessions: (id: string) => ['events', id, 'sessions'] as const,
  taskLists: (id: string) => ['events', id, 'task-lists'] as const,
  tasks: (id: string) => ['events', id, 'tasks'] as const,
  shifts: (id: string) => ['events', id, 'shifts'] as const,
  requirements: (id: string, shiftId: string) => ['events', id, 'shifts', shiftId, 'requirements'] as const,
  assignments: (id: string) => ['events', id, 'assignments'] as const,
  files: (id: string) => ['events', id, 'files'] as const,
  public: (publicId: string) => ['public-event', publicId] as const,
  own: (publicId: string) => ['public-event', publicId, 'own-assignments'] as const,
};

export const eventsQueryOptions = () => queryOptions({ queryKey: eventKeys.all, queryFn: ({ signal }) => listEvents({ signal }) });
export const eventQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.detail(id), queryFn: ({ signal }) => getEvent(id, { signal }), enabled: Boolean(id) });
export const eventSessionsQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.sessions(id), queryFn: ({ signal }) => listEventSessions(id, { signal }), enabled: Boolean(id) });
export const eventTaskListsQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.taskLists(id), queryFn: ({ signal }) => listEventTaskLists(id, { signal }), enabled: Boolean(id) });
export const eventTasksQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.tasks(id), queryFn: ({ signal }) => listEventTasks(id, { signal }), enabled: Boolean(id) });
export const eventShiftsQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.shifts(id), queryFn: ({ signal }) => listEventShifts(id, { signal }), enabled: Boolean(id) });
export const eventRequirementsQueryOptions = (id: string, shiftId: string) => queryOptions({ queryKey: eventKeys.requirements(id, shiftId), queryFn: ({ signal }) => listEventShiftRequirements(id, shiftId, { signal }), enabled: Boolean(id && shiftId) });
export const eventAssignmentsQueryOptions = (id: string, enabled: boolean) => queryOptions({ queryKey: eventKeys.assignments(id), queryFn: ({ signal }) => listEventAssignments(id, { signal }), enabled: Boolean(id) && enabled });
export const eventFilesQueryOptions = (id: string) => queryOptions({ queryKey: eventKeys.files(id), queryFn: ({ signal }) => listEventFiles(id, { signal }), enabled: Boolean(id) });
export const publicEventQueryOptions = (publicId: string) => queryOptions({ queryKey: eventKeys.public(publicId), queryFn: ({ signal }) => getPublicEvent(publicId, { signal }), enabled: Boolean(publicId), retry: false });
export const ownEventAssignmentsQueryOptions = (publicId: string, enabled: boolean) => queryOptions({ queryKey: eventKeys.own(publicId), queryFn: ({ signal }) => listOwnPublicEventAssignments(publicId, { signal }), enabled: Boolean(publicId) && enabled, retry: false });
