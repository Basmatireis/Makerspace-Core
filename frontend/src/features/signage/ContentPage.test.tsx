import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { announcementFixture, ids, mockSignage, playlistFixture, sceneFixture, templateFixture } from './testFixtures';

describe('Content page', () => {
  it('shows scene tiles and playlists read-only with signage.read', async () => {
    mockSignage([PermissionId.signageread], {
      playlists: [
        playlistFixture({
          items: [
            { sceneId: ids.scene, seconds: 20, transition: 'fade' },
            { sceneId: ids.scene, seconds: 40, transition: 'cut' },
          ],
        }),
      ],
    });
    renderRoute(<App />, '/signage/content');
    expect(await screen.findByRole('heading', { name: 'Content' })).toBeInTheDocument();
    const tile = await screen.findByRole('link', { name: 'Scene Open days poster' });
    expect(tile).toHaveAttribute('href', `/signage/scenes/${ids.scene}`);
    expect(within(tile).getByText('Portrait')).toBeInTheDocument();
    expect(await within(tile).findByText('Used in 1 playlist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New scene' })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Playlists' }));
    expect(await screen.findByRole('link', { name: 'Ads' })).toHaveAttribute(
      'href',
      `/signage/playlists/${ids.playlist}`,
    );
    expect(screen.getByText('1 min')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New playlist' })).not.toBeInTheDocument();
  });

  it('creates a scene with a layout and opens the editor', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/signage/scenes', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          sceneFixture({
            id: ids.scene2,
            name: String(body.name),
            layoutId: 'split',
            zones: { left: { type: 'empty' }, right: { type: 'empty' } },
          }),
          { status: 201 },
        );
      }),
    );
    const { router } = renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New scene' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create scene' }));
    expect(await within(dialog).findByText('Give the scene a name')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Lobby');
    await user.click(within(dialog).getByRole('radio', { name: /Two columns/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create scene' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/signage/scenes/${ids.scene2}`));
    expect(body).toMatchObject({
      name: 'Lobby',
      orientation: 'portrait',
      layoutId: 'split',
      zones: { left: { type: 'empty' }, right: { type: 'empty' } },
    });
  });

  it('lists announcement templates and hides the actions without signage.content.manage', async () => {
    mockSignage([PermissionId.signageread], { announcements: [announcementFixture()] });
    renderRoute(<App />, '/signage/content?section=announcements');
    expect(await screen.findByText('Closed today – {reason}')).toBeInTheDocument();
    expect(await screen.findByText('1 announcement')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Actions for Closed' })).not.toBeInTheDocument();
  });

  it('explains which references block deleting a template (409 signage_in_use)', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { templates: [templateFixture()] });
    server.use(
      http.delete('*/api/v1/signage/announcement-templates/:id', () =>
        HttpResponse.json(
          {
            code: 'signage_in_use',
            message: 'Announcement template is still in use',
            details: {
              references: [
                { kind: 'scene', id: ids.scene, name: 'Open days poster' },
                { kind: 'display_rule', id: ids.display, name: 'Entrance window' },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderRoute(<App />, '/signage/content?section=announcements');
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByRole('group', { name: 'Actions for Closed' })).getByRole('button', { name: 'Delete' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete template' }));
    const blocked = await screen.findByRole('dialog');
    expect(within(blocked).getByRole('link', { name: 'Open days poster' })).toHaveAttribute(
      'href',
      `/signage/scenes/${ids.scene}`,
    );
    expect(within(blocked).getByText('Entrance window')).toBeInTheDocument();
  });

  it('deletes an unused template', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let sent: unknown;
    server.use(
      http.delete('*/api/v1/signage/announcement-templates/:id', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/signage/content?section=announcements');
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByRole('group', { name: 'Actions for Closed' })).getByRole('button', { name: 'Delete' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(sent).toEqual({ expectedVersion: 4 }));
  });

  it('edits a template: unknown placeholder warning, variable menu and live preview', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put('*/api/v1/signage/announcement-templates/:id', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(templateFixture({ version: 5 }));
      }),
    );
    renderRoute(<App />, '/signage/content?section=announcements');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Closed' }));
    const dialog = await screen.findByRole('dialog');
    // The preview renders the title with the sample value of the choice field.
    expect(within(dialog).getByText('Closed today – Holiday')).toBeInTheDocument();
    const title = within(dialog).getByLabelText('Title');
    await user.selectOptions(within(dialog).getByLabelText('Format'), 'markdown');
    await user.click(within(dialog).getByRole('button', { name: 'Body CSS' }));
    fireEvent.change(within(dialog).getByLabelText('CSS'), { target: { value: 'p { color: red; }' } });
    fireEvent.change(title, { target: { value: 'Out {oops}' } });
    expect(await within(dialog).findByText('Unknown variable {oops}. It is shown as typed.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        expectedVersion: 4,
        name: 'Closed',
        tone: 'warning',
        title: 'Out {oops}',
        bodyFormat: 'markdown',
        bodyCss: 'p { color: red; }',
        fields: [
          { key: 'reason', label: 'Reason', type: 'choice', required: true, options: ['Holiday', 'Maintenance'] },
        ],
      }),
    );
  });
});
