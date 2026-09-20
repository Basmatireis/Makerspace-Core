import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import {
  accountFixture,
  currentUserFixture,
  otherPersonId,
  personFixture,
  roleFixture,
} from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

function peoplePage(items: ReturnType<typeof personFixture>[]) {
  return { items, page: 1, pageSize: 25, total: items.length };
}

describe('People page', () => {
  it('renders permitted table columns and actions', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.peoplecreate,
            PermissionId.peoplereadmatriculation,
            PermissionId.accountsread,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          peoplePage([
            personFixture({
              matriculationNumber: 'M-0042',
              account: accountFixture({ roles: [roleFixture()] }),
              profileImage: {
                fileId: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
                source: 'admin_upload',
                downloadUrl: `/api/v1/people/${otherPersonId}/profile-image`,
              },
            }),
          ]),
        ),
      ),
    );

    renderRoute(<App />, '/settings/users');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    const breadcrumbs = screen.getByLabelText('Breadcrumb');
    expect(within(breadcrumbs).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(breadcrumbs).getByText('People')).toBeInTheDocument();
    const addPersonButton = screen.getByRole('button', { name: 'Add person' });
    expect(addPersonButton).toBeInTheDocument();
    expect(screen.getByLabelText('People table toolbar')).toContainElement(
      addPersonButton,
    );
    expect(
      screen.getByRole('columnheader', { name: /Matriculation number/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Account/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Roles/ })).toBeInTheDocument();
    expect(screen.getByText('M-0042')).toBeInTheDocument();
    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(screen.getByText('Workshop supervisors')).toBeInTheDocument();
    expect(document.querySelector('.people-table__avatar-cell img')).toHaveAttribute(
      'src',
      `/api/v1/people/${otherPersonId}/profile-image`,
    );
  });

  it('passes all selected role filters to the people API', async () => {
    const secondRole = roleFixture({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
      name: 'Trainees',
    });
    let requestedRoleIds: string[] = [];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.rolesread,
          ]),
        ),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [roleFixture(), secondRole], nextCursor: null }),
      ),
      http.get('*/api/v1/people', ({ request }) => {
        requestedRoleIds = new URL(request.url).searchParams.getAll('roleIds');
        return HttpResponse.json(peoplePage([]));
      }),
    );

    renderRoute(
      <App />,
      `/settings/users?role=${roleFixture().id}&role=${secondRole.id}`,
    );

    expect(
      await screen.findByRole('combobox', { name: /Filter by role/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(requestedRoleIds).toEqual([roleFixture().id, secondRole.id]),
    );
  });

  it('omits sensitive and account columns when the actor lacks permission', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          peoplePage([
            personFixture({
              matriculationNumber: undefined,
              account: undefined,
            }),
          ]),
        ),
      ),
    );

    renderRoute(<App />, '/settings/users');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Matriculation number/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Account/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument();
  });

  it('creates selected member accounts using their existing email addresses', async () => {
    let accountRequest: unknown;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountscreate,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(peoplePage([personFixture({ account: null })])),
      ),
      http.post('*/api/v1/people/:personId/account', async ({ request }) => {
        accountRequest = await request.json();
        return HttpResponse.json(accountFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/settings/users');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select row/i }));
    await user.click(screen.getByRole('button', { name: 'Create accounts' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/existing email address/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create accounts' }));

    await waitFor(() =>
      expect(accountRequest).toEqual({
        loginEmail: 'grace@example.test',
        expectedVersion: 1,
      }),
    );
  });

  it('assigns an allowed role to selected member accounts', async () => {
    let roleRequest: unknown;
    const role = roleFixture();
    const account = accountFixture({ roles: [] });
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountsrolesassign,
            PermissionId.rolesread,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(peoplePage([personFixture({ account })])),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [role], nextCursor: null }),
      ),
      http.put('*/api/v1/accounts/:accountId/roles/:roleId', async ({ request }) => {
        roleRequest = await request.json();
        return HttpResponse.json({ ...account, roles: [role] });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/settings/users');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select row/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assign role' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Assign role' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByText('Workshop supervisors'));
    await user.click(within(dialog).getByRole('button', { name: 'Assign role' }));

    await waitFor(() => expect(roleRequest).toEqual({ expectedVersion: 1 }));
  });

  it('moves from the loading state to the empty state', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
      http.get('*/api/v1/people', async () => {
        await delay(75);
        return HttpResponse.json(peoplePage([]));
      }),
    );

    renderRoute(<App />, '/settings/users');

    expect(await screen.findByText('Loading people')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No people found' })).toBeInTheDocument();
    expect(screen.getByText('No people have been added yet.')).toBeInTheDocument();
  });

  it('shows a retryable error state', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          { code: 'server_error', message: 'Unavailable' },
          { status: 500 },
        ),
      ),
    );

    renderRoute(<App />, '/settings/users');

    expect(await screen.findByText('Unable to load people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
