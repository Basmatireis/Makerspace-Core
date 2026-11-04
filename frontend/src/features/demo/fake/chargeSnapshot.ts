import type { JobChargeSnapshot, MachineJob } from '../../../api/generated/models';
import type { DemoStore } from './store';

/** What an order line freezes about a job at the time it is added. */
export function chargeSnapshot(store: DemoStore, job: MachineJob): JobChargeSnapshot {
  return {
    displayId: job.displayId,
    machineId: job.machine.id,
    machineName: job.machine.name,
    processId: job.machine.process.id,
    processName: job.machine.process.name,
    startsAt: job.startedAt ?? job.createdAt,
    endsAt: job.endedAt ?? job.updatedAt,
    durationNanoseconds: String(job.durationSeconds * 1_000_000_000),
    outcome: job.outcome,
    usages: job.runs.flatMap((run) => run.usages),
    pricing: job.pricingSnapshot ?? null,
    pricingStatus: job.pricingStatus,
    calculatedAmount: job.calculatedPrice,
    effectiveAmount: job.effectivePrice ?? '0.00',
    capturedAt: store.now.toISOString(),
  };
}
