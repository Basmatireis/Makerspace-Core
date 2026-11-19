import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { UpdateWorkingGroupRequest, WorkingGroup, WorkingGroupSummary } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const printId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const woodId = '0192f6f8-743e-7c77-a349-cd07c3e8e002';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8e101';
const otherMachineId = '0192f6f8-743e-7c77-a349-cd07c3e8e102';

const lead = { personId: otherPersonId, displayName: 'Grace Hopper' };

const printGroup: WorkingGroup = {
  id: printId,
  name: 'Printing',
  description: 'Looks after the 3D printers.',
  lead,
  memberCount: 2,
  machineCount: 1,
  isMember: true,
  isLead: false,
  version: 4,
  chatUrl: 'https://chat.example.test/printing',
  members: [
    { personId: otherPersonId, displayName: 'Grace Hopper', isLead: true, joinedAt: '2026-01-01T00:00:00Z' },
    { personId: fixturePersonId, displayName: 'Ada Lovelace', isLead: false, joinedAt: '2026-01-02T00:00:00Z' },
  ],
  machines: [{ id: machineId, name: 'Prusa CORE One' }],
  places: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8e201', name: 'Filament shelf' }],
  columns: [],
  canEdit: false,
  canManage: false,
};
const woodGroup: WorkingGroup = {
  ...printGroup,
  id: woodId,
  name: 'Woodworking',
  description: '',
  lead: undefined,
  memberCount: 0,
  machineCount: 0,
  isMember: false,
  version: 1,
  chatUrl: undefined,
  members: [],
  machines: [],
  places: [],
};

const summary = (group: WorkingGroup): WorkingGroupSummary => ({
  id: group.id,
  name: group.name,
  description: group.description,
  lead: group.lead,
  memberCount: group.memberCount,
  machineCount: group.machineCount,
  isMember: group.isMember,
  isLead: group.isLead,
});

function serve(permissions: PermissionId[], groups: WorkingGroup[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: groups.map(summary) })),
    http.get('*/api/v1/working-groups/machines', () =>
      HttpResponse.json({
        items: [
          { id: machineId, name: 'Prusa CORE One', workingGroupId: printId, workingGroupName: 'Printing' },
          { id: otherMachineId, name: 'Table saw', workingGroupId: woodId, workingGroupName: 'Woodworking' },
          { id: '0192f6f8-743e-7c77-a349-cd07c3e8e103', name: 'Laser' },
        ],
      }),
    ),
    http.get('*/api/v1/working-groups/people', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-todos', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-notes', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-status', () => HttpResponse.json({ items: [] })),
    ...groups.map((group) => http.get(`*/api/v1/working-groups/${group.id}`, () => HttpResponse.json(group))),
  );
}

describe('working groups navigation', () => {
  it('shows the Overview item only with working_groups.read', async () => {
    serve([], [printGroup]);
    const { unmount } = renderRoute(<App />, '/dashboard');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Overview', hidden: true })).not.toBeInTheDocument();
    unmount();

    serve([PermissionId.working_groupsread], [printGroup]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByRole('link', { name: 'Overview', hidden: true })).toHaveAttribute(
      'href',
      '/working-groups',
    );
  });
});

