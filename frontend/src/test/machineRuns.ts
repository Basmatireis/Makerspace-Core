import type { Machine, MachineJob, MachineRun, MachineRunDetail, WorkItem } from '../api/generated/models';

// Shared fixtures for the Machines & Jobs tests: a machine, jobs made of runs, and work items.

export const ids = {
  type: '0192f6f8-743e-7c77-a349-cd07c3e8a910',
  machine: '0192f6f8-743e-7c77-a349-cd07c3e8a911',
  material: '0192f6f8-743e-7c77-a349-cd07c3e8a912',
  job: '0192f6f8-743e-7c77-a349-cd07c3e8a914',
  organization: '0192f6f8-743e-7c77-a349-cd07c3e8a915',
  operator: '0192f6f8-743e-7c77-a349-cd07c3e8a916',
  manualRun: '0192f6f8-743e-7c77-a349-cd07c3e8a917',
  recordedRun: '0192f6f8-743e-7c77-a349-cd07c3e8a919',
  usage: '0192f6f8-743e-7c77-a349-cd07c3e8a918',
  otherJob: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
  pricingGroup: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
};

export const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

export const machine: Machine = {
  id: ids.machine,
  machineType: { id: ids.type, name: '3D printer', active: true, process: 'fdm_printing', version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  name: 'Bambu H2D #1', status: 'active', externalIdentifier: 'BH2D-1', automaticCollectionEnabled: true, lastIngestedAt: '2026-09-15T11:26:00Z',
  jobCount: 42, runtimeSeconds: 84000, failureRate: '4.2', version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-15T11:26:00Z',
};

export const customer = { kind: 'organization' as const, id: ids.organization, displayName: 'TU Berlin', organizationKind: 'institute' as const, pricingGroup: { id: ids.pricingGroup, name: 'Partner' }, pricingGroupAssignmentVersion: 1 };
export const operator = { personId: ids.operator, displayName: 'Maria Hoffmann' };

export const usage = (overrides: Partial<MachineRun['usages'][number]> = {}): MachineRun['usages'][number] => ({
  id: ids.usage, ownership: 'makerspace', materialId: ids.material, spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', materialTypeId: '0192f6f8-743e-7c77-a349-cd07c3e8e001', materialTypeName: 'PLA', unit: 'g', quantity: '183.000', quantityBasis: 'actual',
  staffCorrected: false,
  ...overrides,
});

/** A finished manual run, 90 minutes long, that ended 30 minutes ago. */
export function manualRun(overrides: Partial<MachineRun> = {}): MachineRun {
  return {
    id: ids.manualRun, displayId: 'RN-2026-000001', machineId: ids.machine, machineName: machine.name, source: 'manual', state: 'finished',
    job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' }, connectorName: null, fileName: null,
    startedAt: iso(-120), endedAt: iso(-30), estimatedEndAt: null, durationSeconds: 5400, progressPercent: null, outcome: 'successful', outcomeFromMachine: false,
    usages: [usage()], measures: {}, usagesFromMachine: false, reportedUsage: null, reportedUsageItems: [], artifact: null, version: 2,
    ...overrides,
  };
}

/** A finished recorded run of the same machine, 60 minutes long. */
export function recordedRun(overrides: Partial<MachineRunDetail> = {}): MachineRunDetail {
  return {
    id: ids.recordedRun, displayId: 'RN-2026-000007', machineId: ids.machine, machineName: machine.name, source: 'recorded', state: 'finished',
    job: null, connectorName: 'Bambu LAN', fileName: 'gearbox_housing_v3.gcode',
    startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T09:00:00Z', estimatedEndAt: null, durationSeconds: 3600, progressPercent: 100, outcome: 'successful', outcomeFromMachine: true,
    usages: [], measures: {}, usagesFromMachine: false, reportedUsageItems: [], artifact: null,
    reportedUsage: { quantity: '42.000', quantityBasis: 'actual', materialId: ids.material, materialName: 'PLA Black', spoolId: null, spoolDisplayId: null },
    version: 1,
    events: [
      { id: ids.usage, kind: 'operational_state', occurredAt: '2026-09-15T08:00:00Z', state: 'printing' },
      { id: ids.otherJob, kind: 'terminal_outcome', occurredAt: '2026-09-15T09:00:00Z', state: 'finished' },
    ],
    ...overrides,
  };
}

/** A job with one finished manual run unless `runs` says otherwise. */
export function jobFixture(overrides: Partial<MachineJob> = {}): MachineJob {
  const runs = overrides.runs ?? [manualRun()];
  const active = runs.filter((run) => run.state !== 'replaced');
  return {
    id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing', machine, runs,
    startedAt: runs[0]?.startedAt ?? null, endedAt: active.every((run) => run.endedAt) ? active.at(-1)?.endedAt ?? null : null, expectedEndAt: null,
    durationSeconds: active.reduce((sum, run) => sum + run.durationSeconds, 0),
    measures: {}, customer, operator, outcome: 'successful', outcomeOverridden: false, status: 'successful', notes: 'Print with 0.2 mm layers',
    pricingStatus: 'complete',
    pricingSnapshot: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a931', revision: 1, pricingGroupName: 'Partner', currency: 'EUR', reason: 'created', complete: true, calculatedAmount: '12.50', rules: [{ kind: 'machine_runtime', label: '3D printer runtime', selector: '3D printer', unit: 'hour', rate: '5.00', missing: false }], capturedAt: '2026-09-15T11:26:00Z' },
    calculatedPrice: '12.50', priceAdjustment: null, effectivePrice: '12.50', version: 3, createdAt: '2026-09-15T11:26:00Z', updatedAt: '2026-09-15T11:26:00Z',
    ...overrides,
  } as MachineJob;
}

/** A job whose manual run started 30 minutes ago and ends in 30 minutes. */
export const runningJob = () => jobFixture({
  runs: [manualRun({ state: 'running', startedAt: iso(-30), endedAt: null, estimatedEndAt: iso(30), durationSeconds: 3600, outcome: null, usages: [] })],
  endedAt: null, expectedEndAt: iso(30), durationSeconds: 3600, outcome: 'unknown', status: 'running', calculatedPrice: null, effectivePrice: null, pricingStatus: 'pending', pricingSnapshot: null,
});

/** A job with a finished manual run that has no outcome yet. */
export const needsOutcomeJob = () => jobFixture({ runs: [manualRun({ outcome: null })], outcome: 'unknown', status: 'needs_outcome' });

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    kind: 'job', id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing', fileName: null, runCount: 1, machineId: ids.machine, machineName: machine.name, status: 'successful', source: 'manual',
    startedAt: '2026-09-15T08:12:00Z', endsAt: '2026-09-15T11:26:00Z', effectivePrice: '12.50', billing: { state: 'not_on_order' }, version: 3,
    ...overrides,
  };
}

/** An unassigned recorded run as the work-item list shows it. */
export const unassignedItem = (overrides: Partial<WorkItem> = {}): WorkItem => workItem({
  kind: 'run', id: ids.recordedRun, displayId: 'RN-2026-000008', title: null, fileName: 'bracket_v2.gcode', runCount: 1, status: 'unassigned', source: 'recorded',
  startedAt: '2026-09-16T09:00:00Z', endsAt: '2026-09-16T10:00:00Z', effectivePrice: null, billing: undefined, version: undefined,
  ...overrides,
});
