import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AttachMachineRunRequest,
  CreateMachineJobFromRunRequest,
  CreateMachineJobRequest,
  MachineJob,
  UpdateMachineJobRequest,
} from '../../api/generated/models';
import { customer, ids, jobFixture, machine, manualRun, operator, recordedRun, workItem } from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { JobFormModal } from './dialogs/JobFormModal';
import { ClaimRunModal } from './jobs/ClaimRunModal';
import { ToastProvider } from './shared/toasts';

vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({
    permissions: ['machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.read', 'machines.read', 'inventory.read'],
    person: { id: '0192f6f8-743e-7c77-a349-cd07c3e8ffff', firstName: 'Ada', lastName: 'Lovelace' },
  }),
}));

const lookups = [
  http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
  http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [customer] })),
  http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [operator] })),
  http.get('*/api/v1/materials', () =>
    HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' }),
  ),
  http.get(`*/api/v1/machine-runs/${ids.recordedRun}`, () => HttpResponse.json(recordedRun())),
];

const editable: MachineJob = jobFixture({
  title: null,
  runs: [manualRun({ outcome: null })],
  outcome: 'unknown',
  status: 'needs_outcome',
  notes: 'Keep these notes',
  version: 5,
});

const choose = async (user: ReturnType<typeof userEvent.setup>, field: HTMLElement, option: string) => {
  await user.click(field);
  await user.click(await screen.findByRole('option', { name: option }));
};

