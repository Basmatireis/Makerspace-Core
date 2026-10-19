import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ids, mockSignage, sceneFixture } from './testFixtures';
import { draftError, toDraft } from './sceneDraft';

const editor = `/signage/scenes/${ids.scene}`;

describe('Scene editor', () => {
  it('autosaves edits with the expected version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const bodies: Record<string, unknown>[] = [];
    server.use(http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return HttpResponse.json(sceneFixture({ name: String(body.name), version: 4 }));
    }));
    renderRoute(<App />, editor);
    expect((await screen.findAllByText(/Saved · draft/)).length).toBeGreaterThan(0);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed poster' } });
    expect(screen.getAllByText(/Unsaved changes/).length).toBeGreaterThan(0);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ expectedVersion: 3, name: 'Renamed poster', layoutId: 'stack3', orientation: 'portrait', backgroundColor: '#161616' });
    expect(await screen.findByRole('heading', { name: 'Renamed poster' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/Saved · draft/).length).toBeGreaterThan(0));
  });

  it('offers to reload or overwrite after a stale write (409)', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let puts = 0;
    let gets = 0;
    server.use(http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
      puts += 1;
      const body = (await request.json()) as { expectedVersion: number; name: string };
      return body.expectedVersion === 3 ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 }) : HttpResponse.json(sceneFixture({ name: body.name, version: body.expectedVersion + 1 }));
    }), http.get('*/api/v1/signage/scenes/:id', () => { gets += 1; return HttpResponse.json(gets === 1 ? sceneFixture() : sceneFixture({ name: 'Edited elsewhere', version: 7 })); }));
    renderRoute(<App />, editor);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Mine' } });
    expect(await screen.findByText('This scene was changed somewhere else')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keep my changes' }));
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => expect(screen.queryByText('This scene was changed somewhere else')).not.toBeInTheDocument());
  });

  it('does not send what the backend would reject and says why', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let puts = 0;
    server.use(http.put('*/api/v1/signage/scenes/:id', () => { puts += 1; return HttpResponse.json(sceneFixture()); }));
    renderRoute(<App />, editor);
    fireEvent.change(await screen.findByLabelText('Background colour'), { target: { value: 'red' } });
    expect(await screen.findByText('Enter the background colour as #rrggbb.')).toBeInTheDocument();
    expect(puts).toBe(0);
  });

  it('lists picker machines from the signage endpoint without the machines permission', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a201', name: 'Prusa MK4', kind: 'FDM printer', hasCamera: false }] });
    let machinesApiCalled = false;
    server.use(http.get('*/api/v1/machines', () => { machinesApiCalled = true; return HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }); }));
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    await user.selectOptions(await screen.findByLabelText('Source'), 'machine');
    expect(await screen.findByRole('option', { name: 'Prusa MK4' })).toBeInTheDocument();
    expect(machinesApiCalled).toBe(false);
  });

  it('selects a zone and changes its widget type', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let zones: Record<string, { type: string }> | undefined;
    server.use(http.put('*/api/v1/signage/scenes/:id', async ({ request }) => { zones = ((await request.json()) as { zones: typeof zones }).zones; return HttpResponse.json(sceneFixture()); }));
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    expect(screen.getByRole('heading', { name: 'Zone: Footer' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Widget type'), 'qr');
    expect(await screen.findByText('Enter an https:// URL without credentials.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://makerspace.example/open' } });
    await waitFor(() => expect(zones?.footer).toMatchObject({ type: 'qr', url: 'https://makerspace.example/open' }));
    expect(zones?.header).toMatchObject({ type: 'text' });
  });

  it('is read-only with signage.read only', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, editor);
    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change layout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete scene' })).not.toBeInTheDocument();
  });

  it('lists the references when a scene cannot be deleted', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    server.use(http.delete('*/api/v1/signage/scenes/:id', () => HttpResponse.json({ code: 'signage_in_use', message: 'in use', details: { references: [{ kind: 'playlist', id: ids.playlist, name: 'Ads' }] } }, { status: 409 })));
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete scene' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete scene' }));
    expect(await within(await screen.findByRole('dialog')).findByRole('link', { name: 'Ads' })).toHaveAttribute('href', `/signage/playlists/${ids.playlist}`);
  });
});

describe('draftError', () => {
  it('mirrors the backend rules', () => {
    const draft = toDraft(sceneFixture());
    expect(draftError(draft)).toBeNull();
    expect(draftError({ ...draft, name: '  ' })).toBe('Give the scene a name.');
    expect(draftError({ ...draft, zones: { ...draft.zones, main: { type: 'camera', source: 'machine', machineId: null, multi: 'split', showProgress: true, showRemaining: true, fallback: 'text', fallbackMediaId: null } } })).toBe('Zone Main: Choose a machine.');
  });
});
