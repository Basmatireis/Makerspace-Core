import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { announcementFixture, ids, mockSignage, sceneFixture, templateFixture } from './testFixtures';

describe('Content page', () => {
  it('shows screen cards read-only with signage.read, as Screens and Announcement templates tabs', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, '/signage/content');
    expect(await screen.findByRole('heading', { name: 'Screens' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Screens' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Announcement templates' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Layouts' })).not.toBeInTheDocument();
    const tile = await screen.findByRole('link', { name: 'Screen Open days poster' });
    expect(tile).toHaveAttribute('href', `/signage/scenes/${ids.scene}`);
    expect(within(tile).getByText('Portrait 9:16')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New screen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('filters the cards by name or shape', async () => {
    mockSignage([PermissionId.signageread], {
      scenes: [sceneFixture(), sceneFixture({ id: ids.scene2, name: 'Lobby', aspectRatio: { width: 16, height: 9 } })],
    });
    renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Screen Lobby' });
    await user.type(screen.getByRole('searchbox', { name: 'Search screens' }), 'landscape');
    expect(screen.queryByRole('link', { name: 'Screen Open days poster' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Screen Lobby' })).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search screens' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search screens' }), 'zzz');
    expect(await screen.findByText('No screens match')).toBeInTheDocument();
  });

  it('creates a screen from a starter and opens the editor', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/signage/scenes', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sceneFixture({ id: ids.scene2, name: String(body.name) }), { status: 201 });
      }),
    );
    const { router } = renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New screen' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Create screen' }));
    expect(await within(dialog).findByText('Give the screen a name')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Lobby');
    await user.click(within(dialog).getByRole('radio', { name: /Full screen \+ ticker/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create screen' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/signage/scenes/${ids.scene2}`));
    // 16:9 is a 1920 x 1080 grid; the usable area inside the 48-unit margin is 1824 x 984.
    expect(body).toMatchObject({ name: 'Lobby', aspectRatio: { width: 16, height: 9 }, theme: 'dark' });
    const blocks = body?.blocks as {
      id: string;
      name: string;
      x: number;
      y: number;
      w: number;
      h: number;
      widget: unknown;
    }[];
    expect(blocks.map(({ name, x, y, w, h, widget }) => ({ name, x, y, w, h, widget }))).toEqual([
      { name: 'Block 1', x: 48, y: 48, w: 1824, h: 827, widget: { type: 'empty' } },
      { name: 'Block 2', x: 48, y: 904, w: 1824, h: 128, widget: { type: 'empty' } },
    ]);
    expect(blocks[0].id).toMatch(/^b[a-z0-9]+$/);
  });

  it('validates the shape, swaps it and transposes the starter for portrait', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/signage/scenes', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sceneFixture({ id: ids.scene2 }), { status: 201 });
      }),
    );
    renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New screen' }));
    const dialog = await screen.findByRole('dialog');
    const width = within(dialog).getByRole('spinbutton', { name: 'Width part of the ratio' });
    const height = within(dialog).getByRole('spinbutton', { name: 'Height part of the ratio' });
    const create = within(dialog).getByRole('button', { name: 'Create screen' });
    expect(within(dialog).getByText('Landscape')).toBeInTheDocument();

    await user.clear(width);
    await user.type(width, '50');
    expect(within(dialog).getByText('Use a shape between 1:5 and 5:1.')).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(width);
    await user.type(width, '1000');
    expect(within(dialog).getByText(/whole numbers between 1 and 999/)).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(width);
    await user.type(width, '16');
    expect(create).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Swap width and height' }));
    expect(width).toHaveValue(9);
    expect(height).toHaveValue(16);
    expect(within(dialog).getByText('Portrait')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: /Full screen \+ ticker/ }));
    await user.click(create);
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.aspectRatio).toEqual({ width: 9, height: 16 });
    // Portrait grid 1080 x 1920: the ticker becomes a narrow column on the right.
    const blocks = body?.blocks as { x: number; y: number; w: number; h: number }[];
    expect(blocks.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [48, 48, 827, 1824],
      [904, 48, 128, 1824],
    ]);
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
                { kind: 'rule', id: ids.display, name: 'Entrance window' },
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
    expect(within(blocked).getByRole('link', { name: 'Entrance window' })).toHaveAttribute(
      'href',
      `/signage/displays/${ids.display}`,
    );
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

  it('duplicates a screen from its menu and opens the copy', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    server.use(
      http.post('*/api/v1/signage/scenes/:id/duplicate', () =>
        HttpResponse.json(sceneFixture({ id: ids.scene2, name: 'Open days poster (copy)' }), { status: 201 }),
      ),
    );
    const { router } = renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Open days poster' }));
    await user.click(await screen.findByText('Duplicate'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/signage/scenes/${ids.scene2}`));
  });

  it('deletes a screen from its menu with its version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let sent: unknown;
    server.use(
      http.delete('*/api/v1/signage/scenes/:id', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/signage/content');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Open days poster' }));
    await user.click(await screen.findByText('Delete'));
    await user.click(await screen.findByRole('button', { name: 'Delete screen' }));
    await waitFor(() => expect(sent).toEqual({ expectedVersion: 3 }));
  });

  it('shows no screen menu without signage.content.manage', async () => {
    mockSignage([PermissionId.signageread], { templates: [templateFixture()] });
    renderRoute(<App />, '/signage/content');
    await screen.findByRole('link', { name: 'Screen Open days poster' });
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('duplicates an announcement template and opens the copy for editing', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { templates: [templateFixture()] });
    server.use(
      http.post('*/api/v1/signage/announcement-templates/:id/duplicate', () =>
        HttpResponse.json(templateFixture({ id: ids.template.replace(/1$/, '2'), name: 'Closed (copy)' }), {
          status: 201,
        }),
      ),
    );
    renderRoute(<App />, '/signage/content?section=announcements');
    const user = userEvent.setup();
    const actions = await screen.findByRole('group', { name: 'Actions for Closed' });
    await user.click(within(actions).getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Closed (copy)');
  });
});
