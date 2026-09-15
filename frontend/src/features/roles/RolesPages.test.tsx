import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CreateRoleRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import {
  currentUserFixture,
  fixtureRoleId,
  roleFixture,
} from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const permissions = [
  {
    id: PermissionId.peoplereadall,
    description: 'Read every Person.',
  },
  {
    id: PermissionId.peopledelete,
    description: 'Delete a Person.',
  },
];

describe('Roles pages', () => {
  it('renders the Role table, type, permission count, and create action', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.rolesread,
            PermissionId.rolesmanage,
          ]),
        ),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({
          items: [
            roleFixture({ permissionGrants: [{permissionId:PermissionId.peoplereadall,scope:'everywhere',deviceTypeIds:[]}] }),
          ],
          nextCursor: null,
        }),
      ),
    );

    renderRoute(<App />, '/settings/roles');

    expect(
      await screen.findByRole('link', { name: 'Workshop supervisors' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Role/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Type/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create role' })).toBeInTheDocument();
  });

  it('moves from loading to the empty Role state', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.rolesread])),
      ),
      http.get('*/api/v1/roles', async () => {
        await delay(75);
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    renderRoute(<App />, '/settings/roles');

    expect(await screen.findByText('Loading roles')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'No roles found' }),
    ).toBeInTheDocument();
  });

  it('submits only permissions held by the actor when creating a Role', async () => {
    const actorPermissions = [
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ];
    const created = roleFixture({
      name: 'Supervisors',
      description: 'Limited oversight.',
      permissionGrants: [{permissionId:PermissionId.peoplereadall,scope:'everywhere',deviceTypeIds:[]}],
    });
    let submitted: CreateRoleRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture(actorPermissions)),
      ),
      http.get('*/api/v1/permissions', () =>
        HttpResponse.json({ items: permissions }),
      ),
      http.post('*/api/v1/roles', async ({ request }) => {
        submitted = (await request.json()) as CreateRoleRequest;
        return HttpResponse.json(created, { status: 201 });
      }),
      http.get(`*/api/v1/roles/${fixtureRoleId}`, () =>
        HttpResponse.json(created),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles/new');

    await user.type(await screen.findByLabelText('Role name'), '  Supervisors  ');
    await user.type(screen.getByLabelText('Description'), 'Limited oversight.');
    expect(screen.getByLabelText('people · delete')).toBeDisabled();
    await user.click(screen.getByLabelText('people · read · all'));
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() =>
      expect(submitted).toEqual({
        name: 'Supervisors',
        description: 'Limited oversight.',
        permissionGrants: [{permissionId:PermissionId.peoplereadall,scope:'everywhere',deviceTypeIds:[]}],
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Supervisors' }),
    ).toBeInTheDocument();
  });

  it('defaults a delegated permission to the actor device-type envelope', async () => {
    const receptionId = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const actor = currentUserFixture([
      PermissionId.rolesread,
      PermissionId.rolesmanage,
      PermissionId.peoplereadall,
    ]);
    actor.delegablePermissionGrants = [
      { permissionId: PermissionId.rolesread, scope: 'everywhere', deviceTypeIds: [] },
      { permissionId: PermissionId.rolesmanage, scope: 'everywhere', deviceTypeIds: [] },
      { permissionId: PermissionId.peoplereadall, scope: 'selectedDeviceTypes', deviceTypeIds: [receptionId] },
    ];
    let submitted: CreateRoleRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      http.get('*/api/v1/permissions', () => HttpResponse.json({ items: permissions })),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [{
        id: receptionId,
        name: 'Reception',
        description: null,
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }] })),
      http.post('*/api/v1/roles', async ({ request }) => {
        submitted = await request.json() as CreateRoleRequest;
        return HttpResponse.json(roleFixture({ name: 'Reception readers' }), { status: 201 });
      }),
      http.get('*/api/v1/roles/:roleId', () => HttpResponse.json(roleFixture({ name: 'Reception readers' }))),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/roles/new');

    await user.type(await screen.findByLabelText('Role name'), 'Reception readers');
    await user.click(screen.getByLabelText('people · read · all'));
    expect(screen.getByLabelText('Scope')).toHaveValue('selectedDeviceTypes');
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(submitted?.permissionGrants).toEqual([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [receptionId],
    }]));
  });
});
