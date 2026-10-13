import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateMachineJobFromPrintRequest, MachineJob, Print, UpdateMachineJobRequest } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { JobFormModal } from './dialogs/JobFormModal';
import { usageRowFromPrint } from './dialogs/jobFormHelpers';
import { ToastProvider } from './shared/toasts';

vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: ['machine_jobs.create', 'machine_jobs.edit', 'machines.read'] }) }));

const ids = {
  type: '0192f6f8-743e-7c77-a349-cd07c3e8a910', machine: '0192f6f8-743e-7c77-a349-cd07c3e8a911', material: '0192f6f8-743e-7c77-a349-cd07c3e8a912',
  job: '0192f6f8-743e-7c77-a349-cd07c3e8a914', org: '0192f6f8-743e-7c77-a349-cd07c3e8a915', operator: '0192f6f8-743e-7c77-a349-cd07c3e8a916', print: '0192f6f8-743e-7c77-a349-cd07c3e8a917',
  spool: '0192f6f8-743e-7c77-a349-cd07c3e8a918',
};
const machine = {
  id: ids.machine, machineType: { id: ids.type, name: '3D printer', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }, name: 'Bambu H2D #1', status: 'active' as const,
  externalIdentifier: null, automaticCollectionEnabled: true, lastIngestedAt: null, jobCount: 1, runtimeSeconds: 1, failureRate: '0', version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const customer = { kind: 'organization' as const, id: ids.org, displayName: 'TU Berlin', organizationKind: 'institute' as const, pricingGroup: null, pricingGroupAssignmentVersion: 1 };
const operator = { personId: ids.operator, displayName: 'Maria Hoffmann' };

const lookups = [
  http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
  http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [customer] })),
  http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [operator] })),
  http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' })),
];

const printFixture: Print = {
  id: ids.print, displayId: 'PR-2026-000008', machineId: ids.machine, machineName: machine.name, connectorName: 'Bambu LAN', fileName: 'bracket_v2.gcode', state: 'finished',
  startedAt: '2026-09-16T09:00:00Z', endedAt: '2026-09-16T10:00:00Z', estimatedEndAt: null, progressPercent: 100, job: null, version: 1,
  reportedUsage: { quantity: '42.500', quantityBasis: 'actual', materialId: ids.material, materialName: 'PLA Black', spoolId: ids.spool, spoolDisplayId: 'SP-0141' },
};

const editable = {
  id: ids.job, displayId: 'J-2026-000001', title: null, machine, startsAt: '2026-09-15T08:12:34Z', endsAt: '2026-09-15T11:26:10Z', durationSeconds: 11616, source: 'manual', run: 'manual', print: null,
  reviewState: 'confirmed', customer, operator, outcome: 'unknown', status: 'needs_outcome', notes: null, usages: [], pricingStatus: 'complete', version: 5, createdAt: '2026-09-15T11:26:00Z', updatedAt: '2026-09-15T11:26:00Z',
} as MachineJob;

describe('JobFormModal', () => {
  it('creates a job from a print without sending machine or times and keeps the reported material', async () => {
    let body: CreateMachineJobFromPrintRequest | undefined;
    const onSaved = vi.fn();
    server.use(
      ...lookups,
      http.get(`*/api/v1/prints/${ids.print}`, () => HttpResponse.json({ ...printFixture, events: [] })),
      http.post(`*/api/v1/prints/${ids.print}/job`, async ({ request }) => {
        body = await request.json() as CreateMachineJobFromPrintRequest;
        return HttpResponse.json({ ...editable, outcome: 'successful', status: 'successful' }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal
          open mode="create" onClose={() => undefined} printId={ids.print} onSaved={onSaved}
          initialValues={{ title: 'Bracket v2', printFileName: 'bracket_v2.gcode', machineId: ids.machine, startsAt: printFixture.startedAt, endsAt: printFixture.endedAt!, outcome: 'successful', usages: [usageRowFromPrint(printFixture.reportedUsage!)] }}
        />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByDisplayValue('Bambu H2D #1')).toHaveAttribute('readonly');
    expect(within(dialog).getByDisplayValue('Bracket v2')).toBeInTheDocument();
    expect(within(dialog).getByText('SP-0141')).toBeInTheDocument();
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search operators'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      title: 'Bracket v2', customer: { kind: 'organization', id: ids.org }, operatorPersonId: ids.operator, outcome: 'successful',
      usages: [{ ownership: 'makerspace', materialId: ids.material, spoolId: ids.spool, quantity: '42.5', quantityBasis: 'actual' }],
    });
    expect(body).not.toHaveProperty('machineId');
    expect(body).not.toHaveProperty('startsAt');
    expect(body).not.toHaveProperty('endsAt');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('starts an unrecorded outcome empty, requires a choice and keeps the exact times when they are untouched', async () => {
    let body: UpdateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.patch(`*/api/v1/machine-jobs/${ids.job}`, async ({ request }) => {
        body = await request.json() as UpdateMachineJobRequest;
        return HttpResponse.json({ ...editable, outcome: 'partial_failure', status: 'partial_failure', version: 6 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<ToastProvider><JobFormModal open mode="edit" job={editable} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    const outcome = within(dialog).getByLabelText('Outcome');
    expect(outcome).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('Select how the run ended.')).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.selectOptions(outcome, 'partial_failure');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      machineId: ids.machine, startsAt: editable.startsAt, endsAt: editable.endsAt, customer: { kind: 'organization', id: ids.org }, operatorPersonId: ids.operator,
      outcome: 'partial_failure', title: null, notes: null, expectedVersion: 5,
    });
  });

  it('asks for a customer when a legacy review job without one is saved with an outcome', async () => {
    server.use(
      ...lookups,
      http.patch(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json({ code: 'customer_required', message: 'A customer is required to confirm a job awaiting review' }, { status: 422 })),
    );
    const user = userEvent.setup();
    const legacy = { ...editable, reviewState: 'needs_review', customer: null } as MachineJob;
    renderRoute(<ToastProvider><JobFormModal open mode="edit" job={legacy} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Outcome'), 'successful');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('Select a customer.')).toBeInTheDocument();
  });
});
