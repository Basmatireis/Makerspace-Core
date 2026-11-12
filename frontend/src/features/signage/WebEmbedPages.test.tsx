import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { MediaConfirmModal } from './WebEmbedDialogs';
import { displayFixture, embedFixture, groupFixture, ids, mockSignage, sceneFixture } from './testFixtures';

const manage = [PermissionId.signageread, PermissionId.signagemanage, PermissionId.signagepublish];
const detail = `/signage/embeds/${ids.embed}`;

describe('Web embeds list', () => {
  it('lists embeds with content, websites, extra content and status', async () => {
    mockSignage([PermissionId.signageread], {
      embeds: [
        embedFixture(),
        embedFixture({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a1c2',
          name: 'Printer wall',
          allowedOrigins: ['https://blog.example'],
          cameraEnabled: true,
          cameraMachineIds: [ids.machine],
          timelapseEnabled: true,
          enabled: false,
        }),
      ],
    });
    renderRoute(<App />, '/signage/embeds');
    const table = await screen.findByRole('table', { name: 'Web embeds' });
    const first = within(within(table).getByRole('row', { name: /Open days on the student council site/ }));
    expect(first.getByText('1 scene, own list')).toBeInTheDocument();
    expect(first.getByText('fachschaft-muster.example')).toBeInTheDocument();
    expect(first.getByText('+1 more')).toBeInTheDocument();
    expect(first.getByText('Public information only')).toBeInTheDocument();
    expect(first.getByText('Live · revision 4')).toBeInTheDocument();
    const second = within(within(table).getByRole('row', { name: /Printer wall/ }));
    expect(second.getByText('Cameras · 1')).toBeInTheDocument();
    expect(second.getByText('Timelapses')).toBeInTheDocument();
    expect(second.getByText('Turned off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New web embed' })).not.toBeInTheDocument();
  });

  it('creates an embed with its first website and default scenes and opens it', async () => {
    mockSignage(manage, { embeds: [], scenes: [sceneFixture({ aspectRatio: { width: 16, height: 9 } })] });
    let body: unknown;
    server.use(
      http.post('*/api/v1/signage/web-embeds', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(embedFixture({ name: 'Faculty site' }), { status: 201 });
      }),
      http.get('*/api/v1/signage/web-embeds/:id', () => HttpResponse.json(embedFixture({ name: 'Faculty site' }))),
    );
    renderRoute(<App />, '/signage/embeds');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New web embed' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Faculty site');
    await user.type(within(dialog).getByLabelText('Website'), 'https://example.org/news');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText("Enter the website's https address without a path.")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.clear(within(dialog).getByLabelText('Website'));
    await user.type(within(dialog).getByLabelText('Website'), 'https://Example.org');
    // Without a group the embed needs a default scene, as the backend requires (it refused the create before).
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Choose a scene for every item')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.selectOptions(within(dialog).getByLabelText('Scene 1'), 'Open days poster');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Faculty site',
        aspectRatio: { width: 16, height: 9 },
        allowedOrigins: ['https://example.org'],
        defaultScenes: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Faculty site' })).toBeInTheDocument();
  });

  it('creates an embed that follows a group of its ratio without default scenes', async () => {
    mockSignage(manage, { embeds: [], groups: [groupFixture()] });
    let body: unknown;
    server.use(
      http.post('*/api/v1/signage/web-embeds', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(embedFixture({ name: 'Hallway copy' }), { status: 201 });
      }),
      http.get('*/api/v1/signage/web-embeds/:id', () => HttpResponse.json(embedFixture({ name: 'Hallway copy' }))),
    );
    renderRoute(<App />, '/signage/embeds');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New web embed' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Hallway copy');
    await user.type(within(dialog).getByLabelText('Website'), 'https://example.org');
    // The 9:16 group is offered only once the embed has its ratio.
    expect(
      within(within(dialog).getByLabelText('Group')).queryByRole('option', { name: 'Hallway screens' }),
    ).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Aspect ratio'), '9:16 (portrait)');
    await user.selectOptions(within(dialog).getByLabelText('Group'), 'Hallway screens');
    expect(within(dialog).queryByLabelText('Scene 1')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Hallway copy',
        aspectRatio: { width: 9, height: 16 },
        allowedOrigins: ['https://example.org'],
        groupId: ids.group,
      }),
    );
  });
});

