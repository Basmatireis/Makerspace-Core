import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  MachineRunConsumptionReason,
  PermissionId,
  type MachineRunCommand,
  type MachineRunRecording,
  type RunRecordingSettings,
} from '../../../api/generated/models';
import { ids, jobFixture, recordedRun } from '../../../test/machineRuns';
import { testQueryClient } from '../../../test/render';
import { server } from '../../../test/server';
import { MachinesPage } from '../MachinesPage';
import { JobDetailPage } from '../JobDetailPage';
import { RunDetailPage } from '../RunDetailPage';
import { machineLogbookPaths } from '../shared/paths';
import { ToastProvider } from '../shared/toasts';
import { ConsumptionHint } from './ConsumptionNotice';
import { PrintPreview } from './PrintPreview';
import {
  commandErrorMessage,
  consumptionNotice,
  consumptionReasonMessage,
  previewLabel,
  timelapseMessage,
} from './recordingText';
import { plateImages } from './thumbnails';
import { ApiError } from '../../../api/http-client';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: auth.permissions, person: { id: '0192f6f8-743e-7c77-a349-cd07c3e8ffff' } }),
}));

const runId = ids.recordedRun;
const artifact = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d001',
  originalFilename: 'housing.3mf',
  sizeBytes: 1024,
  sha256: 'abc',
  parserStatus: 'complete' as const,
};
const previewId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';

const recording = (overrides: Partial<MachineRunRecording> = {}): MachineRunRecording => ({
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
  ...overrides,
});
const command = (overrides: Partial<MachineRunCommand> = {}): MachineRunCommand => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d003',
  runId,
  kind: 'refetch_artifact',
  state: 'requested',
  reasonCode: null,
  requestedAt: '2026-09-15T09:10:00Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

