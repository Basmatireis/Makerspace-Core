import type {
  BillingParty,
  Machine,
  MachineJob,
  MachineJobUsage,
  MachineRunDetail,
  MachineRunRecording,
  Operator,
  WorkItem,
} from '../../../../api/generated/models';
import { billingOf, plainRun, refreshJob, runDuration, workItemOfJob, workItemOfRun } from '../jobModel';
import { created, fail, notFound, ok, paged, type DemoRouter } from '../router';
import {
  billingParty,
  organizationParty,
  nextId,
  nextReference,
  personName,
  personParty,
  type DemoStore,
} from '../store';

/** Array filters arrive repeated (`status=a&status=b`) or comma-separated. */
const csv = (query: URLSearchParams, key: string): string[] =>
  query
    .getAll(key)
    .flatMap((value) => value.split(','))
    .filter(Boolean);

export function machineView(store: DemoStore, machine: Machine): Machine {
  const jobs = store.jobs.filter((job) => job.machine.id === machine.id);
  const seconds = jobs.reduce((sum, job) => sum + job.durationSeconds, 0);
  const failed = jobs.filter((job) => job.outcome === 'failed' || job.outcome === 'partial_failure').length;
  const unassigned = store.runs.filter((run) => run.machineId === machine.id && !run.job).length;
  return {
    ...machine,
    jobCount: jobs.length,
    runtimeSeconds: seconds,
    failureRate: jobs.length ? (failed / jobs.length).toFixed(2) : '0.00',
    attention: unassigned
      ? [
          {
            code: 'runs_unassigned',
            message: `${unassigned} recorded run${unassigned === 1 ? '' : 's'} without a job.`,
          },
        ]
      : [],
  };
}

const operatorOf = (store: DemoStore, personId: unknown): Operator | undefined => {
  const person = store.people.find((item) => item.id === personId);
  return person && { personId: person.id, displayName: personName(person) };
};

function toBillingParty(store: DemoStore, reference: unknown): BillingParty | undefined {
  const ref = reference as { kind?: string; id?: string } | undefined;
  return ref?.kind && ref.id ? billingParty(store, ref.kind, ref.id) : undefined;
}

function workItems(store: DemoStore, query: URLSearchParams): WorkItem[] {
  const status = csv(query, 'status');
  const machineIds = csv(query, 'machineId');
  const sources = csv(query, 'source');
  const billing = csv(query, 'billing');
  const search = (query.get('search') ?? '').toLowerCase();
  const from = query.get('from');
  const to = query.get('to');
  const items = [
    ...store.jobs.map((job) => workItemOfJob(store, job)),
    ...store.runs.filter((run) => !run.job && run.state !== 'replaced').map(workItemOfRun),
  ].filter(
    (item) =>
      (!status.length || status.includes(item.status)) &&
      (!machineIds.length || machineIds.includes(item.machineId)) &&
      (!sources.length || sources.includes(item.source)) &&
      (!billing.length || (item.billing && billing.includes(item.billing.state))) &&
      (!query.get('customerId') || item.customer?.id === query.get('customerId')) &&
      (!query.get('operatorPersonId') || item.operator?.personId === query.get('operatorPersonId')) &&
      (!query.get('attention') || (item.attention?.length ?? 0) > 0) &&
      (!from || item.startedAt >= from) &&
      (!to || item.startedAt < to) &&
      (!search ||
        [
          item.displayId,
          item.title,
          item.fileName,
          item.machineName,
          item.customer?.displayName,
          item.operator?.displayName,
        ]
          .filter(Boolean)
          .some((text) => String(text).toLowerCase().includes(search))),
  );
  const direction = query.get('direction') === 'asc' ? 1 : -1;
  const sort = query.get('sort') ?? 'startedAt';
  const key = (item: WorkItem): string =>
    sort === 'name'
      ? (item.title ?? item.fileName ?? '')
      : sort === 'machine'
        ? item.machineName
        : sort === 'customer'
          ? (item.customer?.displayName ?? '')
          : sort === 'price'
            ? (item.effectivePrice ?? '0').padStart(12, '0')
            : item.startedAt;
  return items.sort((a, b) => direction * key(a).localeCompare(key(b)));
}

function usagesOf(store: DemoStore, inputs: unknown): MachineJobUsage[] {
  return ((inputs as Record<string, unknown>[] | undefined) ?? []).map((input) => {
    const material = store.materials.find((item) => item.id === input.materialId);
    const type = store.materialTypes.find((item) => item.id === (input.materialTypeId ?? material?.materialTypeId));
    return {
      id: nextId(store),
      ownership: (input.ownership as MachineJobUsage['ownership']) ?? 'makerspace',
      materialId: material?.id ?? null,
      spoolId: (input.spoolId as string | undefined) ?? null,
      spoolDisplayId: store.spools.find((item) => item.id === input.spoolId)?.displayId ?? null,
      materialName: material?.name ?? String(input.externalMaterialName ?? type?.name ?? 'Material'),
      materialTypeId: type?.id ?? null,
      materialTypeName: type?.name ?? 'Other',
      label: (input.label as string | undefined) ?? null,
      unit: material?.unit ?? type?.unit ?? 'g',
      quantity: String(input.quantity ?? '0'),
      quantityBasis: (input.quantityBasis as MachineJobUsage['quantityBasis']) ?? 'actual',
      staffCorrected: false,
    };
  });
}

