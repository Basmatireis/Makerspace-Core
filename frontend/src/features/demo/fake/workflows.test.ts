import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../../../api/generated/authentication/authentication';
import { getPersonalDashboard } from '../../../api/generated/dashboard/dashboard';
import {
  createMaterial,
  getMaterial,
  listMaterials,
  receiveInventoryStock,
} from '../../../api/generated/inventory/inventory';
import { createMachineJob, getMachineJob, updateMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import { listMachineLogbookWorkItems } from '../../../api/generated/machine-logbook/machine-logbook';
import { attachMachineRun, createMachineJobFromRun } from '../../../api/generated/machine-runs/machine-runs';
import {
  assignOpenDayPerson,
  getOpenDay,
  joinOpenDay,
  leaveOpenDay,
  listOpenDayPeriods,
  listOpenDaySeries,
  listOpenDays,
  removeOpenDayAssignment,
  saveOpenDaySchedule,
} from '../../../api/generated/open-days/open-days';
import {
  addOrderItem,
  checkoutOrder,
  createOrder,
  finalizeOrder,
  getOrder,
  listOrders,
} from '../../../api/generated/orders/orders';
import { listOrderPayments, recordOrderPayment, reverseOrderPayment } from '../../../api/generated/payments/payments';
import { apiFetch, ApiError, setApiTransport } from '../../../api/http-client';
import { getMyCalendarFeed } from '../../../api/generated/calendar-feed/calendar-feed';
import { getStaffingRules, getSupervisorDashboard } from '../../../api/generated/supervisors/supervisors';
import { demoTestUser } from '../demoTestUser';
import { createDemoBackend } from './backend';
import { DEMO_IDS } from './ids';
import { dayRequirements, myAssignment } from '../../opendays/timeslots';

const operationKey = '01990000-0000-7000-8000-00000000f001';

function start(permissions?: Parameters<typeof demoTestUser>[0]) {
  const backend = createDemoBackend(demoTestUser(permissions), new Date('2026-11-04T10:00:00Z'));
  setApiTransport(backend.transport);
  return backend;
}

let networkFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkFetch = vi.fn().mockRejectedValue(new Error('demo mode must not reach the network'));
  vi.stubGlobal('fetch', networkFetch);
});
afterEach(() => {
  setApiTransport(null);
  vi.unstubAllGlobals();
});