function renderWith(path: string, route: string, element: React.ReactElement) {
  const router = createMemoryRouter(
    [
      {
        path: route,
        element: <ToastProvider>{element}</ToastProvider>,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function serveRun(rec: MachineRunRecording, run = recordedRun()) {
  server.use(
    http.get(`*/api/v1/machine-runs/${runId}`, () => HttpResponse.json(run)),
    http.get(`*/api/v1/machine-runs/${runId}/recording`, () => HttpResponse.json(rec)),
  );
}
const renderRun = () =>
  renderWith(machineLogbookPaths.run(runId), '/machine-logbook/jobs/runs/:runId', <RunDetailPage />);
const missing = (reason: MachineRunConsumptionReason | null, detail: string | null = null) => ({
  state: 'missing' as const,
  reason,
  detail,
});

describe('recording texts', () => {
  it('explains every consumption reason code with its own sentence', () => {
    const messages = Object.values(MachineRunConsumptionReason).map((reason) => consumptionReasonMessage(reason));
    expect(messages).toHaveLength(16);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).not.toBe('The reason is not known.');
    expect(consumptionReasonMessage('from_a_newer_backend')).toBe('The reason is not known.');
    expect(consumptionReasonMessage(null)).toBe('The reason is not known.');
  });

  it('only builds a notice for missing, partial and pending consumption', () => {
    expect(consumptionNotice(null)).toBeNull();
    expect(consumptionNotice({ state: 'recorded', reason: null, detail: null })).toBeNull();
    expect(consumptionNotice(missing('no_spool_mapping', 'x'))).toMatchObject({ kind: 'warning', detail: 'x' });
    expect(consumptionNotice({ state: 'pending', reason: 'run_in_progress', detail: null })?.kind).toBe('info');
  });

  it('explains a print from the printer’s internal storage as a warning, also while it runs', () => {
    const notice = consumptionNotice({
      state: 'pending',
      reason: 'artifact_on_internal_storage',
      detail: '/data/Metadata/plate_1.gcode',
    });
    expect(notice).toMatchObject({
      kind: 'warning',
      title: 'Print file on the printer’s internal storage',
      detail: '/data/Metadata/plate_1.gcode',
    });
    expect(notice?.message).toMatch(/Start prints from a USB stick/);
  });

  it('offers the internal-storage reason in the run list toggletip', async () => {
    const user = userEvent.setup();
    render(
      <ConsumptionHint
        status={{ state: 'pending', reason: 'artifact_on_internal_storage', detail: '/data/Metadata/plate_1.gcode' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Print file on the printer’s internal storage: why\?/ }));
    expect(await screen.findByText(/Start prints from a USB stick/)).toBeInTheDocument();
  });

  it('labels previews and timelapse states', () => {
    expect(previewLabel({ role: 'plate', plateNumber: 2 })).toBe('Plate 2');
    expect(previewLabel({ role: 'model', plateNumber: null })).toBe('Model');
    expect(timelapseMessage({ state: 'available', reason: null, detail: null })).toBeNull();
    expect(timelapseMessage({ state: 'skipped', reason: 'timelapse_disabled', detail: null })?.message).toMatch(
      /switched off/,
    );
    expect(timelapseMessage({ state: 'failed', reason: 'timelapse_too_large', detail: null })?.message).toMatch(
      /larger than/,
    );
    expect(timelapseMessage({ state: 'not_found', reason: 'timelapse_ambiguous', detail: null })?.title).toBe(
      'No timelapse found',
    );
    expect(timelapseMessage(null)?.title).toBe('No timelapse');
  });

  it('names the rate limit of connector commands', () => {
    const limited = new ApiError(429, { code: 'run_command_rate_limited', message: 'x' });
    expect(commandErrorMessage(limited)).toMatch(/five commands/);
    expect(commandErrorMessage(new Error('boom'))).toMatch(/could not be sent/);
  });
});

/** Carbon icon buttons are named by their tooltip, which jsdom does not resolve; find the button it labels. */
const chevron = (label: string) =>
  document.querySelector<HTMLElement>(`[aria-labelledby="${screen.getByText(label).closest('[id]')?.id}"]`)!;

describe('PrintPreview', () => {
  const thumbs = ['Plate 1', 'Plate 2', 'Plate 3'].map((label, i) => ({
    id: `p${i}`,
    src: `/img/${i}.png`,
    label,
    fileName: 'housing.3mf',
    runDisplayId: i === 2 ? 'RN-2' : 'RN-1',
    downloadHref: `/dl/${i}`,
  }));

  it('steps with the chevrons, the strip and the arrow keys and labels the contributing run', async () => {
    const user = userEvent.setup();
    render(<PrintPreview thumbnails={thumbs} emptyText="none" />);
    expect(screen.getByAltText('Plate 1 preview of housing.3mf')).toBeInTheDocument();
    await user.click(chevron('Next preview'));
    expect(screen.getByAltText('Plate 2 preview of housing.3mf')).toBeInTheDocument();
    await user.click(chevron('Previous preview'));
    await user.click(chevron('Previous preview'));
    expect(screen.getByAltText('Plate 3 preview of housing.3mf')).toBeInTheDocument();
    expect(screen.getAllByText('RN-2').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Download housing.3mf/ })).toHaveAttribute('href', '/dl/2');
    chevron('Previous preview').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByAltText('Plate 1 preview of housing.3mf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Plate 2 (RN-1)' }));
    expect(screen.getByAltText('Plate 2 preview of housing.3mf')).toBeInTheDocument();
  });

  it('shows the empty state without navigation', () => {
    render(<PrintPreview thumbnails={[]} emptyText="No file." />);
    expect(screen.getByText('No file.')).toBeInTheDocument();
    expect(screen.queryByText('Next preview')).not.toBeInTheDocument();
  });

  it('hides the chevrons for a single image', () => {
    render(<PrintPreview thumbnails={[thumbs[0]]} emptyText="none" />);
    expect(screen.queryByText('Next preview')).not.toBeInTheDocument();
  });
});

