import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeletedMachineJob, DeletedMachineRun, RecycleBin } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { ids, workItem } from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const as = (...permissions: PermissionId[]) =>
  http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)));

const job: DeletedMachineJob = {
  id: ids.job,
  displayId: 'J-2026-000007',
  title: 'Gearbox housing',
  machineId: ids.machine,
  machineName: 'Prusa CORE One',
  deletedAt: '2026-10-30T09:15:00Z',
  deletedByName: 'Ada Lovelace',
  deletedRunCount: 3,
  detachedRunCount: 1,
  hasInventoryBookings: false,
  version: 4,
};
const run: DeletedMachineRun = {
  id: ids.recordedRun,
  displayId: 'RN-2026-000012',
  fileName: 'bracket_v2.gcode',
  source: 'recorded',
  machineId: ids.machine,
  machineName: 'Prusa CORE One',
  deletedAt: '2026-10-30T10:00:00Z',
  deletedByName: null,
  formerJobId: ids.job,
  formerJobDisplayId: 'J-2026-000007',
  formerJobInBin: true,
  hasInventoryBookings: false,
  version: 2,
};
const bin = (contents: Partial<RecycleBin> = {}) =>
  http.get('*/api/v1/machine-logbook/recycle-bin', () => HttpResponse.json({ jobs: [job], runs: [run], ...contents }));

const deleter = [PermissionId.machine_jobsread, PermissionId.machine_jobsdelete];

describe('Recycle bin page', () => {
  it('lists deleted jobs and runs with who deleted them and the run counts', async () => {
    server.use(as(...deleter), bin());
    renderRoute(<App />, '/workshop/recycle-bin');
    const jobs = await screen.findByRole('table', { name: 'Deleted jobs' }, { timeout: 5000 });
    expect(within(jobs).getByText('J-2026-000007')).toBeInTheDocument();
    expect(within(jobs).getByText('Gearbox housing')).toBeInTheDocument();
    expect(within(jobs).getByText('by Ada Lovelace')).toBeInTheDocument();
    expect(within(jobs).getByText('3')).toBeInTheDocument();
    const runs = screen.getByRole('table', { name: 'Deleted runs' });
    expect(within(runs).getByText('bracket_v2.gcode')).toBeInTheDocument();
    expect(within(runs).getByText('Recorded')).toBeInTheDocument();
    expect(within(runs).getByText('J-2026-000007 (in the bin)')).toBeInTheDocument();
  });

  it('shows an empty state when the bin is empty', async () => {
    server.use(as(...deleter), bin({ jobs: [], runs: [] }));
    renderRoute(<App />, '/workshop/recycle-bin');
    expect(await screen.findByText('The recycle bin is empty', undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('restores a job after a plain confirmation that says what comes back', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      as(...deleter),
      bin(),
      http.post(`*/api/v1/machine-logbook/recycle-bin/jobs/${ids.job}/restore`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(workItem());
      }),
    );
    renderRoute(<App />, '/workshop/recycle-bin');
    await user.click(await screen.findByRole('button', { name: 'Restore J-2026-000007' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore J-2026-000007?' });
    expect(within(dialog).getByText(/The 3 runs deleted with it come back too/)).toBeInTheDocument();
    expect(within(dialog).queryByText('This cannot be undone.')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
  });

  it('explains that a run whose job is in the bin comes back unassigned', async () => {
    const user = userEvent.setup();
    server.use(as(...deleter), bin());
    renderRoute(<App />, '/workshop/recycle-bin');
    await user.click(await screen.findByRole('button', { name: 'Restore RN-2026-000012' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore RN-2026-000012?' });
    expect(
      within(dialog).getByText('The job is in the bin too, so the run comes back as an unassigned run.'),
    ).toBeInTheDocument();
  });

  it('deletes a job for good only after the confirmation', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      as(...deleter),
      bin(),
      http.delete(`*/api/v1/machine-logbook/recycle-bin/jobs/${ids.job}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/workshop/recycle-bin');
    await user.click(await screen.findByRole('button', { name: 'Delete J-2026-000007 for good' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('The 3 runs that went into the bin with it are deleted too.')).toBeInTheDocument();
    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
  });

  it('keeps a job with inventory bookings: restore stays, delete for good is not offered', async () => {
    server.use(as(...deleter), bin({ jobs: [{ ...job, hasInventoryBookings: true }] }));
    renderRoute(<App />, '/workshop/recycle-bin');
    expect(await screen.findByRole('button', { name: 'Restore J-2026-000007' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Kept: its material is booked in the inventory ledger')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete J-2026-000007 for good' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete RN-2026-000012 for good' })).toBeInTheDocument();
  });

  it('shows the message of the API when deleting for good is refused', async () => {
    const user = userEvent.setup();
    const message =
      'Material bookings in the inventory ledger refer to it, so it can stay in the recycle bin but cannot be deleted for good';
    server.use(
      as(...deleter),
      bin(),
      http.delete(`*/api/v1/machine-logbook/recycle-bin/jobs/${ids.job}`, () =>
        HttpResponse.json({ code: 'inventory_bookings_exist', message }, { status: 409 }),
      ),
    );
    renderRoute(<App />, '/workshop/recycle-bin');
    await user.click(await screen.findByRole('button', { name: 'Delete J-2026-000007 for good' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
  });

  it('is hidden without machine_jobs.delete', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 }),
      ),
    );
    renderRoute(<App />, '/workshop/jobs');
    await screen.findByRole('heading', { name: 'Jobs' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Recycle bin' })).not.toBeInTheDocument();
  });

  it('offers the link on the Jobs page to people who may delete', async () => {
    server.use(
      as(...deleter),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 }),
      ),
    );
    renderRoute(<App />, '/workshop/jobs');
    expect(await screen.findByRole('link', { name: 'Recycle bin' }, { timeout: 5000 })).toHaveAttribute(
      'href',
      '/workshop/recycle-bin',
    );
  });

  it('does not render the page for people without the permission', async () => {
    let requested = false;
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/recycle-bin', () => {
        requested = true;
        return HttpResponse.json({ jobs: [], runs: [] });
      }),
    );
    renderRoute(<App />, '/workshop/recycle-bin');
    await waitFor(() => expect(screen.queryByText('Recycle bin')).not.toBeInTheDocument(), { timeout: 5000 });
    expect(requested).toBe(false);
  });
});
