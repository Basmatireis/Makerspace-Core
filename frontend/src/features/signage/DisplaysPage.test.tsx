import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { displayFixture, ids, mockSignage } from './testFixtures';

const offline = displayFixture({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a152', name: 'Laser room', location: '', orientation: 'landscape', resolution: { width: 1920, height: 1080 }, status: 'offline',
  lastHeartbeatAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), publishedRevision: 1, pendingChanges: [{ kind: 'scene', name: 'Open days poster', change: 'modified' }, { kind: 'rule', name: '', change: 'added' }], currentRule: null, currentSceneId: null,
});

describe('Displays page', () => {
  it('lists displays with status, now showing and publication state', async () => {
    mockSignage([PermissionId.signageread], { displays: [displayFixture(), offline] });
    renderRoute(<App />, '/signage');
    const table = await screen.findByRole('table', { name: 'Displays' });
    const entrance = within(await within(table).findByRole('row', { name: /Entrance window/ }));
    expect(entrance.getByText('Online')).toBeInTheDocument();
    expect(await entrance.findByText('Open days poster')).toBeInTheDocument();
    expect(entrance.getByText('Default playlist Ads')).toBeInTheDocument();
    expect(entrance.getByText('Up to date')).toBeInTheDocument();
    const laser = within(within(table).getByRole('row', { name: /Laser room/ }));
    expect(laser.getByText('Offline')).toBeInTheDocument();
    expect(laser.getByText('last seen 2 h ago')).toBeInTheDocument();
    expect(laser.getByText('2 unpublished changes')).toBeInTheDocument();
    expect(screen.getByText('2 displays · 1 online · 1 needs publishing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair display' })).not.toBeInTheDocument();
  });

  it('pairs a display by code and opens it', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    let body: unknown;
    server.use(http.post('*/api/v1/signage/displays', async ({ request }) => { body = await request.json(); return HttpResponse.json(displayFixture({ name: 'Workshop' }), { status: 201 }); }));
    renderRoute(<App />, '/signage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair display' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pairing code'), 'k7f 2qx');
    await user.type(within(dialog).getByLabelText('Name'), 'Workshop');
    await user.click(within(dialog).getByRole('radio', { name: 'Portrait' }));
    await user.selectOptions(within(dialog).getByLabelText('Default playlist'), 'Ads');
    await user.click(within(dialog).getByRole('button', { name: 'Pair display' }));
    await waitFor(() => expect(body).toEqual({
      code: 'K7F2QX', name: 'Workshop', location: '', orientation: 'portrait', resolution: { width: 1080, height: 1920 }, visibleFromOutside: false, defaultPlaylistId: ids.playlist,
    }));
    expect(await screen.findByRole('heading', { name: 'Entrance window' })).toBeInTheDocument();
  });

  it('submits the pair modal on Enter from a single-line field', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    let posts = 0;
    server.use(http.post('*/api/v1/signage/displays', () => { posts += 1; return HttpResponse.json(displayFixture({ name: 'Workshop' }), { status: 201 }); }));
    renderRoute(<App />, '/signage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair display' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pairing code'), 'k7f2qx{Enter}');
    expect(await within(dialog).findByText('Give the display a name')).toBeInTheDocument();
    expect(posts).toBe(0);
    await user.type(within(dialog).getByLabelText('Name'), 'Workshop');
    await user.selectOptions(within(dialog).getByLabelText('Default playlist'), 'Ads');
    await user.type(within(dialog).getByLabelText('Name'), '{Enter}');
    await waitFor(() => expect(posts).toBe(1));
    expect(await screen.findByRole('heading', { name: 'Entrance window' })).toBeInTheDocument();
  });

  it('uppercases the pairing code, strips spaces and caps it at six characters', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    renderRoute(<App />, '/signage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair display' }));
    const dialog = await screen.findByRole('dialog');
    const code = within(dialog).getByLabelText('Pairing code');
    await user.type(code, 'k7f2qxzz');
    expect(code).toHaveValue('K7F2QX');
    await user.clear(code);
    await user.paste('k7f 2qx');
    expect(code).toHaveValue('K7F2QX');
  });

  it.each([[422, { code: 'pairing_code_invalid', message: 'The code is not valid' }], [429, { code: 'rate_limited', message: 'Too many attempts' }]])('answers a rejected code (%s) the same way', async (status, error) => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    server.use(http.post('*/api/v1/signage/displays', () => HttpResponse.json(error, { status })));
    renderRoute(<App />, '/signage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair display' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pairing code'), 'AAAAAA');
    await user.type(within(dialog).getByLabelText('Name'), 'Workshop');
    await user.selectOptions(within(dialog).getByLabelText('Default playlist'), 'Ads');
    await user.click(within(dialog).getByRole('button', { name: 'Pair display' }));
    expect(await within(dialog).findByText(/This code was not accepted/)).toBeInTheDocument();
    expect(screen.queryByText('Too many attempts')).not.toBeInTheDocument();
  });

  it('checks the code format before sending', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage]);
    let posts = 0;
    server.use(http.post('*/api/v1/signage/displays', () => { posts += 1; return HttpResponse.json(displayFixture(), { status: 201 }); }));
    renderRoute(<App />, '/signage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair display' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pairing code'), 'ABC10O');
    await user.click(within(dialog).getByRole('button', { name: 'Pair display' }));
    expect(await within(dialog).findByText('Enter the 6 characters shown on the screen')).toBeInTheDocument();
    expect(posts).toBe(0);
  });
});