describe('working groups overview', () => {
  it('lists the own group first with its people, machines and chat link', async () => {
    serve([PermissionId.working_groupsread], [woodGroup, printGroup]);
    renderRoute(<App />, '/working-groups');

    expect(await screen.findByRole('heading', { name: 'Printing' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Printing', 'Woodworking']);
    expect(screen.getByText('Looks after the 3D printers. You are a member.')).toBeInTheDocument();
    expect(await screen.findByText('Prusa CORE One')).toBeInTheDocument();
    expect(screen.getByText('Filament shelf')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Group pinboard' })).toBeInTheDocument();
    const people = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    const leadAt = people.findIndex((text) => text.startsWith('Grace Hopper'));
    expect(leadAt).toBeGreaterThanOrEqual(0);
    expect(leadAt).toBeLessThan(people.findIndex((text) => text.startsWith('Ada Lovelace')));
    expect(people[leadAt]).toContain('Group lead');
    const chat = screen.getByRole('link', { name: /Open the group chat/ });
    expect(chat).toHaveAttribute('href', 'https://chat.example.test/printing');
    expect(chat).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('hides the chat link when the API sends none and copes with a missing lead', async () => {
    serve([PermissionId.working_groupsread], [woodGroup]);
    renderRoute(<App />, '/working-groups');
    expect(await screen.findByRole('heading', { name: 'Woodworking' })).toBeInTheDocument();
    expect(await screen.findByText('This group has no members.')).toBeInTheDocument();
    expect(screen.queryByText('Group chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Group lead')).not.toBeInTheDocument();
  });

  it('offers setting up only to management when there are no groups', async () => {
    serve([PermissionId.working_groupsread], []);
    const { unmount } = renderRoute(<App />, '/working-groups');
    expect(await screen.findByText('No working groups yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up working groups' })).not.toBeInTheDocument();
    unmount();

    serve([PermissionId.working_groupsread, PermissionId.working_groupsmanage], []);
    renderRoute(<App />, '/working-groups');
    expect(await screen.findByRole('link', { name: 'Set up working groups' })).toHaveAttribute(
      'href',
      '/settings/working-groups',
    );
  });
});

describe('working groups settings', () => {
  const ledGroup: WorkingGroup = { ...printGroup, isLead: true, canEdit: true };

  it('shows a lead only their group with a read-only name and no management actions', async () => {
    serve([PermissionId.working_groupsread], [{ ...ledGroup }, woodGroup]);
    renderRoute(<App />, '/settings/working-groups');

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Printing');
    expect(name).toHaveAttribute('readonly');
    expect(screen.getByText('Only management renames a group.')).toBeInTheDocument();
    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual(['Printing']);
    expect(screen.queryByRole('button', { name: 'New working group' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete group' })).not.toBeInTheDocument();
    expect(screen.queryByText('Remove Grace Hopper')).not.toBeInTheDocument();
    // Icon-only buttons are named by their tooltip text.
    expect(await screen.findByText('Remove Ada Lovelace')).toBeInTheDocument();
  });

  it('shows no editor to someone who leads nothing', async () => {
    serve([PermissionId.working_groupsread], [printGroup]);
    renderRoute(<App />, '/settings/working-groups');
    expect(await screen.findByText('No group to edit')).toBeInTheDocument();
  });

  it('gives management New and Delete, and saves with the expected version', async () => {
    const user = userEvent.setup();
    let body: UpdateWorkingGroupRequest | undefined;
    serve(
      [PermissionId.working_groupsread, PermissionId.working_groupsmanage],
      [{ ...printGroup, canEdit: true, canManage: true }, woodGroup],
    );
    server.use(
      http.patch(`*/api/v1/working-groups/${printId}`, async ({ request }) => {
        body = (await request.json()) as UpdateWorkingGroupRequest;
        return HttpResponse.json({ ...printGroup, name: body.name ?? printGroup.name, version: 5 });
      }),
    );
    renderRoute(<App />, '/settings/working-groups');

    expect(await screen.findByRole('button', { name: 'New working group' })).toBeInTheDocument();
    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual(['Printing', 'Woodworking']);
    expect(await screen.findByRole('button', { name: 'Delete group' })).toBeInTheDocument();

    const name = await screen.findByLabelText('Name');
    expect(name).not.toHaveAttribute('readonly');
    await user.clear(name);
    await user.type(name, 'Printing lab');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        expectedVersion: 4,
        name: 'Printing lab',
        description: 'Looks after the 3D printers.',
        chatUrl: 'https://chat.example.test/printing',
      }),
    );
  });

  it('asks for confirmation naming the group before deleting', async () => {
    const user = userEvent.setup();
    serve(
      [PermissionId.working_groupsread, PermissionId.working_groupsmanage],
      [{ ...printGroup, canEdit: true, canManage: true }],
    );
    renderRoute(<App />, '/settings/working-groups');
    await user.click(await screen.findByRole('button', { name: 'Delete group' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Printing is deleted/)).toBeInTheDocument();
  });

  it('returns focus to the New button after cancelling the dialog', async () => {
    const user = userEvent.setup();
    serve([PermissionId.working_groupsread, PermissionId.working_groupsmanage], [woodGroup]);
    renderRoute(<App />, '/settings/working-groups');
    const open = await screen.findByRole('button', { name: 'New working group' });
    await user.click(open);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('shows the conflict when a machine belongs to another group', async () => {
    const user = userEvent.setup();
    let machineIds: string[] | undefined;
    serve([PermissionId.working_groupsread], [ledGroup]);
    server.use(
      http.put(`*/api/v1/working-groups/${printId}/machines`, async ({ request }) => {
        machineIds = ((await request.json()) as { machineIds: string[] }).machineIds;
        return HttpResponse.json(
          {
            code: 'machine_in_other_working_group',
            message: 'The machine belongs to another working group.',
            details: { machineId: otherMachineId },
          },
          { status: 409 },
        );
      }),
    );
    renderRoute(<App />, '/settings/working-groups');

    await user.click(await screen.findByRole('button', { name: 'Save machines' }));
    await waitFor(() => expect(machineIds).toEqual([machineId]));
    expect(await screen.findByText(/already belongs to another working group/)).toBeInTheDocument();
  });
});