describe('Group members', () => {
  it('counts displays and web embeds separately and lists the embed on the group page', async () => {
    const group = groupFixture({ displayIds: [ids.display, ids.embed] });
    mockSignage([PermissionId.signageread], {
      groups: [group],
      displays: [displayFixture({ groupId: group.id, aspectRatio: group.aspectRatio })],
      embeds: [embedFixture({ groupId: group.id, aspectRatio: group.aspectRatio })],
    });
    renderRoute(<App />, '/signage');
    expect(await screen.findByText('1 display · 1 web embed')).toBeInTheDocument();
    renderRoute(<App />, `/signage/groups/${group.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    const link = await screen.findByRole('link', { name: 'Open days on the student council site' });
    expect(link).toHaveAttribute('href', `/signage/embeds/${ids.embed}`);
  });
});

describe('Web embed detail', () => {
  it('hides manage and publish controls without the permissions', async () => {
    mockSignage([PermissionId.signageread], {
      embeds: [embedFixture({ pendingChanges: [{ kind: 'scene', name: 'Poster', change: 'modified' }] })],
    });
    renderRoute(<App />, detail);
    expect(await screen.findByRole('heading', { name: 'Open days on the student council site' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });

  it('publishes pending changes and turns the embed off', async () => {
    mockSignage(manage, {
      embeds: [embedFixture({ pendingChanges: [{ kind: 'scene', name: 'Poster', change: 'modified' }] })],
    });
    let published = false;
    let patch: unknown;
    server.use(
      http.post('*/api/v1/signage/web-embeds/:id/publish', () => {
        published = true;
        return HttpResponse.json(embedFixture());
      }),
      http.patch('*/api/v1/signage/web-embeds/:id', async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json(embedFixture({ enabled: false }));
      }),
    );
    renderRoute(<App />, detail);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Publish changes' }));
    await waitFor(() => expect(published).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(patch).toEqual({ expectedVersion: 3, enabled: false }));
  });

  it('adds a website, refuses invalid and duplicate ones, and keeps the last one', async () => {
    mockSignage(manage, { embeds: [embedFixture()] });
    let patch: unknown;
    server.use(
      http.patch('*/api/v1/signage/web-embeds/:id', async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json(embedFixture());
      }),
    );
    renderRoute(<App />, detail);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Websites' }));
    const input = await screen.findByLabelText('Add website');
    await user.type(input, 'http://blog.example');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/Enter an https address without a path/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'https://FACHSCHAFT-muster.example/');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('This website is already in the list.')).toBeInTheDocument();
    expect(patch).toBeUndefined();
    await user.clear(input);
    await user.type(input, 'https://blog.example');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(patch).toEqual({
        expectedVersion: 3,
        allowedOrigins: [
          'https://fachschaft-muster.example',
          'https://www.fachschaft-muster.example',
          'https://blog.example',
        ],
      }),
    );
    patch = undefined;
    await user.click(screen.getByRole('button', { name: 'Remove https://www.fachschaft-muster.example' }));
    await waitFor(() =>
      expect(patch).toEqual({ expectedVersion: 3, allowedOrigins: ['https://fachschaft-muster.example'] }),
    );
  });

  it('disables removing the only website', async () => {
    mockSignage(manage, { embeds: [embedFixture({ allowedOrigins: ['https://only.example'] })] });
    renderRoute(<App />, detail);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Websites' }));
    expect(
      await screen.findByRole('button', {
        name: /Remove https:\/\/only\.example \(the last website cannot be removed\)/,
      }),
    ).toBeDisabled();
    expect(screen.getByText(/The last website cannot be removed\./)).toBeInTheDocument();
  });

  it('asks before cameras are switched on and switches them off at once', async () => {
    const embeds = [embedFixture()];
    mockSignage(manage, {
      embeds,
      machines: [{ id: ids.machine, name: 'Prusa CORE One', kind: 'printer', hasCamera: true }],
    });
    const patches: unknown[] = [];
    server.use(
      http.patch('*/api/v1/signage/web-embeds/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patches.push(body);
        embeds[0] = embedFixture({ cameraEnabled: body.cameraEnabled === true, cameraMachineIds: [ids.machine] });
        return HttpResponse.json(embeds[0]);
      }),
    );
    renderRoute(<App />, detail);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Data shown' }));
    await user.click(await screen.findByRole('switch', { name: 'Printer cameras' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/fachschaft-muster\.example, www\.fachschaft-muster\.example/)).toBeInTheDocument();
    expect(patches).toEqual([]);
    expect(within(dialog).getByRole('button', { name: 'Allow cameras' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Allow cameras' }));
    await waitFor(() =>
      expect(patches).toEqual([{ expectedVersion: 3, cameraEnabled: true, cameraMachineIds: [ids.machine] }]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('checkbox', { name: 'Prusa CORE One' })).toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Printer cameras' }));
    await waitFor(() => expect(patches[1]).toEqual({ expectedVersion: 3, cameraEnabled: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the iframe code and makes a new link after confirmation', async () => {
    mockSignage(manage, {
      embeds: [embedFixture({ aspectRatio: { width: 7, height: 3 } })],
      scenes: [sceneFixture({ aspectRatio: { width: 7, height: 3 } })],
    });
    let rotated: unknown;
    server.use(
      http.post('*/api/v1/signage/web-embeds/:id/rotate-key', async ({ request }) => {
        rotated = await request.json();
        return HttpResponse.json(embedFixture());
      }),
    );
    renderRoute(<App />, detail);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Embed code' }));
    expect(await screen.findByText(/aspect-ratio:7\/3;border:0/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make a new link' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(rotated).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Make a new link' }));
    await waitFor(() => expect(rotated).toEqual({ expectedVersion: 3 }));
  });
});

describe('MediaConfirmModal', () => {
  const embed = { name: 'Printer wall', allowedOrigins: ['https://blog.example'] };

  it('needs the checkbox before it confirms', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <MediaConfirmModal kind="timelapse" embed={embed} pending={false} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const confirm = screen.getByRole('button', { name: 'Allow timelapses' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/blog\.example/)).toBeInTheDocument();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
