import type {
  Event,
  EventPositionInput,
  EventRequirement,
  EventSession,
  EventShift,
  EventTask,
  EventTaskList,
  UpdateEventRequest,
  UpdateEventSessionRequest,
  UpdateEventShiftRequest,
  UpdateEventTaskListRequest,
  UpdateEventTaskRequest,
} from '../../api/generated/models';

// The API replaces whole resources, so a single change (a toggle, a status) re-sends the current values with the
// version they were read at. Keeping that mapping in one place means a screen only names what it changes.

export const eventBody = (event: Event, patch: Partial<UpdateEventRequest> = {}): UpdateEventRequest => ({
  name: event.name,
  internalDescription: event.internalDescription ?? null,
  location: event.location ?? null,
  ownerPersonId: event.ownerPersonId ?? null,
  publicTitle: event.publicTitle ?? null,
  publicDescription: event.publicDescription ?? null,
  publicLocation: event.publicLocation ?? null,
  publicSignupEnabled: event.publicSignupEnabled,
  expectedVersion: event.version,
  ...patch,
});

export const positionInput = (requirement: EventRequirement): EventPositionInput => ({
  id: requirement.id,
  name: requirement.name,
  description: requirement.description ?? null,
  requiredCount: requirement.requiredCount,
  eligibilityMode: requirement.eligibilityMode,
  eligibleRoleIds: requirement.eligibleRoleIds,
});

export const shiftBody = (
  shift: EventShift,
  patch: Partial<UpdateEventShiftRequest> = {},
): UpdateEventShiftRequest => ({
  sessionId: shift.sessionId ?? null,
  name: shift.name,
  description: shift.description ?? null,
  startsAt: shift.startsAt,
  endsAt: shift.endsAt,
  signupOpensAt: shift.signupOpensAt ?? null,
  signupClosesAt: shift.signupClosesAt ?? null,
  isPublic: shift.isPublic,
  status: shift.status,
  requirements: shift.requirements.map(positionInput),
  expectedVersion: shift.version,
  ...patch,
});

export const sessionBody = (
  session: EventSession,
  patch: Partial<UpdateEventSessionRequest> = {},
): UpdateEventSessionRequest => ({
  name: session.name ?? null,
  location: session.location ?? null,
  description: session.description ?? null,
  startsAt: session.startsAt,
  endsAt: session.endsAt,
  isPublic: session.isPublic,
  status: session.status,
  expectedVersion: session.version,
  ...patch,
});

export const taskBody = (task: EventTask, patch: Partial<UpdateEventTaskRequest> = {}): UpdateEventTaskRequest => ({
  taskListId: task.taskListId ?? null,
  title: task.title,
  description: task.description ?? null,
  status: task.status,
  important: task.important,
  assigneePersonId: task.assigneePersonId ?? null,
  dueAt: task.dueAt ?? null,
  sortOrder: task.sortOrder,
  expectedVersion: task.version,
  ...patch,
});

export const taskListBody = (
  list: EventTaskList,
  patch: Partial<UpdateEventTaskListRequest> = {},
): UpdateEventTaskListRequest => ({
  name: list.name,
  description: list.description ?? null,
  sortOrder: list.sortOrder,
  expectedVersion: list.version,
  ...patch,
});
