import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ids, mockSignage, playlistFixture, sceneFixture } from './testFixtures';

describe('Playlist detail', () => {
  it('adds a scene and saves with the expected version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], {
      scenes: [sceneFixture(), sceneFixture({ id: ids.scene2, name: 'Workshops' })],
    });
    let body: unknown;
    server.use(
      http.put('*/api/v1/signage/playlists/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(playlistFixture({ version: 3 }));
      }),
    );
    renderRoute(<App />, `/signage/playlists/${ids.playlist}`);
    const user = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Save playlist' });
    expect(save).toBeDisabled();
    await user.click(await screen.findByRole('combobox', { name: 'Add scene' }));
    await user.click(await screen.findByRole('option', { name: 'Workshops' }));
    expect(screen.getByText('Loop 40 s · 2 scenes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save playlist' }));
    await waitFor(() =>
      expect(body).toEqual({
        expectedVersion: 2,
        name: 'Ads',
        items: [
          { sceneId: ids.scene, seconds: 20, transition: 'fade' },
          { sceneId: ids.scene2, seconds: 20, transition: 'fade' },
        ],
      }),
    );
  });

  it('is read-only with signage.read only', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, `/signage/playlists/${ids.playlist}`);
    expect(await screen.findByText('Open days poster')).toBeInTheDocument();
    expect(screen.getByText('20 s · Fade')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save playlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Add scene' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete playlist' })).not.toBeInTheDocument();
  });

  it('shows not found for a missing playlist', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, '/signage/playlists/0192f6f8-743e-7c77-a349-cd07c3e8a999');
    expect(await screen.findByText('This playlist does not exist')).toBeInTheDocument();
  });
});
