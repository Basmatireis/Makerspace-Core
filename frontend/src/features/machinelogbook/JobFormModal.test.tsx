import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateMachineJobFromRunRequest, MachineJob, UpdateMachineJobRequest } from '../../api/generated/models';
import { customer, ids, jobFixture, machine, manualRun, operator, recordedRun } from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { JobFormModal } from './dialogs/JobFormModal';
import { ToastProvider } from './shared/toasts';

vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: ['machine_jobs.create', 'machine_jobs.edit', 'machines.read'] }),
}));

const lookups = [
  http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
  http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [customer] })),
  http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [operator] })),
  http.get('*/api/v1/materials', () =>
    HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' }),
  ),
];

const editable: MachineJob = jobFixture({
  title: null,
  runs: [manualRun({ outcome: null })],
  outcome: 'unknown',
  status: 'needs_outcome',
  notes: null,
  version: 5,
});

describe('JobFormModal', () => {
  it('creates a job from a recorded run without sending machine, times or material', async () => {
    let body: CreateMachineJobFromRunRequest | undefined;
    const onSaved = vi.fn();
    server.use(
      ...lookups,
      http.post(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = (await request.json()) as CreateMachineJobFromRunRequest;
        return HttpResponse.json(jobFixture({ title: 'Gearbox housing v3' }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="create" onClose={() => undefined} run={recordedRun()} onSaved={onSaved} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    // The machine and the run's times come from the machine; the name starts as the readable file name.
    expect(within(dialog).getByDisplayValue('Bambu H2D #1')).toHaveAttribute('readonly');
    expect(within(dialog).getByDisplayValue('Gearbox housing v3')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('RN-2026-000007 · gearbox_housing_v3.gcode')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Hours')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Material usage')).not.toBeInTheDocument();
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search operators'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      title: 'Gearbox housing v3',
      customer: { kind: 'organization', id: ids.organization },
      operatorPersonId: ids.operator,
      notes: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('suggests the single organization of the chosen person and switches only on request', async () => {
    const person = {
      kind: 'person' as const,
      id: ids.operator,
      displayName: 'Maria Hoffmann',
      pricingGroupAssignmentVersion: 0,
      memberOrganizations: [{ id: ids.organization, name: 'TU Berlin' }],
    };
    const twoOrganizations = {
      ...person,
      id: ids.job,
      displayName: 'Jonas Weber',
      memberOrganizations: [
        { id: ids.organization, name: 'TU Berlin' },
        { id: ids.otherJob, name: 'HU Berlin' },
      ],
    };
    server.use(
      http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [person, twoOrganizations] })),
      ...lookups,
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="create" onClose={() => undefined} run={recordedRun()} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    const customerField = within(dialog).getByPlaceholderText('Search people or organizations');
    await user.click(customerField);
    await user.click(await screen.findByText('Jonas Weber'));
    // Two organizations are ambiguous: no suggestion.
    expect(within(dialog).queryByRole('button', { name: /^Bill to/ })).not.toBeInTheDocument();
    await user.clear(customerField);
    await user.click(await screen.findByText('Maria Hoffmann'));
    expect(customerField).toHaveValue('Maria Hoffmann');
    expect(within(dialog).getByText('Maria Hoffmann belongs to TU Berlin.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Bill to TU Berlin' }));
    expect(customerField).toHaveValue('TU Berlin');
    expect(within(dialog).queryByRole('button', { name: /^Bill to/ })).not.toBeInTheDocument();
  });

  it('edits the job facts and an outcome override, never times or material, and keeps an empty override as null', async () => {
    let body: UpdateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.patch(`*/api/v1/machine-jobs/${ids.job}`, async ({ request }) => {
        body = (await request.json()) as UpdateMachineJobRequest;
        return HttpResponse.json({
          ...editable,
          outcome: 'partial_failure',
          outcomeOverridden: true,
          status: 'partial_failure',
          version: 6,
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="edit" job={editable} onClose={() => undefined} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Hours')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Material usage')).not.toBeInTheDocument();
    const override = within(dialog).getByLabelText('Outcome override');
    expect(override).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      machineId: ids.machine,
      customer: { kind: 'organization', id: ids.organization },
      operatorPersonId: ids.operator,
      outcomeOverride: null,
      title: null,
      notes: null,
      expectedVersion: 5,
    });

    body = undefined;
    await user.selectOptions(override, 'partial_failure');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toMatchObject({ outcomeOverride: 'partial_failure', expectedVersion: 5 }));
  });

  it('starts from the override a job already has and locks the machine while a recorded run belongs to it', async () => {
    const overridden = jobFixture({
      runs: [manualRun(), recordedRun({ job: { id: ids.job, displayId: 'J-2026-000001', title: null } })],
      outcome: 'failed',
      outcomeOverridden: true,
    });
    server.use(...lookups);
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="edit" job={overridden} onClose={() => undefined} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Outcome override')).toHaveValue('failed');
    expect(within(dialog).getByText('Set by staff; the outcomes of the runs are ignored.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Machine')).toBeDisabled();
    expect(within(dialog).getByText('The machine cannot change while the job has a recorded run.')).toBeInTheDocument();
  });
});
