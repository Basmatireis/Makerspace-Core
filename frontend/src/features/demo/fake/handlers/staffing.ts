import type {
  StaffingStatus,
  SupervisorDashboard,
  SupervisorRow,
  UpdateStaffingRulesRequest,
} from '../../../../api/generated/models';
import { dayRequirements } from '../../../opendays/timeslots';
import { fail, notFound, ok, type DemoRouter } from '../router';
import { can, personName, type DemoStore } from '../store';

/** One row per person who staffs: the first three supervisors, the rest trainees; the signed-in person counts as a supervisor. */
function dashboard(store: DemoStore): SupervisorDashboard {
  const rules = store.staffingRules;
  const period = store.period;
  const days = store.openDays.filter((day) => day.status === 'scheduled');
  const others = store.people.filter((person) => person.id !== store.user.person.id);
  const staff = [store.user.person.id, ...others.map((person) => person.id)];
  const supervisors: SupervisorRow[] = staff.map((personId, index) => {
    const person = store.people.find((item) => item.id === personId);
    const membership = index < 4 ? 'supervisor' : 'trainee';
    const slots = days.flatMap((day) =>
      day.timeslots.filter((slot) =>
        slot.requirements.some((item) => item.assignments?.some((assignment) => assignment.personId === personId)),
      ),
    );
    const booked =
      rules.countBy === 'open_day' ? new Set(slots.map((slot) => slot.startsAt.slice(0, 10))).size : slots.length;
    const minimum = membership === 'supervisor' ? rules.supervisorMinimum : rules.traineeMinimum;
    const missing = Math.max(0, minimum - booked);
    const status: StaffingStatus = missing > 0 ? 'missing' : minimum === 0 ? 'no_minimum' : 'fulfilled';
    const next = days
      .flatMap((day) =>
        dayRequirements(day).some((item) => item.assignments?.some((assignment) => assignment.personId === personId))
          ? [day]
          : [],
      )
      .at(0);
    return {
      personId,
      personVersion: 1,
      name: person ? personName(person) : 'Unknown',
      membership,
      extraRoles: [],
      competencies: [],
      hasProfileImage: false,
      laborordnungState: 'current',
      staffed: 0,
      booked,
      staffedAsTrainee: 0,
      minimum,
      minimumSource: 'membership',
      minimumExceptionRole: null,
      excused: false,
      excusalReason: null,
      status,
      missing,
      lastOpenDayAt: null,
      nextAssignment: next ? { openDayId: next.id, startsAt: next.startsAt, endsAt: next.endsAt } : null,
      memberSince: '2025-09-01',
    };
  });
  return {
    semester: {
      periodId: period.id,
      name: period.name,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      signUpBy: period.signUpDeadline ?? period.endsOn,
    },
    rules,
    supervisors,
    totals: {
      supervisors: supervisors.length,
      profileImagesComplete: 0,
      laborordnungCurrent: supervisors.length,
      laborordnungOutdated: 0,
    },
  };
}

export function registerStaffing(router: DemoRouter<DemoStore>): void {
  router
    .get('/staffing-rules', ({ store }) => ok(store.staffingRules))
    .add(
      'PUT',
      '/staffing-rules',
      ({ store, body }) => {
        const request = body as unknown as UpdateStaffingRulesRequest;
        if (request.expectedVersion !== store.staffingRules.version)
          return fail(409, 'stale_write', 'The rules changed meanwhile.');
        store.staffingRules = {
          supervisorMinimum: request.supervisorMinimum,
          traineeMinimum: request.traineeMinimum,
          traineeReadyAfter: request.traineeReadyAfter,
          warningWindowDays: request.warningWindowDays,
          countBy: request.countBy,
          defaultDeadline: request.defaultDeadline,
          exceptions: request.exceptions.flatMap((item) => {
            const role = store.roles.find((candidate) => candidate.id === item.roleId);
            return role ? [{ roleId: role.id, roleName: role.name, minimum: item.minimum }] : [];
          }),
          version: store.staffingRules.version + 1,
          updatedAt: store.now.toISOString(),
        };
        return ok(store.staffingRules);
      },
      'open_days.manage',
    )
    .get('/supervisor-dashboard', ({ store, query }) => {
      const periodId = query.get('periodId');
      if (periodId && periodId !== store.period.id) return notFound('Period');
      return can(store, 'supervisor_dashboard.read') ? ok(dashboard(store)) : fail(403, 'forbidden', 'Not allowed.');
    })
    // The calendar subscription is never created in demo mode: only its (empty) status is answered.
    .get('/me/calendar-feed', () => ok({ active: false, createdAt: null, lastUsedAt: null }));
}
