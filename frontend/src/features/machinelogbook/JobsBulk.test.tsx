import { describe, expect, it } from 'vitest';
import { ids, unassignedItem, workItem } from '../../test/machineRuns';
import { batchAvailability, blockedItems, deleteBlocker, hasBookedMaterial, referenceTargets } from './bulkWork';
import { ApiError } from '../../api/http-client';

const secondRunId = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
const secondJobId = '0192f6f8-743e-7c77-a349-cd07c3e8a922';
const otherMachineId = '0192f6f8-743e-7c77-a349-cd07c3e8a923';

const run1 = unassignedItem({ version: 5 });
const run2 = unassignedItem({ id: secondRunId, displayId: 'RN-2026-000009', fileName: 'cover_v1.gcode', version: 2 });
const runElsewhere = unassignedItem({
  id: secondRunId,
  displayId: 'RN-2026-000010',
  fileName: 'other.gcode',
  machineId: otherMachineId,
  machineName: 'Laser #2',
  version: 2,
});
const runRunning = unassignedItem({
  id: secondRunId,
  displayId: 'RN-2026-000011',
  fileName: 'live.gcode',
  status: 'running_unassigned',
});
const plainJob = workItem({ version: 3 });
const orderJob = workItem({
  id: secondJobId,
  displayId: 'J-2026-000002',
  title: 'Bracket',
  billing: { state: 'on_order', orderId: ids.otherJob, orderReference: 'O-2026-000004' },
  version: 7,
});
const recordedJob = workItem({
  source: 'recorded',
  runCount: 2,
  version: 3,
  consumption: { materials: [{ materialTypeName: 'PLA', unit: 'g', quantity: '183.000' }], measures: {} },
});

describe('batch action rules', () => {
  const can =
    (...granted: string[]) =>
    (permission: string) =>
      granted.includes(permission);
  const everything = can('machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.delete');

  it('offers run actions only for unassigned runs of one machine and needs two runs to combine', () => {
    expect(batchAvailability([run1], everything as never)).toMatchObject({
      delete: { enabled: true },
      separate: { enabled: true },
      combined: { enabled: false },
      attach: { enabled: true },
    });
    expect(batchAvailability([run1, run2], everything as never)).toMatchObject({
      separate: { enabled: true },
      combined: { enabled: true },
      attach: { enabled: true },
    });
    const mixed = batchAvailability([run1, plainJob], everything as never);
    expect(mixed.separate.reason).toMatch(/only unassigned runs/);
    expect(mixed.delete.enabled).toBe(true);
    const machines = batchAvailability([run1, runElsewhere], everything as never);
    expect(machines.combined.reason).toMatch(/different machines/);
    expect(machines.attach.reason).toMatch(/different machines/);
    expect(machines.separate.enabled).toBe(true);
    expect(batchAvailability([run1, runRunning], everything as never).separate.reason).toMatch(/still running/);
  });

  it('follows the permission of the single operation', () => {
    expect(batchAvailability([run1], can('machine_jobs.edit') as never)).toMatchObject({
      delete: { enabled: false },
      separate: { enabled: false },
      attach: { enabled: true },
    });
    expect(batchAvailability([run1], can('machine_jobs.create') as never)).toMatchObject({
      delete: { enabled: false },
      separate: { enabled: true },
      attach: { enabled: false },
    });
    expect(batchAvailability([run1], can('machine_jobs.delete') as never)).toMatchObject({
      delete: { enabled: true },
      separate: { enabled: false },
      combined: { enabled: false },
    });
    expect(batchAvailability([], everything as never).delete.enabled).toBe(false);
  });

  it('skips jobs on an order and running runs when deleting', () => {
    expect(deleteBlocker(orderJob)).toBe('J-2026-000002 is on order O-2026-000004 — remove it from the order first');
    expect(deleteBlocker(runRunning)).toMatch(/still running/);
    expect(deleteBlocker(plainJob)).toBeNull();
    expect(batchAvailability([orderJob, runRunning], everything as never).delete.reason).toMatch(/every selected item/);
  });

  it('asks about material only when own material was consumed', () => {
    expect(hasBookedMaterial(recordedJob)).toBe(true);
    expect(
      hasBookedMaterial(
        workItem({
          consumption: { materials: [{ materialTypeName: 'External', unit: 'g', quantity: '50' }], measures: {} },
        }),
      ),
    ).toBe(false);
    expect(hasBookedMaterial(workItem({ consumption: { materials: [], measures: {} } }))).toBe(false);
    expect(referenceTargets([orderJob])).toEqual({ 'J-2026-000002': secondJobId, 'O-2026-000004': ids.otherJob });
  });

  it('reads the blocking items of a refused request', () => {
    const items = [
      {
        kind: 'job',
        id: secondJobId,
        displayId: 'J-2026-000002',
        code: 'job_on_order',
        message: 'J-2026-000002 is on an order',
      },
    ];
    expect(blockedItems(new ApiError(409, { code: 'bulk_blocked', message: 'x', details: { items } }))).toEqual(items);
    expect(blockedItems(new ApiError(409, { code: 'stale_write', message: 'x' }))).toBeNull();
    expect(blockedItems(new Error('x'))).toBeNull();
  });
});
