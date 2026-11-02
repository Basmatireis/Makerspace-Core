import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { displayFixture, groupFixture, ids, mockSignage, ruleFixture } from './testFixtures';

const route = `/signage/groups/${ids.group}`;
const member = displayFixture({ groupId: ids.group, defaultScenes: [] });
const pending = [
  { kind: 'scene' as const, name: 'Open days poster', change: 'modified' as const },
  { kind: 'rule' as const, name: '', change: 'added' as const },
];

describe('Group detail', () => {
  it('shows the group rules from the group endpoints and the pending changes', async () => {
    mockSignage([PermissionId.signageread], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id], pendingChanges: pending })],
      groupRules: [ruleFixture()],
    });
    renderRoute(<App />, route);
    expect(await screen.findByRole('heading', { name: 'Hallway screens' })).toBeInTheDocument();
    expect(await screen.findByText('Mon–Fri 08:00–10:00')).toBeInTheDocument();
    expect(screen.getByText('2 unpublished changes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });

  it('publishes the group', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagepublish], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id], pendingChanges: pending })],
    });
    let published = 0;
    server.use(
      http.post('*/api/v1/signage/groups/:id/publish', () => {
        published += 1;
        return HttpResponse.json(groupFixture({ displayIds: [member.id] }));
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Publish 2 changes' }));
    await waitFor(() => expect(published).toBe(1));
  });

  it('adds a rule with the group version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id] })],
    });
    let body: unknown;
    server.use(
      http.post('*/api/v1/signage/groups/:id/rules', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ items: [ruleFixture()], ownerVersion: 5 }, { status: 201 });
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Scene 1'), 'Open days poster');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: 4, conditionKind: 'time_window' }));
  });

  it('lists members and removes one so that it keeps a copy', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id] })],
    });
    let body: unknown;
    server.use(
      http.put('*/api/v1/signage/displays/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(displayFixture());
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    const table = await screen.findByRole('table', { name: 'Members' });
    expect(within(table).getByRole('link', { name: 'Entrance window' })).toHaveAttribute(
      'href',
      `/signage/displays/${ids.display}`,
    );
    await user.click(within(table).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/keeps a copy of the group’s rules and default scenes/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(body).toMatchObject({ expectedVersion: 5, groupId: null, defaultScenes: [], name: 'Entrance window' }),
    );
  });

  it('adds only standalone displays with the same aspect ratio', async () => {
    const standalone = displayFixture({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a152', name: 'Workshop' });
    const landscape = displayFixture({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a153',
      name: 'Lounge',
      aspectRatio: { width: 16, height: 9 },
    });
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [member, standalone, landscape],
      groups: [groupFixture({ displayIds: [member.id] })],
    });
    let body: unknown;
    server.use(
      http.put('*/api/v1/signage/displays/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(displayFixture({ groupId: ids.group }));
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    await user.click(await screen.findByRole('button', { name: 'Add display' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^Workshop/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^Lounge/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^Entrance window/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/^Workshop/));
    await user.click(within(dialog).getByRole('button', { name: 'Add 1 display' }));
    await waitFor(() => expect(body).toMatchObject({ groupId: ids.group, defaultScenes: [], expectedVersion: 5 }));
  });

  it('explains which displays block deleting a group', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id] })],
    });
    server.use(
      http.delete('*/api/v1/signage/groups/:id', () =>
        HttpResponse.json(
          {
            code: 'signage_in_use',
            message: 'In use',
            details: { references: [{ kind: 'display', id: ids.display, name: 'Entrance window' }] },
          },
          { status: 409 },
        ),
      ),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Group actions' }));
    await user.click(await screen.findByText('Delete', { selector: '.cds--overflow-menu-options__option-content' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Group is still in use')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrance window' })).toBeInTheDocument();
  });

  it('keeps the aspect ratio read-only while the group has members', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [member],
      groups: [groupFixture({ displayIds: [member.id] })],
    });
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(await screen.findByLabelText('Aspect ratio')).toHaveAttribute('readonly');
    expect(screen.getByText(/only be changed while the group has no members/)).toBeInTheDocument();
  });
});