describe('Run detail recording', () => {
  it('renders the plate previews and offers the 3MF download', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(
      recording({
        artifact,
        previews: [
          {
            id: previewId,
            role: 'plate',
            plateNumber: 1,
            width: 512,
            height: 512,
            mimeType: 'image/png',
            primary: true,
          },
        ],
      }),
    );
    renderRun();
    const image = await screen.findByAltText('Plate 1 preview of housing.3mf');
    expect(image).toHaveAttribute('src', `/api/v1/machine-runs/${runId}/previews/${previewId}/content`);
    expect(screen.getByRole('link', { name: /Download housing.3mf/ })).toHaveAttribute(
      'href',
      `/api/v1/machine-runs/${runId}/artifact/content`,
    );
  });

  it('plays an available timelapse inline without preloading and offers its download', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(
      recording({
        timelapse: {
          sizeBytes: 5 * 1024 * 1024,
          contentType: 'video/mp4',
          createdAt: '2026-09-15T09:05:00Z',
          expiresAt: null,
        },
        timelapseStatus: { state: 'available', reason: null, detail: null },
      }),
    );
    const { container } = renderRun();
    expect(await screen.findByRole('link', { name: /Download timelapse/ })).toHaveAttribute(
      'href',
      `/api/v1/machine-runs/${runId}/timelapse/content`,
    );
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', `/api/v1/machine-runs/${runId}/timelapse/content`);
  });

  it('explains why a timelapse is missing', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(recording({ timelapseStatus: { state: 'skipped', reason: 'timelapse_disabled', detail: null } }));
    const { container } = renderRun();
    expect(await screen.findByText('Timelapse skipped')).toBeInTheDocument();
    expect(screen.getByText('Timelapse collection is switched off.')).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });

  it('explains missing consumption and offers both commands to people who may edit', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const status = missing('artifact_not_found_on_printer', 'artifact_not_available');
    serveRun(recording({ artifact, consumptionStatus: status }), { ...recordedRun(), consumptionStatus: status });
    const posts: string[] = [];
    server.use(
      http.post(`*/api/v1/machine-runs/${runId}/artifact-refetch`, () => {
        posts.push('refetch');
        return HttpResponse.json(command(), { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderRun();
    expect(await screen.findByText('Material not recorded')).toBeInTheDocument();
    expect(screen.getByText(/The printer no longer had the print file/)).toBeInTheDocument();
    expect(screen.getByText(/artifact_not_available/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Recalculate consumption' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Fetch print file again' }));
    await waitFor(() => expect(posts).toEqual(['refetch']));
  });

  it('says why a running internal-storage print has no 3MF, preview or estimate', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.print_artifactsread];
    const status = {
      state: 'pending' as const,
      reason: 'artifact_on_internal_storage' as const,
      detail: '/data/Metadata/plate_1.gcode',
    };
    serveRun(recording({ state: 'running', consumptionStatus: status }), {
      ...recordedRun({ state: 'running', endedAt: null, estimatedEndAt: '2099-01-01T13:30:00Z', outcome: null }),
      consumptionStatus: status,
    });
    renderRun();
    expect(await screen.findByText('Print file on the printer’s internal storage')).toBeInTheDocument();
    // The consumption notice, the Filament estimate section and the preview tile.
    await waitFor(() => expect(screen.getAllByText(/started from the printer’s internal storage/)).toHaveLength(3));
    expect(screen.queryByText(/Waiting for the printer’s 3MF file/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Core has no print file for this run/)).not.toBeInTheDocument();
  });

  it('hides the commands without machine_jobs.edit but still explains the reason', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    const status = missing('no_spool_mapping');
    serveRun(recording({ artifact, consumptionStatus: status }), { ...recordedRun(), consumptionStatus: status });
    renderRun();
    expect(await screen.findByText(/could not be mapped to a spool/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fetch print file again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recalculate consumption' })).not.toBeInTheDocument();
  });

  it('shows the state of a running command and disables a second request', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const status = missing('artifact_retrieval_failed');
    serveRun(recording({ artifact, consumptionStatus: status, commands: [command({ state: 'running' })] }), {
      ...recordedRun(),
      consumptionStatus: status,
    });
    renderRun();
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Fetching the print file again')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch print file again' })).toBeDisabled();
  });

  it('reports a failed command with its reason code', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const status = missing('consumption_not_reported');
    serveRun(
      recording({
        artifact,
        consumptionStatus: status,
        commands: [command({ kind: 'recompute_consumption', state: 'failed', reasonCode: 'artifact_rejected' })],
      }),
      { ...recordedRun(), consumptionStatus: status },
    );
    renderRun();
    expect(await screen.findByText('Failed (artifact rejected)')).toBeInTheDocument();
  });

  it('answers the command rate limit with a clear message', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const status = missing('consumption_not_reported');
    serveRun(recording({ artifact, consumptionStatus: status }), { ...recordedRun(), consumptionStatus: status });
    server.use(
      http.post(`*/api/v1/machine-runs/${runId}/consumption-recompute`, () =>
        HttpResponse.json(
          { code: 'run_command_rate_limited', message: 'Too many commands.' },
          { status: 429, headers: { 'Retry-After': '600' } },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRun();
    await user.click(await screen.findByRole('button', { name: 'Recalculate consumption' }));
    expect(await screen.findByText(/At most five commands are accepted per run and hour/)).toBeInTheDocument();
  });

  it('does not offer commands while the run is still running', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const status = { state: 'pending' as const, reason: 'run_in_progress' as const, detail: null };
    serveRun(recording({ state: 'running', consumptionStatus: status }), {
      ...recordedRun({ state: 'running', endedAt: null, estimatedEndAt: '2099-01-01T13:30:00Z', outcome: null }),
      consumptionStatus: status,
    });
    renderRun();
    expect(await screen.findByText('Material pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fetch print file again' })).not.toBeInTheDocument();
  });
});

