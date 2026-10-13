import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type Machine } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const typeId = '0192f6f8-743e-7c77-a349-cd07c3e8a910';
const now = '2026-09-15T11:26:00Z';
const machine: Machine = { id: machineId, name: 'Laser cutter', machineType: { id: typeId, name: 'Laser', active: true, version: 3, createdAt: now, updatedAt: now }, status: 'active', automaticCollectionEnabled: false, jobCount: 3, runtimeSeconds: 600, failureRate: '0', version: 7, createdAt: now, updatedAt: now };
function auth(permissions: PermissionId[]) { server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)))); }
function catalog() { server.use(http.get(`*/api/v1/machines/${machineId}`, () => HttpResponse.json(machine)), http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [machine.machineType] })), http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [{ machineId, availability: 'available' }] }))); }

describe('Machine catalog and printer workflows', () => {
  it('opens the general machine detail with read access and hides management actions', async () => {
    auth([PermissionId.machinesread]); catalog();
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })));
    renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    expect(await screen.findByRole('heading', { name: machine.name }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'More machine actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Printer setup' })).not.toBeInTheDocument();
  });
  it('denies the new detail route without machine read permission before querying it', async () => {
    auth([PermissionId.machinesmanage]);
    let reads = 0;
    server.use(http.get(`*/api/v1/machines/${machineId}`, () => { reads++; return HttpResponse.json(machine); }));
    const { router } = renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(reads).toBe(0);
  });
  async function openEditor(user: ReturnType<typeof userEvent.setup>) {
    await user.click((await screen.findByText('More machine actions', { selector: '.cds--tooltip-content' }, { timeout: 5000 })).closest('.cds--popover-container')!.querySelector('button')!);
    await user.click(await screen.findByText('Edit machine', { selector: '.cds--overflow-menu-options__option-content' }));
    return screen.findByRole('dialog', { name: 'Edit machine' });
  }
  it('keeps machine edits on errors and sends the version the editor opened with', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })));
    let input: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/machines/${machineId}`, async ({ request }) => { input = await request.json() as Record<string, unknown>; return HttpResponse.json({ code: 'stale_write' }, { status: 409 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    const dialog = await openEditor(user);
    await user.clear(within(dialog).getByLabelText('Name')); await user.type(within(dialog).getByLabelText('Name'), 'New cutter');
    await user.click(within(dialog).getByLabelText('Retired'));
    await user.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    await within(dialog).findByText('Machine not saved');
    expect(input).toEqual({ name: 'New cutter', machineTypeId: typeId, status: 'retired', externalIdentifier: null, automaticCollectionEnabled: false, expectedVersion: 7 });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('New cutter');
  });
  it('only sends an external identifier together with automatic collection', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })));
    let input: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/machines/${machineId}`, async ({ request }) => { input = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...machine, version: 8 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    const dialog = await openEditor(user);
    expect(within(dialog).getByLabelText('External identifier (optional)')).toBeDisabled();
    await user.click(within(dialog).getByRole('switch', { name: 'Automatic collection' }));
    await user.type(within(dialog).getByLabelText('External identifier (optional)'), 'LC-1');
    await user.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    await waitFor(() => expect(input).toMatchObject({ automaticCollectionEnabled: true, externalIdentifier: 'LC-1', expectedVersion: 7 }));
  });
  it('prevents duplicate submissions while a machine save is pending', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    server.use(http.get(`*/api/v1/machines/${machineId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })));
    let requests = 0;
    let release: (() => void) | undefined;
    const response = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.patch(`*/api/v1/machines/${machineId}`, async () => { requests++; await response; return HttpResponse.json({ code: 'stale_write' }, { status: 409 }); }));
    const user = userEvent.setup(); renderRoute(<App />, `/machine-logbook/machines/${machineId}`);
    const dialog = await openEditor(user);
    await user.type(within(dialog).getByLabelText('Name'), ' edited');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Save machine' }));
    await waitFor(() => expect(requests).toBe(1));
    await user.keyboard('{Escape}');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Laser cutter edited');
    release?.();
    await within(dialog).findByText('Machine not saved');
    expect(requests).toBe(1);
  });
  it('updates a machine type name and inactive status with the selected type version', async () => {
    auth([PermissionId.machinesread, PermissionId.machinesmanage]); catalog();
    const inputs: unknown[] = [];
    server.use(http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })), http.patch(`*/api/v1/machine-types/${typeId}`, async ({ request }) => { inputs.push(await request.json()); return HttpResponse.json({ ...machine.machineType, active: false }); }));
    const user = userEvent.setup(); renderRoute(<App />, '/machine-logbook/machines');
    await user.click((await screen.findByText('More actions', { selector: '.cds--tooltip-content' }, { timeout: 5000 })).closest('.cds--popover-container')!.querySelector('button')!);
    await user.click(await screen.findByText('Manage machine types', { selector: '.cds--overflow-menu-options__option-content' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage machine types' });
    await user.click(await within(dialog).findByRole('switch', { name: 'Laser active' }));
    await waitFor(() => expect(inputs).toContainEqual({ active: false, expectedVersion: 3 }));
    await user.clear(within(dialog).getByLabelText('Type name')); await user.type(within(dialog).getByLabelText('Type name'), 'Laser line');
    await user.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(inputs).toContainEqual({ name: 'Laser line', expectedVersion: 3 }));
  });
});
