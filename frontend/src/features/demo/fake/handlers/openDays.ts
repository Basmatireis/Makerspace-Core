import type { OpenDay, OpenDayAssignment } from '../../../../api/generated/models';
import { dayRequirements } from '../../../opendays/timeslots';
import { openDayView, refreshPeriod } from '../openDayModel';
import { created, fail, noContent, notFound, ok, type DemoRouter } from '../router';
import { nextId, personName, type DemoStore } from '../store';

function findDay(store: DemoStore, id: string): OpenDay | undefined {
  return store.openDays.find((day) => day.id === id);
}

function assign(store: DemoStore, day: OpenDay, requirementId: unknown, personId: string) {
  const requirement = dayRequirements(day).find((item) => item.id === requirementId);
  if (!requirement) return fail(422, 'invalid_requirement', 'Choose a staffing requirement of this Open Day.');
  if (day.status !== 'scheduled') return fail(409, 'open_day_cancelled', 'This Open Day is cancelled.');
  const person = store.people.find((item) => item.id === personId);
  if (!person) return notFound('Person');
  if (
    dayRequirements(day).some(
      (item) => item.timeslotId === requirement.timeslotId && item.assignments?.some((a) => a.personId === personId),
    )
  ) {
    return fail(409, 'already_in_timeslot', 'This person already has a place in this timeslot.');
  }
  if (requirement.assignedCount >= requirement.requiredCount) {
    return fail(409, 'requirement_full', 'All places for this requirement are taken.');
  }
  const assignment: OpenDayAssignment = {
    id: nextId(store),
    openDayId: day.id,
    timeslotId: requirement.timeslotId,
    requirementId: requirement.id,
    personId,
    displayName: personName(person),
    isCurrentUser: personId === store.user.person.id,
    createdAt: store.now.toISOString(),
  };
  requirement.assignments = [...(requirement.assignments ?? []), assignment];
  requirement.assignedCount = requirement.assignments.length;
  refreshPeriod(store);
  return created(assignment);
}

function unassign(store: DemoStore, day: OpenDay, match: (assignment: OpenDayAssignment) => boolean) {
  for (const requirement of dayRequirements(day)) {
    const before = requirement.assignments ?? [];
    const after = before.filter((assignment) => !match(assignment));
    if (after.length !== before.length) {
      requirement.assignments = after;
      requirement.assignedCount = after.length;
      refreshPeriod(store);
      return noContent();
    }
  }
  return notFound('Assignment');
}

export function registerOpenDays(router: DemoRouter<DemoStore>): void {
  router
    .get('/open-day-periods', ({ store }) => ok({ items: [store.period] }))
    .get('/open-day-periods/{periodId}', ({ store, params }) =>
      params.periodId === store.period.id ? ok(store.period) : notFound('Period'),
    )
    .get('/open-day-periods/{periodId}/open-days', ({ store, params }) =>
      params.periodId === store.period.id
        ? ok({
            period: store.period,
            items: store.openDays.map((day) => openDayView(store, day)),
            timeZone: 'Europe/Vienna',
          })
        : notFound('Period'),
    )
    .get('/open-day-periods/{periodId}/calendar-context', () =>
      ok({
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: null,
        languageCode: 'en',
        entries: [],
        academicBreaks: [],
      }),
    )
    .get('/open-day-academic-breaks', () => ok({ items: [] }))
    .get('/open-day-eligibility-roles', ({ store }) =>
      ok({ items: store.roles.filter((role) => !role.systemKey).map(({ id, name }) => ({ id, name })) }),
    )
    .get('/staffing-rules', ({ store }) =>
      ok({
        supervisorMinimum: 2,
        traineeMinimum: 2,
        traineeReadyAfter: 3,
        warningWindowDays: 14,
        countBy: 'timeslot',
        defaultDeadline: 'period_end',
        exceptions: [],
        version: 1,
        updatedAt: store.now.toISOString(),
      }),
    )
    .get('/open-days/{openDayId}', ({ store, params }) => {
      const day = findDay(store, params.openDayId);
      return day ? ok(openDayView(store, day)) : notFound('Open Day');
    })
    .get('/open-day-staff-requirements/{requirementId}/eligible-people', ({ store, params, query }) => {
      const day = store.openDays.find((item) => dayRequirements(item).some((r) => r.id === params.requirementId));
      if (!day) return notFound('Requirement');
      const search = (query.get('search') ?? '').toLowerCase();
      const taken = new Set(dayRequirements(day).flatMap((r) => (r.assignments ?? []).map((a) => a.personId)));
      return ok({
        items: store.people
          .filter((person) => !taken.has(person.id) && personName(person).toLowerCase().includes(search))
          .map((person) => ({ personId: person.id, displayName: personName(person) })),
      });
    })
    .add(
      'PUT',
      '/open-days/{openDayId}/assignments/me',
      ({ store, params, body }) => {
        const day = findDay(store, params.openDayId);
        return day ? assign(store, day, body.requirementId, store.user.person.id) : notFound('Open Day');
      },
      'open_days.signup',
    )
    .add(
      'DELETE',
      '/open-days/{openDayId}/assignments/me',
      ({ store, params, query }) => {
        const day = findDay(store, params.openDayId);
        const timeslotId = query.get('timeslotId');
        return day
          ? unassign(store, day, (a) => a.personId === store.user.person.id && a.timeslotId === timeslotId)
          : notFound('Open Day');
      },
      'open_days.signup',
    )
    .add(
      'POST',
      '/open-days/{openDayId}/assignments',
      ({ store, params, body }) => {
        const day = findDay(store, params.openDayId);
        return day ? assign(store, day, body.requirementId, String(body.personId)) : notFound('Open Day');
      },
      'open_days.assign',
    )
    .add(
      'DELETE',
      '/open-days/{openDayId}/assignments/{assignmentId}',
      ({ store, params }) => {
        const day = findDay(store, params.openDayId);
        return day ? unassign(store, day, (a) => a.id === params.assignmentId) : notFound('Open Day');
      },
      'open_days.assign',
    );
}