describe('Recording settings', () => {
  const settings: RunRecordingSettings = {
    timelapseEnabled: true,
    timelapseRetentionDays: 30,
    timelapseMaxBytes: 200 * 1024 * 1024,
    version: 4,
    updatedAt: '2026-09-15T09:00:00Z',
  };
  const renderSettings = () =>
    renderWith('/machine-logbook/machines?tab=recording', '/machine-logbook/machines', <MachinesPage />);
  const serve = () =>
    server.use(
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/machine-logbook/recording-settings', () => HttpResponse.json(settings)),
    );

  it('saves the toggle and the retention with the version it loaded', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesmanage];
    serve();
    let body: unknown;
    server.use(
      http.put('*/api/v1/machine-logbook/recording-settings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...settings, timelapseEnabled: false, timelapseRetentionDays: 0, version: 5 });
      }),
    );
    const user = userEvent.setup();
    renderSettings();
    const days = await screen.findByLabelText('Keep timelapses for (days)');
    expect(days).toHaveValue(30);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: /Collect timelapses/ }));
    await user.clear(days);
    await user.type(days, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ timelapseEnabled: false, timelapseRetentionDays: 0, expectedVersion: 4 }),
    );
  });

  it('does not offer the Recording tab without machines.manage', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesread];
    serve();
    renderSettings();
    expect(await screen.findByRole('tab', { name: 'Machine types' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Recording' })).not.toBeInTheDocument();
  });
});

describe('Job detail recordings', () => {
  it('shows the previews of its runs labelled with the run, the file of each run and the timelapse', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    const run = recordedRun({ job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' } });
    const second = { ...recording({ artifact, runDisplayId: 'RN-2026-000008', runId: ids.manualRun }) };
    const plate = (id: string) => ({
      id,
      role: 'plate' as const,
      plateNumber: 1,
      width: 512,
      height: 512,
      mimeType: 'image/png' as const,
      primary: true,
    });
    server.use(
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture({ runs: [run] }))),
      http.get(`*/api/v1/machine-jobs/${ids.job}/recordings`, () =>
        HttpResponse.json({
          items: [
            recording({
              artifact,
              previews: [plate(previewId)],
              timelapse: {
                sizeBytes: 2048,
                contentType: 'video/mp4',
                createdAt: '2026-09-15T09:05:00Z',
                expiresAt: null,
              },
            }),
            { ...second, previews: [plate('0192f6f8-743e-7c77-a349-cd07c3e8d004')] },
          ],
        }),
      ),
    );
    renderWith(machineLogbookPaths.job(ids.job), '/machine-logbook/jobs/:jobId', <JobDetailPage />);
    expect(await screen.findByText('2 images')).toBeInTheDocument();
    expect(screen.getByAltText('Plate 1 preview of housing.3mf')).toHaveAttribute(
      'src',
      `/api/v1/machine-runs/${runId}/previews/${previewId}/content`,
    );
    expect(screen.getAllByText('RN-2026-000007').length).toBeGreaterThan(0);
    // The download offers the print file of the shown preview; there is no separate file list.
    expect(screen.getByRole('link', { name: /Download housing.3mf/ })).toHaveAttribute(
      'href',
      `/api/v1/machine-runs/${runId}/artifact/content`,
    );
    expect(screen.queryByText('Print files')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Plate 1 (RN-2026-000008)' }));
    expect(screen.getByRole('link', { name: /Download housing.3mf/ })).toHaveAttribute(
      'href',
      `/api/v1/machine-runs/${ids.manualRun}/artifact/content`,
    );
    expect(screen.getByRole('link', { name: /Download timelapse/ })).toHaveAttribute(
      'href',
      `/api/v1/machine-runs/${runId}/timelapse/content`,
    );
  });
});

describe('plate images', () => {
  const preview = (id: string, role: 'plate' | 'model' | 'other', plateNumber: number | null, size: number) => ({
    id,
    role,
    plateNumber,
    width: size,
    height: size,
    mimeType: 'image/png' as const,
    primary: false,
  });

  it('keeps the largest plate render per plate and drops helper images', () => {
    const previews = [
      preview('plate-1', 'plate', 1, 512),
      preview('plate-1-small', 'plate', 1, 128),
      preview('plate-1-no-light', 'plate', null, 512),
      preview('pick-1', 'other', 1, 512),
      preview('plate-2-small', 'plate', 2, 128),
      preview('plate-2', 'plate', 2, 512),
    ];
    expect(plateImages(previews).map((p) => p.id)).toEqual(['plate-1', 'plate-2']);
  });

  it('keeps other images when a file has no plate render', () => {
    expect(plateImages([preview('model', 'model', null, 256)]).map((p) => p.id)).toEqual(['model']);
  });
});