describe('transport', () => {
  it('answers from the fake backend and never touches the network', async () => {
    start();
    expect((await getCurrentUser()).person.firstName).toBe('Ada');
    await expect(apiFetch('/api/v1/people', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 409,
      data: { code: 'demo_unavailable', message: 'Not available in demo mode.' },
    });
    await expect(apiFetch('/api/v1/settings/unknown')).rejects.toMatchObject({
      status: 404,
      data: { code: 'demo_unavailable' },
    });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('lets only public branding reads reach the network', async () => {
    networkFetch.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    start();
    await apiFetch('/api/v1/public/config');
    expect(networkFetch).toHaveBeenCalledTimes(1);
    await expect(apiFetch('/api/v1/public/config', { method: 'PUT', body: '{}' })).rejects.toBeInstanceOf(ApiError);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses writes the user has no permission for', async () => {
    start(['machine_jobs.read']);
    await expect(joinOpenDay(DEMO_IDS.openDay, { requirementId: 'x' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('workshop', () => {
  it('claims a recorded run into a new job', async () => {
    start();
    const before = await listMachineLogbookWorkItems({ status: ['unassigned'] });
    expect(before.items.map((item) => item.id)).toContain(DEMO_IDS.unassignedRun);
    const job = await createMachineJobFromRun(DEMO_IDS.unassignedRun, {
      title: 'Benchy',
      customer: { kind: 'person', id: DEMO_IDS.customer },
      operatorPersonId: demoTestUser().person.id,
    });
    expect(job.runs.map((run) => run.id)).toEqual([DEMO_IDS.unassignedRun]);
    expect(job.pricingStatus).toBe('complete');
    const after = await listMachineLogbookWorkItems({ status: ['unassigned'] });
    expect(after.items.map((item) => item.id)).not.toContain(DEMO_IDS.unassignedRun);
    const jobs = await listMachineLogbookWorkItems({ billing: ['not_on_order'] });
    expect(jobs.items.map((item) => item.id)).toContain(job.id);
  });

  it('attaches a run to an existing job', async () => {
    start();
    const target = await getMachineJob(DEMO_IDS.job);
    const attached = await attachMachineRun(DEMO_IDS.unassignedRun2, {
      machineJobId: target.id,
      replaceManualRuns: false,
      expectedJobVersion: target.version,
    });
    expect(attached.runs).toHaveLength(2);
    expect(attached.version).toBe(target.version + 1);
  });

  it('creates and edits a manual job', async () => {
    start();
    const operatorPersonId = demoTestUser().person.id;
    const job = await createMachineJob({
      machineId: DEMO_IDS.machines.laser,
      customer: { kind: 'organization', id: DEMO_IDS.organization },
      operatorPersonId,
      title: 'Signs',
      run: { endsAt: '2026-11-04T09:00:00Z', startsAt: '2026-11-04T08:00:00Z', usages: [] },
    });
    expect(job.title).toBe('Signs');
    // 1 h of laser time at the External rate (2 x 12.00).
    expect(job.effectivePrice).toBe('24.00');
    const updated = await updateMachineJob(job.id, {
      machineId: job.machine.id,
      operatorPersonId,
      title: 'Signs v2',
      notes: 'Done',
      outcomeOverride: null,
      expectedVersion: job.version,
    });
    expect(updated.title).toBe('Signs v2');
    const items = await listMachineLogbookWorkItems({ search: 'v2' });
    expect(items.items.map((item) => item.id)).toEqual([job.id]);
  });

  it('receives stock into a new material and a new spool', async () => {
    start();
    const material = await createMaterial({ materialTypeId: '01990000-0000-7000-8000-000000000e01', colorName: 'Red' });
    expect(material.quantity).toBe('0.000');
    const result = await receiveInventoryStock({
      materialId: material.id,
      packageCount: 2,
      packageSize: '1000',
      totalPrice: '40.00',
      occurredAt: '2026-11-04T10:00:00Z',
      placement: { mode: 'new_spools' },
    });
    expect(result.spools).toHaveLength(2);
    const reloaded = await getMaterial(material.id);
    expect(reloaded.quantity).toBe('2000.000');
    expect((await listMaterials()).items.map((item) => item.id)).toContain(material.id);
  });
});

describe('sales', () => {
  it('checks a job out and pays it in cash', async () => {
    start();
    const job = await getMachineJob(DEMO_IDS.job);
    const order = await createOrder({
      customer: { kind: 'person', id: DEMO_IDS.customer },
      fulfillmentMode: 'immediate',
    });
    const withItem = await addOrderItem(order.id, {
      kind: 'machine_job',
      machineJobId: job.id,
      expectedJobVersion: job.version,
      expectedVersion: order.version,
    });
    expect(withItem.totalAmount).toBe(job.effectivePrice);
    const paid = await checkoutOrder(order.id, {
      operationKey,
      expectedVersion: withItem.version,
      payments: [{ method: 'cash', amount: withItem.totalAmount, occurredAt: '2026-11-04T10:00:00Z' }],
    });
    expect(paid.status).toBe('finalized');
    expect(paid.settlementState).toBe('paid');
    expect((await getOrder(order.id)).outstandingAmount).toBe('0.00');
    const payments = await listOrderPayments();
    expect(payments.items.some((payment) => payment.allocations.some((a) => a.orderId === order.id))).toBe(true);
    const items = await listMachineLogbookWorkItems({ billing: ['on_order'] });
    expect(items.items.find((item) => item.id === job.id)?.billing?.orderReference).toBe(paid.reference);
    // The same job cannot go on a second order.
    const second = await createOrder({ fulfillmentMode: 'immediate' });
    await expect(
      addOrderItem(second.id, { kind: 'machine_job', machineJobId: job.id, expectedVersion: second.version }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('finalizes, pays and reverses a payment on the sample order', async () => {
    start();
    const open = await getOrder(DEMO_IDS.order);
    expect(open.settlementState).toBe('unpaid');
    const paid = await recordOrderPayment(open.id, {
      operationKey,
      expectedVersion: open.version,
      payment: { method: 'card', amount: open.outstandingAmount, occurredAt: '2026-11-04T10:00:00Z' },
    });
    expect(paid.settlementState).toBe('paid');
    const payment = paid.allocations[0];
    const reversed = await reverseOrderPayment(payment.paymentId!, {
      operationKey,
      expectedVersion: paid.version,
      reversal: {
        paymentId: payment.paymentId!,
        reasonKind: 'refund',
        reason: 'Customer returned it',
        occurredAt: '2026-11-04T11:00:00Z',
      },
    });
    expect(reversed.settlementState).toBe('unpaid');
  });

  it('keeps a draft out of the paid list until it is finalized', async () => {
    start();
    const draft = await createOrder({ fulfillmentMode: 'deferred' });
    await expect(finalizeOrder(draft.id, { operationKey, expectedVersion: draft.version })).rejects.toMatchObject({
      status: 422,
    });
    const listed = await listOrders({ status: 'draft' });
    expect(listed.items.map((item) => item.id)).toEqual([draft.id]);
  });
});

describe('open days', () => {
  it('joins and leaves an open day', async () => {
    start();
    const day = await getOpenDay(DEMO_IDS.openDay);
    const supervisors = dayRequirements(day).find((item) => item.kind === 'supervisor')!;
    await joinOpenDay(day.id, { requirementId: supervisors.id });
    const joined = await getOpenDay(day.id);
    expect(myAssignment(joined)?.requirementId).toBe(supervisors.id);
    expect(dayRequirements(joined).find((item) => item.id === supervisors.id)?.assignedCount).toBe(
      supervisors.assignedCount + 1,
    );
    expect((await listOpenDayPeriods()).items[0].myAssignmentCount).toBe(1);
    const dashboard = await getPersonalDashboard();
    expect(dashboard.comingUp?.map((item) => item.openDayId)).toEqual([day.id]);
    await expect(joinOpenDay(day.id, { requirementId: supervisors.id })).rejects.toMatchObject({ status: 409 });
    await leaveOpenDay(day.id, { timeslotId: day.timeslots[0].id });
    expect(myAssignment(await getOpenDay(day.id))).toBeNull();
  });

  it('assigns and removes another person', async () => {
    start();
    const day = await getOpenDay(DEMO_IDS.openDay);
    const trainees = dayRequirements(day).find((item) => item.kind === 'trainee')!;
    const assignment = await assignOpenDayPerson(day.id, { requirementId: trainees.id, personId: DEMO_IDS.customer });
    expect(assignment.displayName).toBe('Robin Sample');
    const assigned = await getOpenDay(day.id);
    expect(dayRequirements(assigned).find((item) => item.id === trainees.id)?.assignedCount).toBe(2);
    // The trainee requirement is now full.
    await expect(
      assignOpenDayPerson(day.id, { requirementId: trainees.id, personId: demoTestUser().person.id }),
    ).rejects.toMatchObject({ status: 409 });
    await removeOpenDayAssignment(day.id, assignment.id);
    expect(dayRequirements(await getOpenDay(day.id)).find((item) => item.id === trainees.id)?.assignedCount).toBe(1);
  });
});

describe('schedule, staffing and calendar feed', () => {
  const manager = [...demoTestUser().permissions, 'open_days.manage', 'supervisor_dashboard.read'];
  const slot = (id?: string) => ({
    ...(id ? { id } : {}),
    startsAt: '2026-12-01T16:00:00Z',
    endsAt: '2026-12-01T19:00:00Z',
    requirements: [
      { kind: 'supervisor' as const, requiredCount: 2, eligibleRoleIds: [] },
      { kind: 'trainee' as const, requiredCount: 1, eligibleRoleIds: [] },
    ],
  });

  it('saves one delta: a new day, a weekly series and an edit that leaves the series', async () => {
    start(manager as Parameters<typeof demoTestUser>[0]);
    const before = await listOpenDays(DEMO_IDS.period);
    expect(await listOpenDaySeries(DEMO_IDS.period)).toEqual({ items: [] });
    const saved = await saveOpenDaySchedule(DEMO_IDS.period, {
      expectedPeriodVersion: before.period.version,
      creates: [{ internalNote: null, timeslots: [slot()] }],
      updates: [],
      removals: [],
      seriesCreates: [
        {
          weekday: 3,
          fromDate: '2026-12-02',
          untilDate: '2026-12-23',
          timeslots: [{ startTime: '17:00', endTime: '20:00' }],
          supervisorPlaces: 2,
          traineePlaces: 1,
          supervisorRoleIds: [],
          traineeRoleIds: [],
          forcedDates: [],
        },
      ],
    });
    expect(saved.items).toHaveLength(before.items.length + 1 + 4);
    expect(saved.period.version).toBe(before.period.version + 1);
    const series = (await listOpenDaySeries(DEMO_IDS.period)).items;
    expect(series).toHaveLength(1);
    expect(series[0].dayCount).toBe(4);

    const day = saved.items.find((item) => item.seriesId === series[0].id)!;
    const edited = await saveOpenDaySchedule(DEMO_IDS.period, {
      expectedPeriodVersion: saved.period.version,
      creates: [],
      updates: [
        {
          id: day.id,
          internalNote: 'Moved',
          expectedVersion: day.version,
          timeslots: [
            { ...slot(day.timeslots[0].id), startsAt: '2026-12-02T15:00:00Z', endsAt: '2026-12-02T18:00:00Z' },
          ],
        },
      ],
      removals: [],
    });
    const moved = edited.items.find((item) => item.id === day.id)!;
    expect(moved.seriesId).toBeNull();
    expect(moved.detachedFromSeriesId).toBe(series[0].id);
    await expect(
      saveOpenDaySchedule(DEMO_IDS.period, {
        expectedPeriodVersion: before.period.version,
        creates: [],
        updates: [],
        removals: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('answers the staffing rules, the supervisor dashboard and the calendar feed status', async () => {
    start(manager as Parameters<typeof demoTestUser>[0]);
    const rules = await getStaffingRules();
    expect(rules.warningWindowDays).toBe(14);
    const dashboard = await getSupervisorDashboard();
    expect(dashboard.semester?.periodId).toBe(DEMO_IDS.period);
    expect(dashboard.supervisors.length).toBeGreaterThan(2);
    expect(await getMyCalendarFeed()).toEqual({ active: false, createdAt: null, lastUsedAt: null });
  });
});