function startJob(
  store: DemoStore,
  fields: {
    machine: Machine;
    title?: string | null;
    notes?: string | null;
    customer?: BillingParty;
    operator: Operator;
    hiddenFromSignage?: boolean | null;
  },
  runs: MachineRunDetail[],
): MachineJob {
  const stamp = store.now.toISOString();
  const job: MachineJob = {
    id: nextId(store),
    displayId: nextReference(store, 'J', 3),
    title: fields.title ?? null,
    artifact: null,
    machine: fields.machine,
    runs: [],
    startedAt: null,
    endedAt: null,
    expectedEndAt: null,
    durationSeconds: 0,
    measures: {},
    customer: fields.customer ?? null,
    operator: fields.operator,
    outcome: 'unknown',
    outcomeOverridden: false,
    status: 'needs_outcome',
    notes: fields.notes ?? null,
    pricingStatus: 'pending',
    pricingSnapshot: null,
    calculatedPrice: null,
    priceAdjustment: null,
    effectivePrice: null,
    hiddenFromSignage: fields.hiddenFromSignage ?? false,
    attention: [],
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  for (const run of runs) {
    run.job = { id: job.id, displayId: job.displayId, title: job.title };
    run.version += 1;
  }
  store.jobs.push(job);
  return refreshJob(store, job);
}

function recording(run: MachineRunDetail): MachineRunRecording {
  return {
    runId: run.id,
    runDisplayId: run.displayId,
    source: run.source,
    state: run.state,
    startedAt: run.startedAt,
    consumptionStatus: run.consumptionStatus ?? null,
    artifact: null,
    previews: [],
    timelapse: null,
    timelapseStatus: null,
    commands: [],
  };
}

export function registerWorkshop(router: DemoRouter<DemoStore>): void {
  router
    .get('/machine-logbook/work-items', ({ store, query }) => ok(paged(workItems(store, query), query)))
    .get('/machine-logbook/machine-activity', ({ store }) =>
      ok({
        items: store.machines.map((machine) => ({
          machineId: machine.id,
          availability: 'available',
          current: null,
          connector:
            machine.process.integration === 'fdm_printer'
              ? { runtimeState: 'connected', runtimeErrorCode: null, lastHeartbeatAt: store.now.toISOString() }
              : null,
          lastJobStartedAt: store.jobs.find((job) => job.machine.id === machine.id)?.startedAt ?? null,
        })),
      }),
    )
    .get('/machine-logbook/recycle-bin', () => ok({ jobs: [], runs: [] }))
    .get('/machine-logbook/recording-settings', ({ store }) =>
      ok({
        timelapseEnabled: false,
        timelapseRetentionDays: 90,
        timelapseMaxBytes: 0,
        timelapseMaxBytesLimit: 0,
        timelapseMaxCount: 0,
        timelapseMaxTotalBytes: 0,
        artifactMaxBytes: 0,
        artifactMaxBytesLimit: 0,
        artifactRetentionDays: 90,
        artifactMaxCount: 0,
        artifactMaxTotalBytes: 0,
        version: 1,
        updatedAt: store.now.toISOString(),
      }),
    )
    .get('/machines', ({ store, query }) => {
      const search = (query.get('search') ?? '').toLowerCase();
      const status = query.get('status');
      return ok(
        paged(
          store.machines
            .filter((machine) => machine.name.toLowerCase().includes(search) && (!status || machine.status === status))
            .map((machine) => machineView(store, machine)),
          query,
        ),
      );
    })
    .get('/machines/{machineId}', ({ store, params }) => {
      const machine = store.machines.find((item) => item.id === params.machineId);
      return machine ? ok(machineView(store, machine)) : notFound('Machine');
    })
    .get('/machines/{machineId}/printer', ({ store, params }) => {
      const machine = store.machines.find((item) => item.id === params.machineId);
      if (!machine || machine.process.integration !== 'fdm_printer') return notFound('Printer');
      return ok({
        machineId: machine.id,
        machineName: machine.name,
        enabled: true,
        model: machine.name.startsWith('Bambu') ? 'bambu_h2d' : 'prusa_core_one',
        nozzleCount: 1,
        inputUnits: [],
        slots: [],
        version: 1,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
      });
    })
    .get('/machines/{machineId}/printer/live-status', ({ store, params }) => {
      const machine = store.machines.find((item) => item.id === params.machineId);
      if (!machine || machine.process.integration !== 'fdm_printer') return notFound('Printer');
      return ok({
        machineId: machine.id,
        assignmentId: machine.id,
        receivedAt: store.now.toISOString(),
        observedAt: store.now.toISOString(),
        status: {
          state: 'idle',
          job: null,
          temperatures: { extruders: [], bedC: 22, bedTargetC: null, chamberC: null },
          nozzles: [],
          units: [],
          activeTray: null,
          errors: [],
          firmwareVersion: null,
          wifiSignalDbm: null,
        },
      });
    })
    .get('/machines/{machineId}/printer-errors', () => ok({ items: [] }))
    .get('/printers/detected-spool-tags', () => ok({ items: [] }))
    .get('/processes', ({ store }) => ok({ items: store.processes }))
    .get('/billing-parties', ({ store, query }) => {
      const search = (query.get('search') ?? '').toLowerCase();
      const items = [...store.people.map(personParty), ...store.organizations.map(organizationParty)].filter((party) =>
        party.displayName.toLowerCase().includes(search),
      );
      return ok({ items: items.slice(0, Number(query.get('limit')) || 20) });
    })
    .get('/machine-job-operators', ({ store, query }) => {
      const search = (query.get('search') ?? '').toLowerCase();
      const items = store.people
        .map((person) => ({ personId: person.id, displayName: personName(person) }))
        .filter((operator) => operator.displayName.toLowerCase().includes(search));
      return ok({ items: items.slice(0, Number(query.get('limit')) || 20) });
    })
    .get('/machine-jobs', ({ store, query }) => {
      const machineIds = csv(query, 'machineId');
      const search = (query.get('search') ?? '').toLowerCase();
      const items = store.jobs
        .filter(
          (job) =>
            (!machineIds.length || machineIds.includes(job.machine.id)) &&
            (!query.get('customerId') || job.customer?.id === query.get('customerId')) &&
            (!query.get('outcome') || job.outcome === query.get('outcome')) &&
            (!search || `${job.displayId} ${job.title ?? ''}`.toLowerCase().includes(search)),
        )
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      return ok(paged(items, query));
    })
    .get('/machine-jobs/{machineJobId}', ({ store, params }) => {
      const job = store.jobs.find((item) => item.id === params.machineJobId);
      return job ? ok(job) : notFound('Job');
    })
    .get('/machine-jobs/{machineJobId}/recordings', ({ store, params }) => {
      const job = store.jobs.find((item) => item.id === params.machineJobId);
      if (!job) return notFound('Job');
      return ok({
        items: store.runs.filter((run) => run.job?.id === job.id && run.source === 'recorded').map(recording),
      });
    })
    .get('/machine-jobs/{machineJobId}/order-association', ({ store, params }) => {
      const job = store.jobs.find((item) => item.id === params.machineJobId);
      if (!job) return notFound('Job');
      const { orderId, orderReference } = billingOf(store, job);
      const item = store.orders
        .find((order) => order.id === orderId)
        ?.items.find((line) => line.sourceMachineJobId === job.id);
      return ok({
        orderId: orderId ?? null,
        orderReference: orderReference ?? null,
        orderItemId: item?.id ?? null,
        sourceChanged: false,
      });
    })
    .get('/machine-runs', ({ store, query }) => {
      const assigned = query.get('assigned');
      const machineIds = csv(query, 'machineId');
      const items = store.runs
        .filter(
          (run) =>
            (assigned === null || (assigned === 'true') === Boolean(run.job)) &&
            (!machineIds.length || machineIds.includes(run.machineId)),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(plainRun);
      return ok(paged(items, query));
    })
    .get('/machine-runs/{runId}', ({ store, params }) => {
      const run = store.runs.find((item) => item.id === params.runId);
      return run ? ok(run) : notFound('Run');
    })
    .get('/machine-runs/{runId}/recording', ({ store, params }) => {
      const run = store.runs.find((item) => item.id === params.runId);
      return run ? ok(recording(run)) : notFound('Run');
    })
    .add(
      'POST',
      '/machine-jobs',
      ({ store, body }) => {
        const machine = store.machines.find((item) => item.id === body.machineId);
        const operator = operatorOf(store, body.operatorPersonId);
        const customer = toBillingParty(store, body.customer);
        const input = body.run as Record<string, unknown> | undefined;
        if (!machine) return fail(422, 'invalid_machine', 'Choose a machine.');
        if (!operator) return fail(422, 'invalid_operator', 'Choose who operated the machine.');
        if (!input?.endsAt) return fail(422, 'invalid_run', 'Enter when the run ended.');
        const endedAt = String(input.endsAt);
        const startedAt = String(input.startsAt ?? new Date(Date.parse(endedAt) - 3_600_000).toISOString());
        const run: MachineRunDetail = {
          id: nextId(store),
          displayId: nextReference(store, 'R', 5),
          machineId: machine.id,
          machineName: machine.name,
          source: 'manual',
          state: 'finished',
          job: null,
          connectorName: null,
          fileName: null,
          startedAt,
          endedAt,
          estimatedEndAt: null,
          durationSeconds: 0,
          progressPercent: 100,
          outcome: (input.outcome as MachineRunDetail['outcome']) ?? 'successful',
          outcomeFromMachine: false,
          usages: usagesOf(store, input.usages),
          measures: (input.measures as Record<string, number> | undefined) ?? {},
          usagesFromMachine: false,
          reportedUsage: null,
          reportedUsageItems: [],
          materialChangedDuringRun: false,
          artifact: null,
          consumptionStatus: null,
          hiddenFromSignage: false,
          jobHiddenFromSignage: false,
          version: 1,
          events: [],
        };
        run.durationSeconds = runDuration(run, store);
        store.runs.push(run);
        const job = startJob(
          store,
          {
            machine,
            title: body.title as string | null | undefined,
            notes: body.notes as string | null | undefined,
            customer,
            operator,
            hiddenFromSignage: body.hiddenFromSignage as boolean | undefined,
          },
          [run],
        );
        return created(job);
      },
      'machine_jobs.create',
    )
    .add(
      'PATCH',
      '/machine-jobs/{machineJobId}',
      ({ store, params, body }) => {
        const job = store.jobs.find((item) => item.id === params.machineJobId);
        if (!job) return notFound('Job');
        const machine = store.machines.find((item) => item.id === body.machineId);
        if (machine) job.machine = machine;
        const operator = operatorOf(store, body.operatorPersonId);
        if (operator) job.operator = operator;
        job.customer = toBillingParty(store, body.customer) ?? job.customer;
        if ('title' in body) job.title = (body.title as string | null) ?? null;
        if ('notes' in body) job.notes = (body.notes as string | null) ?? null;
        if (typeof body.hiddenFromSignage === 'boolean') job.hiddenFromSignage = body.hiddenFromSignage;
        job.outcomeOverridden = Boolean(body.outcomeOverride);
        if (body.outcomeOverride) job.outcome = body.outcomeOverride as MachineJob['outcome'];
        job.version += 1;
        job.updatedAt = store.now.toISOString();
        return ok(refreshJob(store, job));
      },
      'machine_jobs.edit',
    )
    .add(
      'POST',
      '/machine-runs/{runId}/job',
      ({ store, params, body }) => {
        const run = store.runs.find((item) => item.id === params.runId);
        if (!run) return notFound('Run');
        if (run.job) return fail(409, 'run_already_assigned', 'This run already belongs to a job.');
        const machine = store.machines.find((item) => item.id === run.machineId);
        const operator = operatorOf(store, body.operatorPersonId);
        if (!machine || !operator) return fail(422, 'invalid_operator', 'Choose who operated the machine.');
        const job = startJob(
          store,
          {
            machine,
            title: (body.title as string | null | undefined) ?? run.fileName,
            notes: body.notes as string | null | undefined,
            customer: toBillingParty(store, body.customer),
            operator,
            hiddenFromSignage: body.hiddenFromSignage as boolean | null | undefined,
          },
          [run],
        );
        return created(job);
      },
      'machine_jobs.create',
    )
    .add(
      'PUT',
      '/machine-runs/{runId}/job',
      ({ store, params, body }) => {
        const run = store.runs.find((item) => item.id === params.runId);
        const job = store.jobs.find((item) => item.id === body.machineJobId);
        if (!run || !job) return notFound('Run or job');
        if (run.job && run.job.id !== job.id)
          return fail(409, 'run_already_assigned', 'This run already belongs to a job.');
        if (body.replaceManualRuns) {
          store.runs
            .filter((item) => item.job?.id === job.id && item.source === 'manual')
            .forEach((item) => (item.state = 'replaced'));
        }
        run.job = { id: job.id, displayId: job.displayId, title: job.title };
        run.version += 1;
        if (typeof body.hiddenFromSignage === 'boolean') job.hiddenFromSignage = body.hiddenFromSignage;
        job.version += 1;
        return ok(refreshJob(store, job));
      },
      'machine_jobs.edit',
    )
    .add(
      'DELETE',
      '/machine-runs/{runId}/job',
      ({ store, params }) => {
        const run = store.runs.find((item) => item.id === params.runId);
        const job = store.jobs.find((item) => item.id === run?.job?.id);
        if (!run || !job) return notFound('Run');
        run.job = null;
        run.version += 1;
        job.version += 1;
        return ok(refreshJob(store, job));
      },
      'machine_jobs.edit',
    );
}
