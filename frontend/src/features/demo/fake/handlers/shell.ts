import type {
  GuideProgress,
  PersonalDashboard,
  PersonalOrder,
  PersonalRecentJob,
  PublicOpenDay,
} from '../../../../api/generated/models';
import { billingOf } from '../jobModel';
import { comingUp, staffingOf } from '../openDayModel';
import { fail, noContent, ok, paged, type DemoRouter } from '../router';
import { can, money, toCents, type DemoStore } from '../store';

const personalOrder = (order: DemoStore['orders'][number]): PersonalOrder => ({
  id: order.id,
  reference: order.reference,
  status: order.status === 'reversed' ? 'reversed' : 'finalized',
  createdAt: order.createdAt,
  itemSummary: order.items.map((item) => item.description).join(', '),
  itemCount: order.items.length,
  netCharge: order.netCharge,
  outstandingAmount: order.outstandingAmount,
  settlementState: order.settlementState,
  invoiced: false,
  payable: order.status === 'finalized' && toCents(order.outstandingAmount) > 0,
});

function dashboard(store: DemoStore): PersonalDashboard {
  const result: PersonalDashboard = {
    person: { firstName: store.user.person.firstName, memberSince: store.user.person.memberSince },
    comingUp: can(store, 'open_days.read') ? comingUp(store) : [],
  };
  if (can(store, 'open_days.read') && (can(store, 'open_days.signup') || comingUp(store).length > 0)) {
    result.staffing = staffingOf(store);
    result.statistics = {
      openDaysStaffed: 0,
      openDayHours: 0,
      eventShifts: 0,
      eventShiftHours: 0,
      memberSince: store.user.person.memberSince,
    };
  }
  if (can(store, 'orders.read')) {
    const finalized = store.orders.filter((order) => order.status === 'finalized');
    const unpaid = finalized.filter((order) => toCents(order.outstandingAmount) > 0).map(personalOrder);
    const unbilled = store.jobs
      .filter((job) => job.customer?.id === store.user.person.id && billingOf(store, job).state === 'not_on_order')
      .map((job) => ({
        id: job.id,
        displayId: job.displayId,
        title: job.title ?? job.machine.name,
        machineName: job.machine.name,
        startedAt: job.startedAt ?? job.createdAt,
        price: job.effectivePrice ?? '0.00',
      }));
    const unpaidTotal = unpaid.reduce((sum, order) => sum + toCents(order.outstandingAmount), 0);
    const unbilledTotal = unbilled.reduce((sum, job) => sum + toCents(job.price), 0);
    result.balance = {
      unpaidOrders: unpaid,
      unbilledJobs: unbilled,
      unpaidOrdersTotal: money(unpaidTotal),
      unbilledJobsTotal: money(unbilledTotal),
      total: money(unpaidTotal + unbilledTotal),
    };
    result.recentOrders = [...store.orders].reverse().slice(0, 5).map(personalOrder);
  }
  if (can(store, 'machine_jobs.read')) {
    result.recentJobs = [...store.jobs]
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 5)
      .map((job): PersonalRecentJob => ({
        id: job.id,
        displayId: job.displayId,
        title: job.title ?? job.machine.name,
        machineName: job.machine.name,
        startedAt: job.startedAt ?? null,
        endedAt: job.endedAt ?? null,
        status: job.status,
        price: job.effectivePrice ?? null,
        own: job.customer?.id === store.user.person.id,
        billingState: billingOf(store, job).state,
        orderReference: billingOf(store, job).orderReference ?? null,
      }));
  }
  return result;
}

/** The endpoints every page of the shell and the dashboard load. */
export function registerShell(router: DemoRouter<DemoStore>): void {
  router
    .get('/auth/me', ({ user }) =>
      ok({ ...user, laborordnungStatus: { ...user.laborordnungStatus, actionRequired: false } }),
    )
    // The shell reports activity to keep the session alive; in demo mode that is a no-op that returns the session.
    .add('POST', '/auth/activity', ({ user }) => ok(user.session))
    .get('/laborordnung/status/me', ({ user }) => ok({ ...user.laborordnungStatus, actionRequired: false }))
    .get('/notifications/unread-count', () => ok({ unreadCount: 0 }))
    .get('/notifications', ({ query }) => ok(paged([], query, { unreadCount: 0 })))
    .get('/me/dashboard', ({ store }) => ok(dashboard(store)))
    .get('/public/open-days', ({ store }) =>
      ok({
        items: store.openDays.map((day): PublicOpenDay => ({
          id: day.id,
          title: 'Open Day',
          competencies: day.competencies,
          startsAt: day.startsAt,
          timeslots: day.timeslots.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
          endsAt: day.endsAt,
          status: day.status,
          updatedAt: day.updatedAt,
        })),
      }),
    )
    // Guide progress lives in the store, so finishing a tour in demo mode never reaches the real account.
    .get('/me/guides', ({ store }) => ok({ items: store.guideProgress }))
    .add('PUT', '/me/guides/{guideId}', ({ store, params, body }) => {
      const entry: GuideProgress = {
        guideId: params.guideId,
        status: body.status as GuideProgress['status'],
        updatedAt: store.now.toISOString(),
      };
      store.guideProgress = [...store.guideProgress.filter((item) => item.guideId !== entry.guideId), entry];
      return ok(entry);
    })
    .add('DELETE', '/me/guides', ({ store }) => {
      store.guideProgress = [];
      return noContent();
    })
    .get('/roles', ({ store }) => ok({ items: store.roles, nextCursor: null }))
    .get('/roles/{roleId}', ({ store, params }) => {
      const role = store.roles.find((item) => item.id === params.roleId);
      return role ? ok(role) : fail(404, 'not_found', 'Role not found.');
    });
}
