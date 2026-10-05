import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CreateRoleRequest, ReplaceRolePermissionsRequest, UpdateRoleRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixtureRoleId, roleFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const permissions = [
  { id: PermissionId.peoplereadall, description: 'Read every person.' },
  { id: PermissionId.peopledelete, description: 'Delete a person.' },
  { id: PermissionId.rolesread, description: 'Read roles.' },
  { id: PermissionId.rolesmanage, description: 'Manage roles.' },
  { id: PermissionId.auditread, description: 'Read audit events.' },
];

function matrixHandlers(role = roleFixture()) {
  return [
    http.get('*/api/v1/roles', () => HttpResponse.json({ items: [role], nextCursor: null })),
    http.get('*/api/v1/permissions', () => HttpResponse.json({ items: permissions })),
  ];
}

describe('Roles and permissions matrix', () => {
  it('stages and reviews a permission change without dropping other grants', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const role = roleFixture({ permissionGrants: [
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a910', permissionId: PermissionId.peoplereadall, scope: 'anyManagedDevice', deviceTypeIds: [], minimumAssurance: 'normal' },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a911', permissionId: PermissionId.rolesread, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
    ] });
    let submitted: ReplaceRolePermissionsRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
      http.put('*/api/v1/roles/:roleId/permissions', async ({ request }) => {
        submitted = await request.json() as ReplaceRolePermissionsRequest;
        return HttpResponse.json({ ...role, version: 2, permissionGrants: submitted.permissionGrants });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    const heading = await screen.findByRole('heading', { name: 'Roles & Permissions' });
    expect(heading.closest('[data-page-shell]')).toHaveAttribute('data-page-width', 'fluid');
    expect(screen.getByRole('button', { name: /Edit View all people for Workshop supervisors: Normal assurance · Any managed device/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Edit View all people for Workshop supervisors/ }));
    expect(screen.getByRole('heading', { name: 'View all people' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Minimum authentication assurance'), 'strong');
    expect(screen.getByLabelText('Modified in draft')).toBeInTheDocument();
    expect(submitted).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const review = screen.getByRole('dialog', { name: 'Review permission changes for Workshop supervisors' });
    expect(within(review).getByText('changed')).toBeInTheDocument();
    expect(within(review).getByText('View all people')).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Save role permissions' }));

    await waitFor(() => expect(submitted).toEqual({
      expectedVersion: 1,
      permissionGrants: expect.arrayContaining([
        expect.objectContaining({ permissionId: PermissionId.rolesread }),
        expect.objectContaining({ permissionId: PermissionId.peoplereadall, minimumAssurance: 'strong' }),
      ]),
    }));
    expect(submitted?.permissionGrants.every((grant) => !('id' in grant))).toBe(true);
  }, 30_000);

  it('collapses logical permission groups', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.rolesread]))),
      ...matrixHandlers(roleFixture()),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    const peopleGroup = (await screen.findByText('People')).closest('button');
    expect(peopleGroup).not.toBeNull();
    if (!peopleGroup) throw new Error('People group button not found');
    await user.click(peopleGroup);
    expect(peopleGroup).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('View all people')).not.toBeInTheDocument();
  });

  it('changes access directly from the three-state permission control', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
    ]);
    const role = roleFixture();
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    expect(await screen.findByRole('heading', { name: 'Select a permission' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View details for Manage roles' }));
    expect(screen.getByRole('heading', { name: 'Manage roles' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop editing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Permission enabled' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Set Manage roles for Workshop supervisors to Unconditional' }));
    expect(screen.getByRole('button', { name: /Edit Manage roles for Workshop supervisors: Granted without additional conditions/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Set View roles for Workshop supervisors to Unconditional' }));

    expect(screen.getAllByLabelText('Modified in draft')).toHaveLength(2);
    expect(screen.getAllByLabelText('Modified in draft').every((marker) =>
      marker.closest('.roles-matrix__permission-column') !== null)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const review = screen.getByRole('dialog', { name: 'Review permission changes for Workshop supervisors' });
    expect(within(review).getByText('Manage roles')).toBeInTheDocument();
    expect(within(review).getByText('View roles')).toBeInTheDocument();
  });

  it('provides compact permission search and filter controls in the shared toolbar', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.rolesread, PermissionId.rolesmanage]))),
      ...matrixHandlers(roleFixture()),
    );
    renderRoute(<App />, '/settings/roles');

    expect(await screen.findByRole('button', { name: 'Create role' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review and save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument();
    const searchbox = screen.getByRole('searchbox', { name: 'Search permissions' });
    expect(screen.queryByText('All permission groups')).not.toBeInTheDocument();

    await user.type(searchbox, 'delete');
    expect(screen.getByRole('button', { name: 'View details for Delete people' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View details for View all people' })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Filter permissions' })).toBeInTheDocument();
  });

  it('saves multiple staged permission changes in one atomic request', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const role = roleFixture({ permissionGrants: [
      { permissionId: PermissionId.peoplereadall, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
    ] });
    let submitted: ReplaceRolePermissionsRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
      http.put('*/api/v1/roles/:roleId/permissions', async ({ request }) => {
        submitted = await request.json() as ReplaceRolePermissionsRequest;
        return HttpResponse.json({ ...role, version: 2, permissionGrants: submitted.permissionGrants });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    await user.click(await screen.findByRole('button', { name: /Edit View all people for Workshop supervisors/ }));
    await user.selectOptions(screen.getByLabelText('Minimum authentication assurance'), 'normal');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Set Manage roles for Workshop supervisors to Unconditional' }));
    expect(screen.getAllByLabelText('Modified in draft')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    const review = screen.getByRole('dialog', { name: 'Review permission changes for Workshop supervisors' });
    expect(within(review).getByText('View all people')).toBeInTheDocument();
    expect(within(review).getByText('Manage roles')).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Save role permissions' }));

    await waitFor(() => expect(submitted).toEqual({
      expectedVersion: role.version,
      permissionGrants: expect.arrayContaining([
        expect.objectContaining({ permissionId: PermissionId.peoplereadall, minimumAssurance: 'normal' }),
        expect.objectContaining({ permissionId: PermissionId.rolesmanage }),
      ]),
    }));
  }, 30_000);

  it('creates a role from copied permissions through the legacy new-role URL', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const source = roleFixture({ permissionGrants: [
      { permissionId: PermissionId.peoplereadall, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
    ] });
    let submitted: CreateRoleRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(source),
      http.post('*/api/v1/roles', async ({ request }) => {
        submitted = await request.json() as CreateRoleRequest;
        return HttpResponse.json(roleFixture({ name: submitted.name }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles/new');

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Role name'), 'Reception team');
    await user.selectOptions(within(dialog).getByLabelText('Copy permissions from (optional)'), fixtureRoleId);
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(submitted).toEqual({
      name: 'Reception team',
      description: null,
      permissionGrants: source.permissionGrants,
      profileImageRequired: false,
      laborordnungMode: 'not_required',
      supervisorDashboard: false,
    }));
  });

  it('keeps a stale role draft and offers an explicit discard-and-reload action', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const role = roleFixture({ permissionGrants: [
      { permissionId: PermissionId.peoplereadall, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
    ] });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
      http.put('*/api/v1/roles/:roleId/permissions', () => HttpResponse.json({ code: 'stale_write', message: 'Resource changed' }, { status: 409 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    await user.click(await screen.findByRole('button', { name: /Edit View all people for Workshop supervisors/ }));
    await user.selectOptions(screen.getByLabelText('Minimum authentication assurance'), 'normal');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(screen.getByRole('button', { name: 'Save role permissions' }));
    expect(await screen.findByText('Role changed before this draft was saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard draft and reload' })).toBeInTheDocument();
    expect(screen.getByLabelText('Modified in draft')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'View all people' })).toBeInTheDocument();
  });

  it('blocks route navigation while a permission draft has unsaved changes', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const role = roleFixture({ permissionGrants: [
      { permissionId: PermissionId.peoplereadall, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
    ] });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/settings/roles');

    await user.click(await screen.findByRole('button', { name: /Edit View all people for Workshop supervisors/ }));
    await user.selectOptions(screen.getByLabelText('Minimum authentication assurance'), 'normal');
    void router.navigate('/dashboard');

    const leaveDialog = await screen.findByRole('dialog', { name: 'Leave without saving role changes?' });
    await user.click(within(leaveDialog).getByRole('button', { name: 'Stay on this page' }));
    expect(screen.getByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument();
    expect(screen.getByLabelText('Modified in draft')).toBeInTheDocument();
  });

  it('omits the effective-permissions view, evaluator, and legend', async () => {
    const role = roleFixture();
    let evaluationRequests = 0;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.rolesread]))),
      ...matrixHandlers(role),
      http.get('*/api/v1/roles/effective-permissions', () => {
        evaluationRequests += 1;
        return HttpResponse.json({ items: [] });
      }),
    );
    renderRoute(<App />, '/settings/roles');

    expect(await screen.findByText('View all people')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Effective permissions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Legend:')).not.toBeInTheDocument();
    expect(evaluationRequests).toBe(0);
  });

  it('opens role settings from a compatible role URL and preserves its optimistic version', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    const role = roleFixture();
    let submitted: UpdateRoleRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
      http.patch('*/api/v1/roles/:roleId', async ({ request }) => {
        submitted = await request.json() as UpdateRoleRequest;
        return HttpResponse.json({ ...role, ...submitted, version: 2 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/roles/${role.id}`);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit role' })).toBeInTheDocument();
    const name = within(dialog).getByLabelText('Role name');
    await user.clear(name);
    await user.type(name, 'Workshop coordinators');
    await user.click(within(dialog).getByRole('button', { name: 'Save role' }));

    await waitFor(() => expect(submitted).toEqual(expect.objectContaining({
      expectedVersion: role.version,
      name: 'Workshop coordinators',
      profileImageRequired: role.profileImageRequired,
      laborordnungMode: role.laborordnungMode,
      supervisorDashboard: role.supervisorDashboard,
    })));
  });

  it('disables rule choices outside the administrator delegation envelope', async () => {
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    actor.delegablePermissionGrants = [
      { permissionId: PermissionId.peoplereadall, scope: 'anyManagedDevice', deviceTypeIds: [], minimumAssurance: 'normal' },
      ...actor.delegablePermissionGrants.filter((grant) => grant.permissionId !== PermissionId.peoplereadall),
    ];
    const role = roleFixture({ permissionGrants: [
      { permissionId: PermissionId.peoplereadall, scope: 'anyManagedDevice', deviceTypeIds: [], minimumAssurance: 'normal' },
    ] });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      ...matrixHandlers(role),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles');

    const cell = await screen.findByRole('button', { name: /Edit View all people for Workshop supervisors/ });
    cell.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('option', { name: 'Low' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Everywhere' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Normal' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Any managed device' })).toBeEnabled();
  });
});
