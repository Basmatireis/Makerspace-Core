import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MachineRunRecording } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { ids, jobFixture, manualRun, recordedRun, usage, workItem as baseWorkItem } from '../../test/machineRuns';
import { RunDetailPage } from './RunDetailPage';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[], personId: '0192f6f8-743e-7c77-a349-cd07c3e8ffff' }));
vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: auth.permissions, person: { id: auth.personId } }),
}));

function renderPage(element: React.ReactElement, path: string, route = '*') {
  const queryClient = testQueryClient();
  const router = createMemoryRouter([{ path: route, element: <ToastProvider>{element}</ToastProvider> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

/** Requests of the attach dialog to the work-items endpoint, so tests can check the server-side filters. */
const workItemRequests: URL[] = [];

function serveRun(run: ReturnType<typeof recordedRun>, jobs: ReturnType<typeof jobFixture>[] = []) {
  workItemRequests.length = 0;
  server.use(
    http.get(`*/api/v1/machine-runs/${run.id}`, () => HttpResponse.json(run)),
    http.get(`*/api/v1/machine-runs/${run.id}/recording`, () => HttpResponse.json(recordingOf(run.id))),
    // The server applies machineId; the fixture mimics that and returns the jobs newest first.
    http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
      const url = new URL(request.url);
      workItemRequests.push(url);
      const machines = url.searchParams.getAll('machineId');
      const items = jobs
        .filter((job) => machines.length === 0 || machines.includes(job.machine.id))
        .map((job) =>
          baseWorkItem({
            id: job.id,
            displayId: job.displayId,
            title: job.title,
            startedAt: job.startedAt!,
            runCount: job.runs.length,
            status: job.status,
          }),
        );
      return HttpResponse.json({ items, page: 1, pageSize: 50, total: items.length });
    }),
    ...jobs.map((job) => http.get(`*/api/v1/machine-jobs/${job.id}`, () => HttpResponse.json(job))),
  );
}

const recordingOf = (runId: string): MachineRunRecording => ({
  runId,
  runDisplayId: 'RN-2026-000007',
  source: 'recorded',
  state: 'finished',
  startedAt: '2026-09-15T08:00:00Z',
  consumptionStatus: null,
  artifact: null,
  previews: [],
  timelapse: null,
  timelapseStatus: null,
  commands: [],
});

const renderRun = (id = ids.recordedRun) =>
  renderPage(<RunDetailPage />, machineLogbookPaths.run(id), '/workshop/jobs/runs/:runId');
const runningRecorded = () =>
  recordedRun({
    state: 'running',
    endedAt: null,
    estimatedEndAt: '2099-01-01T13:30:00Z',
    progressPercent: 45,
    outcome: null,
    outcomeFromMachine: false,
    durationSeconds: 1800,
    reportedUsage: null,
    reportedUsageItems: [],
  });

describe('Run detail page', () => {
  it('shows the machine data, facts, "From machine" labels and a collapsed list of readable events', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(recordedRun());
    renderRun();
    expect(await screen.findByRole('heading', { name: /Gearbox housing v3/ })).toBeInTheDocument();
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('42 g PLA Black');
    expect(screen.getByText('Runtime').nextSibling).toHaveTextContent('1 h 0 min');
    // The machine reported the outcome, so the label says so.
    expect(screen.getByText('Outcome').nextSibling).toHaveTextContent('Successful');
    expect(screen.getByText('Outcome').nextSibling?.nextSibling).toHaveTextContent('From machine');
    expect(screen.getByText('Events from Bambu LAN (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument();
    expect(screen.queryByText(/printer/i)).not.toBeInTheDocument();
  });

  it('claims a run straight into a new job with create permission only', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    serveRun(recordedRun());
    const user = userEvent.setup();
    renderRun();
    await user.click((await screen.findAllByRole('button', { name: 'Claim' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    expect(within(dialog).getByRole('radio', { name: 'New job' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Attach to a job on/ })).toBeDisabled();
  });

  it('attaches a run to an existing job with edit permission only', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(recordedRun(), [jobFixture()]);
    const user = userEvent.setup();
    renderRun();
    await user.click((await screen.findAllByRole('button', { name: 'Claim' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    expect(within(dialog).getByRole('radio', { name: 'New job' })).toBeDisabled();
    expect(await within(dialog).findByRole('button', { name: 'Attach to job' })).toBeInTheDocument();
  });

  it('offers to claim while the run is still running', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate, PermissionId.machine_jobsedit];
    serveRun(runningRecorded());
    renderRun();
    expect(await screen.findByText('Run in progress')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText(/45 % · ends ~/)).toBeInTheDocument();
    expect(screen.getByText('Outcome').nextSibling).toHaveTextContent('Not recorded yet');
    expect(screen.getByText('Material').nextSibling).toHaveTextContent('Pending final report');
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('Pending final report');
    expect(screen.getByText(/Mounted spools describe the printer setup/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Claim' }).length).toBeGreaterThan(0);
  });

  describe('signage visibility', () => {
    const jobRef = { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' };
    const hide = () => screen.findByRole('checkbox', { name: 'Hide this run from signage screens' });

    it('lets staff who edit jobs hide a running run, sending the choice to the API', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      const run = runningRecorded();
      serveRun(run);
      const bodies: unknown[] = [];
      server.use(
        http.put(`*/api/v1/machine-runs/${run.id}/signage-visibility`, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ ...run, hiddenFromSignage: true });
        }),
      );
      renderRun();
      const checkbox = await hide();
      expect(checkbox).not.toBeChecked();
      expect(
        screen.getByText('Machine status and camera are hidden from all displays until this run ends.'),
      ).toBeInTheDocument();
      await userEvent.click(checkbox);
      await waitFor(() => expect(bodies).toEqual([{ hidden: true }]));
      expect(await screen.findByText('Run hidden from signage')).toBeInTheDocument();
    });

    it('shows an error when the run ended meanwhile', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      const run = runningRecorded();
      serveRun(run);
      server.use(
        http.put(`*/api/v1/machine-runs/${run.id}/signage-visibility`, () =>
          HttpResponse.json({ code: 'run_ended', message: 'The run has ended.' }, { status: 409 }),
        ),
      );
      renderRun();
      await userEvent.click(await hide());
      expect(await screen.findByText('The run has already ended.')).toBeInTheDocument();
    });

    it("lets the job's operator hide it without edit permission", async () => {
      auth.permissions = [PermissionId.machine_jobsread];
      auth.personId = ids.operator;
      serveRun({ ...runningRecorded(), hiddenFromSignage: true, job: jobRef }, [jobFixture()]);
      renderRun();
      expect(await hide()).toBeChecked();
      auth.personId = '0192f6f8-743e-7c77-a349-cd07c3e8ffff';
    });

    it('offers nothing to people who are neither editors nor part of the job', async () => {
      auth.permissions = [PermissionId.machine_jobsread];
      serveRun({ ...runningRecorded(), job: jobRef }, [jobFixture()]);
      renderRun();
      expect(await screen.findByText('Machine events')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Hide this run from signage screens' })).not.toBeInTheDocument();
    });

    it('is not offered once the run has ended', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      serveRun(recordedRun());
      renderRun();
      expect(await screen.findByText('Machine events')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Hide this run from signage screens' })).not.toBeInTheDocument();
    });
  });

  it('treats an omitted itemized report from an older response as empty', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun({ ...runningRecorded(), reportedUsageItems: undefined } as unknown as ReturnType<typeof recordedRun>);
    renderRun();
    expect(await screen.findByText('Run in progress')).toBeInTheDocument();
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('Pending final report');
  });

  it('shows a display-only live filament estimate from the parsed artifact', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.print_artifactsread];
    const artifactId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
    serveRun({ ...runningRecorded(), artifact: { id: artifactId, sha256: 'a'.repeat(64), parserStatus: 'complete' } });
    server.use(
      http.get(`*/api/v1/print-artifacts/${artifactId}`, () =>
        HttpResponse.json({
          id: artifactId,
          originalFilename: 'part.3mf',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          parserStatus: 'complete',
          parserVersion: 'bambu-3mf-v1',
          metadata: {},
          primaryPreviewId: null,
          filaments: [
            { filamentKey: '1', filamentType: 'PLA', color: '#ffffff', plannedWeightGrams: '120' },
            { filamentKey: '2', filamentType: 'PETG', color: '#000000', plannedWeightGrams: '80' },
          ],
          createdAt: '2026-09-15T08:00:00Z',
          updatedAt: '2026-09-15T08:00:00Z',
        }),
      ),
    );
    renderRun();

    expect(await screen.findByRole('heading', { name: 'Filament estimate' })).toBeInTheDocument();
    expect(await screen.findByText('~90 g / 200 g planned · based on 45 % print progress')).toBeInTheDocument();
    expect(screen.getByText('PLA · #ffffff (detected in file): 120 g planned')).toBeInTheDocument();
    expect(screen.getByText(/Inventory is updated only after the run ends/)).toBeInTheDocument();
  });

  it('maps an unresolved reported filament to a selected spool as an audited usage correction', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit, PermissionId.inventoryread];
    const whiteSpool = '0192f6f8-743e-7c77-a349-cd07c3e8d610';
    const yellowMaterial = '0192f6f8-743e-7c77-a349-cd07c3e8d611';
    const yellowSpool = '0192f6f8-743e-7c77-a349-cd07c3e8d612';
    const run = recordedRun({
      usages: [usage({ spoolId: whiteSpool, spoolDisplayId: 'S-617', materialName: 'PLA White', quantity: '1.64' })],
      usagesFromMachine: true,
      hiddenFromSignage: false,
      reportedUsage: null,
      reportedUsageItems: [
        {
          lineNumber: 0,
          reportRevision: 1,
          slicerFilamentId: '1',
          extruder: 2,
          plannedQuantityGrams: '0.55',
          estimatedQuantityGrams: '0.55',
          method: 'slicer_complete',
          calculationVersion: 'bambu-3mf-v1',
          quality: 'high',
        },
        {
          lineNumber: 1,
          reportRevision: 1,
          slicerFilamentId: '3',
          extruder: 1,
          inputUnitExternalId: '128',
          slotExternalId: '0',
          plannedQuantityGrams: '1.64',
          estimatedQuantityGrams: '1.64',
          spoolId: whiteSpool,
          method: 'slicer_complete',
          calculationVersion: 'bambu-3mf-v1',
          quality: 'high',
        },
      ],
      version: 7,
    });
    serveRun(run);
    server.use(
      http.get('*/api/v1/filament-spools', () =>
        HttpResponse.json({
          items: [
            {
              id: yellowSpool,
              displayId: 'S-618',
              kind: 'standard',
              label: 'External holder',
              status: 'in_stock',
              fillNumber: 1,
              materialId: yellowMaterial,
              materialName: 'PLA Yellow',
              remainingQuantity: '500',
              unit: 'g',
              mounted: true,
              lifecycle: 'active',
              identifiers: [],
              version: 1,
              createdAt: '2026-09-01T00:00:00Z',
              updatedAt: '2026-09-01T00:00:00Z',
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      ),
    );
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/usages`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ run, job: null });
      }),
    );

    const user = userEvent.setup();
    renderRun();
    await user.click(await screen.findByRole('button', { name: 'Map filament 1 to a spool' }));
    const dialog = await screen.findByRole('dialog', { name: 'Map reported material' });
    expect(within(dialog).getByLabelText('Consumed quantity (g)')).toHaveValue('0.55');
    await user.selectOptions(within(dialog).getByLabelText('Spool used'), yellowSpool);
    await user.click(within(dialog).getByRole('button', { name: 'Map and consume' }));

    await waitFor(() =>
      expect(body).toEqual({
        expectedVersion: 7,
        usages: [
          {
            ownership: 'makerspace',
            materialId: ids.material,
            spoolId: whiteSpool,
            quantity: '1.64',
            quantityBasis: 'actual',
          },
          {
            ownership: 'makerspace',
            materialId: yellowMaterial,
            spoolId: yellowSpool,
            quantity: '0.55',
            quantityBasis: 'estimated',
          },
        ],
      }),
    );
  });

  it('attaches a recorded run to a job on its machine and replaces the manual runs', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const manual = jobFixture({
      runs: [manualRun({ startedAt: '2026-09-15T07:30:00Z', endedAt: '2026-09-15T09:00:00Z', durationSeconds: 5400 })],
    });
    serveRun(recordedRun(), [manual]);
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(manual);
      }),
    );
    const user = userEvent.setup();
    renderRun();

    await user.click((await screen.findAllByRole('button', { name: 'Claim' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    // Candidates come from the server: the jobs of this machine, newest first.
    await waitFor(() => expect(workItemRequests.length).toBeGreaterThan(0));
    const request = workItemRequests[0].searchParams;
    expect(request.getAll('machineId')).toEqual([ids.machine]);
    expect(request.get('sort')).toBe('startedAt');
    expect(request.get('direction')).toBe('desc');
    expect(await within(dialog).findByRole('checkbox', { name: /Replace the job’s manual run/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Attach to job' }));
    await waitFor(() =>
      expect(body).toEqual({ machineJobId: ids.job, replaceManualRuns: true, expectedJobVersion: 3 }),
    );
  });

  it('attaches a running recorded run next to the manual runs when replacing is switched off', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const manual = jobFixture();
    serveRun(runningRecorded(), [manual]);
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(manual);
      }),
    );
    const user = userEvent.setup();
    renderRun();

    await user.click((await screen.findAllByRole('button', { name: 'Claim' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Claim run' });
    await user.click(await within(dialog).findByRole('checkbox', { name: /Replace the job’s manual run/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Attach to job' }));
    await waitFor(() =>
      expect(body).toEqual({ machineJobId: ids.job, replaceManualRuns: false, expectedJobVersion: 3 }),
    );
  });

  it('detaches the last run of a job with the job version and explains the manual copy', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const assigned = recordedRun({
      job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usages: [usage()],
      usagesFromMachine: true,
      hiddenFromSignage: false,
    });
    serveRun(assigned);
    server.use(
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () =>
        HttpResponse.json(jobFixture({ runs: [assigned], version: 8 })),
      ),
    );
    let body: unknown;
    server.use(
      http.delete(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(jobFixture({ version: 9 }));
      }),
    );
    const user = userEvent.setup();
    renderRun();

    expect(await screen.findByRole('link', { name: /J-2026-000001 Gearbox housing/ })).toHaveAttribute(
      'href',
      machineLogbookPaths.job(ids.job),
    );
    expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument();
    // Carbon's icon-only overflow trigger is named by an aria-hidden tooltip that jsdom does not resolve, so find it by class.
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    await user.click(await screen.findByText('Detach from job'));
    const dialog = await screen.findByRole('alertdialog', { name: /Detach this run/ });
    expect(within(dialog).getByText(/gets a manual run with the same start, end and outcome/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Detach' }));

    await waitFor(() => expect(body).toEqual({ expectedJobVersion: 8 }));
    expect(await screen.findByText('Run detached')).toBeInTheDocument();
  });

  it('does not offer detach without job edit permission', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(recordedRun({ job: { id: ids.job, displayId: 'J-2026-000001', title: null } }));
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())));
    renderRun();
    expect(await screen.findByRole('link', { name: 'J-2026-000001' })).toBeInTheDocument();
    expect(document.querySelector('.cds--overflow-menu')).toBeNull();
  });

  it('deletes a recorded run with machine_jobs.delete, asks about consumption and returns to the job', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsdelete];
    const assigned = recordedRun({
      job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usages: [usage({ spoolDisplayId: 'SP-0003' })],
      usagesFromMachine: true,
      hiddenFromSignage: false,
      version: 5,
    });
    serveRun(assigned);
    server.use(
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () =>
        HttpResponse.json(jobFixture({ runs: [manualRun(), assigned] })),
      ),
    );
    let body: unknown;
    server.use(
      http.delete(`*/api/v1/machine-runs/${ids.recordedRun}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRun();
    await screen.findByRole('link', { name: /J-2026-000001 Gearbox housing/ });
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    await user.click(await screen.findByText('Delete run'));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete run' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: /Reverse consumption \(183 g back to SP-0003\)/ }));
    await user.click(confirm);
    await waitFor(() => expect(body).toEqual({ expectedVersion: 5, reverseConsumption: true }));
  });

  it('hides Delete run for a recorded run without machine_jobs.delete', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(recordedRun());
    renderRun();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('img', { name: 'More run actions' }));
    expect(await screen.findByText('Edit material usage')).toBeInTheDocument();
    expect(screen.queryByText('Delete run')).not.toBeInTheDocument();
  });

  it('offers Delete run for a manual run with edit access', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(
      recordedRun({
        id: ids.manualRun,
        source: 'manual',
        job: { id: ids.job, displayId: 'J-2026-000001', title: null },
      }),
    );
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())));
    const user = userEvent.setup();
    renderRun(ids.manualRun);
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    expect(await screen.findByText('Delete run')).toBeInTheDocument();
    expect(screen.queryByText('Detach from job')).not.toBeInTheDocument();
  });
});
