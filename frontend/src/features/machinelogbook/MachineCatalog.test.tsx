import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type Machine, type PrintSubmission, type PrinterProfile } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const typeId = '0192f6f8-743e-7c77-a349-cd07c3e8a910';
const submissionId = '0192f6f8-743e-7c77-a349-cd07c3e8a912';
const attemptId = '0192f6f8-743e-7c77-a349-cd07c3e8a913';
const now = '2026-09-15T11:26:00Z';
const machine: Machine = { id: machineId, name: 'Laser cutter', machineType: { id: typeId, name: 'Laser', active: true, version: 3, createdAt: now, updatedAt: now }, status: 'active', automaticCollectionEnabled: false, jobCount: 3, runtimeSeconds: 600, failureRate: '0', version: 7, createdAt: now, updatedAt: now };
const profile: PrinterProfile = { machineId, machineName: machine.name, enabled: true, version: 4, createdAt: now, updatedAt: now, inputUnits: [{ id: 'unit-1', machineId, name: 'Direct feed', enabled: true, position: 0, version: 1 }], slots: [{ id: 'slot-1', machineId, inputUnitId: 'unit-1', inputUnitName: 'Direct feed', name: 'Feed slot', position: 0, status: 'available', version: 1 }] };
const submission: PrintSubmission = { id: submissionId, displayId: 'P-00001', machineId, machineName: machine.name, title: 'Enclosure', state: 'in_progress', declarations: [], attempts: [{ id: attemptId, submissionId, attemptNumber: 1, machineId, machineName: machine.name, state: 'printing', machineJobId: 'job-1', declarations: [], events: [], version: 6, createdAt: now, updatedAt: now }], version: 8, createdAt: now, updatedAt: now };
function auth(permissions: PermissionId[]) { server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)))); }
function catalog() { server.use(http.get(`*/api/v1/machines/${machineId}`, () => HttpResponse.json(machine)), http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [machine.machineType] }))); }