describe('New job', () => {
  it('starts with no machine and no recipient, keeps Create job disabled until both are set and sends the first run', async () => {
    let body: CreateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        body = (await request.json()) as CreateMachineJobRequest;
        return HttpResponse.json(jobFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="create" onClose={() => undefined} onSaved={() => undefined} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    const create = within(dialog).getByRole('button', { name: 'Create job' });
    expect(create).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'Machine' })).toHaveValue('');
    expect(within(dialog).getByRole('combobox', { name: 'Recipient' })).toHaveValue('');
    expect(within(dialog).getByRole('combobox', { name: 'Operator' })).toHaveValue('Ada Lovelace');
    // The run appears once a machine is chosen.
    expect(within(dialog).queryByText('First run')).not.toBeInTheDocument();
    await choose(user, within(dialog).getByRole('combobox', { name: 'Machine' }), 'Bambu H2D #1 · 3D printer');
    expect(await within(dialog).findByText('First run')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Starts now' })).toBeChecked();
    expect(within(dialog).queryByLabelText('Started at date')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Select material' }));
    expect(await screen.findByRole('dialog', { name: 'Select material' })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Select material' })).getByRole('button', { name: 'Close' }),
    );
    expect(create).toBeDisabled();
    await choose(user, within(dialog).getByRole('combobox', { name: 'Recipient' }), 'TU Berlin (organization)');
    await user.click(within(dialog).getByLabelText(/Keep this job off the signage screens/));
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      machineId: ids.machine,
      customer: { kind: 'organization', id: ids.organization },
      operatorPersonId: '0192f6f8-743e-7c77-a349-cd07c3e8ffff',
      hiddenFromSignage: true,
      run: { outcome: null, usages: [] },
    });
    // A run that starts now has no start: the server takes the time of saving.
    expect(body?.run.startsAt).toBeUndefined();
    expect(new Date(body!.run.endsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('asks for the start and the outcome of a run that is already done', async () => {
    let body: CreateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        body = (await request.json()) as CreateMachineJobRequest;
        return HttpResponse.json(jobFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal
          open
          mode="create"
          initialValues={{ machineId: ids.machine, customer }}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    await user.click(await within(dialog).findByRole('radio', { name: 'Already done' }));
    expect(within(dialog).getByLabelText('Started at date')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Outcome' })).toHaveValue('Successful');
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.run.startsAt).toBeDefined();
    expect(body?.run.outcome).toBe('successful');
    expect(body?.hiddenFromSignage).toBe(false);
  });

  it('moves the start of a run that is already done back so that a longer runtime ends now', async () => {
    let body: CreateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        body = (await request.json()) as CreateMachineJobRequest;
        return HttpResponse.json(jobFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal
          open
          mode="create"
          initialValues={{ machineId: ids.machine, customer }}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    await user.click(await within(dialog).findByRole('radio', { name: 'Already done' }));
    const hours = within(dialog).getByRole('spinbutton', { name: 'Duration (h)' });
    await user.clear(hours);
    await user.type(hours, '5');
    // Started an hour ago and five hours long would end in the future; the run ends now instead.
    expect(within(dialog).getByRole('combobox', { name: 'Outcome' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(body).toBeDefined());
    const startsAt = new Date(body!.run.startsAt!).getTime();
    const endsAt = new Date(body!.run.endsAt).getTime();
    expect(endsAt).toBeLessThanOrEqual(Date.now());
    expect(endsAt).toBeGreaterThan(Date.now() - 120_000);
    // Minute precision of the start field: the runtime stays five hours, give or take that minute.
    expect(Math.abs(endsAt - startsAt - 5 * 3_600_000)).toBeLessThanOrEqual(60_000);
    expect(body?.run.outcome).toBe('successful');
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
        <JobFormModal open mode="create" onClose={() => undefined} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New job' });
    const customerField = within(dialog).getByRole('combobox', { name: 'Recipient' });
    await choose(user, customerField, 'Jonas Weber');
    // Two organizations are ambiguous: no suggestion.
    expect(within(dialog).queryByRole('button', { name: /^Bill to/ })).not.toBeInTheDocument();
    await user.clear(customerField);
    await user.click(await screen.findByRole('option', { name: 'Maria Hoffmann' }));
    expect(customerField).toHaveValue('Maria Hoffmann');
    expect(within(dialog).getByText('Maria Hoffmann belongs to TU Berlin.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Bill to TU Berlin' }));
    expect(customerField).toHaveValue('TU Berlin (organization)');
    expect(within(dialog).queryByRole('button', { name: /^Bill to/ })).not.toBeInTheDocument();
  });
});

describe('Edit job', () => {
  it('edits the facts, the outcome override and the signage flag, keeps the notes and never times or material', async () => {
    let body: UpdateMachineJobRequest | undefined;
    server.use(
      ...lookups,
      http.patch(`*/api/v1/machine-jobs/${ids.job}`, async ({ request }) => {
        body = (await request.json()) as UpdateMachineJobRequest;
        return HttpResponse.json({ ...editable, version: 6 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <JobFormModal open mode="edit" job={editable} onClose={() => undefined} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit job' });
    expect(within(dialog).queryByText('First run')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Notes')).not.toBeInTheDocument();
    const override = within(dialog).getByRole('combobox', { name: 'Outcome override' });
    expect(override).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      machineId: ids.machine,
      customer: { kind: 'organization', id: ids.organization },
      operatorPersonId: ids.operator,
      outcomeOverride: null,
      title: null,
      notes: 'Keep these notes',
      hiddenFromSignage: false,
      expectedVersion: 5,
    });

    body = undefined;
    await choose(user, override, 'Partial failure');
    await user.click(within(dialog).getByLabelText(/Keep this job off the signage screens/));
    await user.click(within(dialog).getByRole('button', { name: 'Save job' }));
    await waitFor(() =>
      expect(body).toMatchObject({ outcomeOverride: 'partial_failure', hiddenFromSignage: true, expectedVersion: 5 }),
    );
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
    const dialog = await screen.findByRole('dialog', { name: 'Edit job' });
    expect(within(dialog).getByRole('combobox', { name: 'Outcome override' })).toHaveValue('Failed');
    expect(within(dialog).getByText('Set by staff; the outcomes of the runs are ignored.')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Machine' })).toBeDisabled();
    expect(within(dialog).getByText('The machine cannot change while the job has a recorded run.')).toBeInTheDocument();
  });
});

describe('Claim run', () => {
  it('creates a job from a recorded run with recipient, operator, title and the signage opt-out', async () => {
    let body: CreateMachineJobFromRunRequest | undefined;
    server.use(
      ...lookups,
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 50, total: 0 }),
      ),
      http.post(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = (await request.json()) as CreateMachineJobFromRunRequest;
        return HttpResponse.json(jobFixture({ title: 'Gearbox housing v3' }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <ClaimRunModal runId={ids.recordedRun} onClose={() => undefined} canCreate canAttach />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    // Without a job on the machine only a new job is possible.
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'New job' })).toBeChecked());
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Gearbox housing v3');
    expect(within(dialog).getByRole('combobox', { name: 'Operator' })).toHaveValue('Ada Lovelace');
    const create = within(dialog).getByRole('button', { name: 'Create job' });
    expect(create).toBeDisabled();
    await choose(user, within(dialog).getByRole('combobox', { name: 'Recipient' }), 'TU Berlin (organization)');
    await user.click(within(dialog).getByLabelText(/Keep off the signage screens/));
    await user.click(create);
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      title: 'Gearbox housing v3',
      customer: { kind: 'organization', id: ids.organization },
      operatorPersonId: '0192f6f8-743e-7c77-a349-cd07c3e8ffff',
      hiddenFromSignage: true,
    });
  });

  it('attaches the run to an open job on its machine, replacing its manual run, and keeps the job flag', async () => {
    let body: AttachMachineRunRequest | undefined;
    server.use(
      ...lookups,
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [workItem({ status: 'running' })], page: 1, pageSize: 50, total: 1 }),
      ),
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())),
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = (await request.json()) as AttachMachineRunRequest;
        return HttpResponse.json(recordedRun());
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ToastProvider>
        <ClaimRunModal runId={ids.recordedRun} onClose={() => undefined} canCreate canAttach />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    await waitFor(() =>
      expect(within(dialog).getByRole('radio', { name: `Attach to a job on ${machine.name}` })).toBeChecked(),
    );
    expect(await within(dialog).findByLabelText(/Replace the job’s manual run/)).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Attach to job' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ machineJobId: ids.job, replaceManualRuns: true, expectedJobVersion: 3 });
  });
});