describe('Machine catalog and printer workflows', () => {
  it('opens the general machine detail with read access and does not query printer data', async () => {
    auth([PermissionId.machinesread]); catalog();
    let profileReads = 0;
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => { profileReads++; return HttpResponse.json(profile); }));
    renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    expect(await screen.findByRole('heading', { name: machine.name }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Edit machine' })).not.toBeInTheDocument();
    expect(profileReads).toBe(0);
  });
  it('denies the new detail route without machine read permission before querying it', async () => {
    auth([PermissionId.machinesmanage]);
    let reads = 0;
    server.use(http.get(`*/api/v1/machines/${machineId}`, () => { reads++; return HttpResponse.json(machine); }));
    const { router } = renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(reads).toBe(0);
  });
  it('sends URL-backed machine search, status and page size to the server', async () => {
    auth([PermissionId.machinesread]);
    const reads: URLSearchParams[] = [];
    server.use(http.get('*/api/v1/machines', ({ request }) => { reads.push(new URL(request.url).searchParams); return HttpResponse.json({ items: [machine], total: 51, page: 2, pageSize: 25 }); }));
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/machines?search=Laser&status=active&page=2&pageSize=25');
    await screen.findByRole('heading', { name: 'Machines' }, { timeout: 5000 });
    expect(reads[0].get('search')).toBe('Laser'); expect(reads[0].get('page')).toBe('2'); expect(reads[0].get('pageSize')).toBe('25');
    expect(screen.getAllByRole('link', { name: machine.name })[0]).toHaveAttribute('href', `/machine-logbook/machines/${machineId}`);
    await user.selectOptions(screen.getByLabelText('Machine status'), 'retired');
    await waitFor(() => expect(reads.some((params) => params.get('status') === 'retired' && params.get('page') === '1')).toBe(true));
  });
  it('keeps machine edits on errors and requires discard before closing', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let input: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/machines/${machineId}`, async ({ request }) => { input = await request.json() as Record<string, unknown>; return HttpResponse.json({ code: 'stale_write' }, { status: 409 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit machine' }, { timeout: 5000 }));
    await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'New cutter');
    await user.selectOptions(screen.getByLabelText('Administrative status'), 'retired');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByText('Machine not saved'); expect(input).toMatchObject({ name: 'New cutter', status: 'retired', expectedVersion: 7 });
    expect(screen.getByLabelText('Name')).toHaveValue('New cutter');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText('Discard unsaved changes?');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('New cutter');
  });
  it.each([404, 500])('treats only profile 404 as absent (status %s)', async (status) => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'error' }, { status })));
    renderRoute(<App />, `/machine-logbook/machines/${machineId}/printer`);
    if (status === 404) expect(await screen.findByRole('button', { name: 'Configure as printer' }, { timeout: 5000 })).toBeInTheDocument();
    else { await screen.findByText('Printer configuration could not be loaded.'); expect(screen.queryByRole('button', { name: 'Configure as printer' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(); }
  });
  it('disables an existing profile using its current version and retains topology', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let input: unknown;
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json(profile)), http.put(`*/api/v1/machines/${machineId}/printer`, async ({ request }) => { input = await request.json(); return HttpResponse.json({ ...profile, enabled: false, version: 5 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}/printer`);
    await user.click(await screen.findByRole('button', { name: 'Disable printer profile' }, { timeout: 5000 }));
    expect(screen.getByText(/Existing units, slots, assignments and print history are retained/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disable profile' }));
    await waitFor(() => expect(input).toEqual({ enabled: false, expectedVersion: 4 }));
  });
  it('allows adding an input unit without inventory queries or a disabled spool query blocking Save', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let unit: unknown; let spoolReads = 0;
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json(profile)), http.get('*/api/v1/filament-spools', () => { spoolReads++; return HttpResponse.json({ items: [], total: 0 }); }), http.post(`*/api/v1/machines/${machineId}/printer/input-units`, async ({ request }) => { unit = await request.json(); return HttpResponse.json({}); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}/printer`);
    await user.click(await screen.findByRole('button', { name: 'Add input unit' }, { timeout: 5000 }));
    await user.type(screen.getByLabelText('Name'), 'Rear feed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(unit).toMatchObject({ name: 'Rear feed', position: 0 })); expect(spoolReads).toBe(0);
  });
  it('does not offer Mount or request stock without inventory read, but offers Unmount', async () => {
    auth([PermissionId.machinesread, PermissionId.printer_slotsassign]); catalog();
    let spoolReads = 0;
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ ...profile, slots: [...profile.slots, { ...profile.slots[0], id: 'slot-2', name: 'Mounted slot', spoolId: 'spool-1', spoolDisplayId: 'F-00001' }] })), http.get('*/api/v1/filament-spools', () => { spoolReads++; return HttpResponse.json({ items: [] }); }));
    renderRoute(<App />, `/machine-logbook/machines/${machineId}/printer`);
    await screen.findByText('Mounting requires inventory access');
    expect(screen.queryByRole('button', { name: 'Mount spool' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Unmount' })).toBeInTheDocument(); expect(spoolReads).toBe(0);
  });
  it('does not issue any unauthorized new-submission lookup requests', async () => {
    auth([PermissionId.print_submissionsread, PermissionId.print_submissionsmanage]);
    const unexpected: string[] = [];
    server.use(http.get('*/api/v1/print-submissions', () => HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 25 })), ...['machines', 'materials', 'filament-spools', 'billing-parties'].map((path) => http.get(`*/api/v1/${path}`, () => { unexpected.push(path); return HttpResponse.json({ items: [] }); })));
    const user = userEvent.setup(); renderRoute(<App />, '/machine-logbook/print-submissions');
    await user.click(await screen.findByRole('button', { name: 'New submission' }, { timeout: 5000 }));
    expect(screen.getByText('Machine access required')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create submission' })).toBeDisabled(); expect(unexpected).toEqual([]);
  });
  it('records cancellation with the selected attempt version, keeps history, and hides unauthorized job links', async () => {
    auth([PermissionId.print_submissionsread, PermissionId.print_submissionsmanage]);
    let input: unknown;
    server.use(http.get(`*/api/v1/print-submissions/${submissionId}`, () => HttpResponse.json(submission)), http.patch(`*/api/v1/print-attempts/${attemptId}`, async ({ request }) => { input = await request.json(); return HttpResponse.json({ ...submission.attempts[0], state: 'cancelled', version: 7 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/print-submissions/${submissionId}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel attempt' }, { timeout: 5000 }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/does not stop the physical printer/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'job-1' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel attempt' }));
    await waitFor(() => expect(input).toEqual({ state: 'cancelled', expectedVersion: 6 }));
    expect(screen.getByRole('heading', { name: 'Attempt 1' })).toBeInTheDocument();
  });
  it.each([[PermissionId.machine_jobsread], [PermissionId.machine_jobsedit], [PermissionId.machine_jobsread, PermissionId.machine_jobsedit]])('requires both job read and edit to link attempts (%s)', async (...permissions) => {
    auth([PermissionId.print_submissionsread, PermissionId.print_submissionsmanage, ...permissions]);
    server.use(http.get(`*/api/v1/print-submissions/${submissionId}`, () => HttpResponse.json({ ...submission, attempts: [{ ...submission.attempts[0], machineJobId: null }] })));
    renderRoute(<App />, `/machine-logbook/print-submissions/${submissionId}`); await screen.findByRole('heading', { name: 'Attempt 1' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Link job' }) !== null).toBe(permissions.length === 2);
  });
  it('creates an absent printer profile at version zero', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let input: unknown;
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })), http.put(`*/api/v1/machines/${machineId}/printer`, async ({ request }) => { input = await request.json(); return HttpResponse.json(profile); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}/printer`);
    await user.click(await screen.findByRole('button', { name: 'Configure as printer' }, { timeout: 5000 }));
    await waitFor(() => expect(input).toEqual({ enabled: true, expectedVersion: 0 }));
  });
  it('updates type name and inactive status with the selected type version', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let input: unknown;
    server.use(http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 25, total: 1 })), http.patch(`*/api/v1/machine-types/${typeId}`, async ({ request }) => { input = await request.json(); return HttpResponse.json({ ...machine.machineType, active: false }); }));
    const user = userEvent.setup(); renderRoute(<App />, '/machine-logbook/machines');
    await user.click(await screen.findByRole('button', { name: 'Edit type Laser' }, { timeout: 5000 }));
    await user.click(screen.getByRole('switch', { name: 'Available for new machines' }));
    await user.click(screen.getByRole('button', { name: 'Save type' }));
    await waitFor(() => expect(input).toEqual({ name: 'Laser', active: false, expectedVersion: 3 }));
  });
  it('requires discard on Escape after a machine field becomes dirty', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit machine' }, { timeout: 5000 }));
    await user.type(screen.getByLabelText('Name'), ' edited');
    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Laser cutter edited');
  });

  it('keeps a pending machine mutation open on Escape and prevents duplicate submissions', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    let requests = 0;
    let release: (() => void) | undefined;
    const response = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.patch(`*/api/v1/machines/${machineId}`, async () => { requests++; await response; return HttpResponse.json({ code: 'stale_write' }, { status: 409 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit machine' }, { timeout: 5000 }));
    await user.type(screen.getByLabelText('Name'), ' edited');
    await user.dblClick(screen.getByRole('button', { name: 'Save machine' }));
    await waitFor(() => expect(requests).toBe(1));
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText('Name')).toHaveValue('Laser cutter edited');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    release?.();
    await screen.findByText('Machine not saved');
    expect(screen.getByLabelText('Name')).toHaveValue('Laser cutter edited');
  });

});
