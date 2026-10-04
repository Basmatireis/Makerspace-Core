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

describe('Directory page', () => {
  it('redirects the legacy directory URL and preserves its filters', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(peoplePage([])),
      ),
    );

    const { router } = renderRoute(<App />, '/settings/users?search=Ada&page=2');

    expect(await screen.findByRole('heading', { name: 'Directory' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/people');
    expect(router.state.location.search).toBe('?search=Ada&page=2');
  });

  it('renders permitted table columns and actions', async () => {
    const supervisorRole = roleFixture({ supervisorDashboard: true });
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.peoplecreate,
            PermissionId.peoplereadmatriculation,
            PermissionId.accountsread,
            PermissionId.rolesread,
            PermissionId.laborordnungrequestsread,
            PermissionId.supervisor_dashboardread,
          ]),
        ),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [supervisorRole], nextCursor: null }),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          peoplePage([
            personFixture({
              matriculationNumber: 'M-0042',
              account: accountFixture(), roles: [supervisorRole],
              profileImage: {
                fileId: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
                source: 'admin_upload',
                downloadUrl: `/api/v1/people/${otherPersonId}/profile-image`,
              },
            }),
          ]),
        ),
      ),
      http.get(`*/api/v1/people/${otherPersonId}/makerspace-status`, () =>
        HttpResponse.json({
          laborordnungStatus: {
            mode: 'warning',
            state: 'current',
            actionRequired: false,
            currentVersion: null,
            latestConfirmedVersion: null,
            requestId: null,
          },
        }),
      ),
    );

    renderRoute(<App />, '/people');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/people');
    const addPersonButton = screen.getByRole('button', { name: 'Add person' });
    expect(addPersonButton).toBeInTheDocument();
    expect(screen.getByLabelText('Directory table toolbar')).toContainElement(
      addPersonButton,
    );
    const statusHeader = screen.getByRole('columnheader', { name: /Status/ });
    const rolesHeader = screen.getByRole('columnheader', { name: /Roles/ });
    const labRulesHeader = screen.getByRole('columnheader', { name: /Lab Rules/ });
    expect(statusHeader).toHaveClass('people-table__status-column');
    expect(rolesHeader).toBeInTheDocument();
    expect(labRulesHeader).toBeInTheDocument();
    expect(rolesHeader.compareDocumentPosition(labRulesHeader)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(labRulesHeader.compareDocumentPosition(statusHeader)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByRole('columnheader', { name: /Matriculation number/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Supervisor' })).not.toBeInTheDocument();
    expect(screen.queryByText('M-0042')).not.toBeInTheDocument();
    const personRow = screen.getByRole('row', { name: /Grace Hopper/ });
    expect(within(personRow).getByText('Active').closest('td')).toHaveClass('people-table__status-column');
    const supervisorRoleTag = screen.getByText('Workshop supervisors').closest('.cds--tag');
    expect(supervisorRoleTag).toHaveClass('cds--tag--blue');
    expect(supervisorRoleTag).toHaveAttribute('aria-label', 'Workshop supervisors, supervisor role');
    expect((await screen.findByText('Current')).closest('.cds--tag')).toHaveClass(
      'cds--tag--green',
    );
    expect(screen.getAllByRole('columnheader').at(-1)).toHaveTextContent('Status');
    const filtersButton = screen.getByRole('button', { name: 'Filters' });
    expect(filtersButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(filtersButton);
    const filters = screen.getByRole('region', { name: 'Directory filters' });
    expect(filtersButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(filters).getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    expect(within(filters).getByRole('combobox', { name: 'Lab Rules' })).toBeInTheDocument();
    expect(within(filters).getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    const membersButton = screen.getByRole('button', { name: 'Members' });
    const tableToolbar = screen.getByLabelText('Directory table toolbar');
    expect(tableToolbar).toContainElement(membersButton);
    expect(membersButton.querySelector('svg')).toBeInTheDocument();
    expect(membersButton).toBe(tableToolbar.querySelector('.cds--toolbar-content')?.lastElementChild);
    expect(document.querySelector('.people-table__avatar-cell img')).toHaveAttribute(
      'src',
      `/api/v1/people/${otherPersonId}/profile-image`,
    );
  });

  it('passes selected role, Lab Rules, and status filters to the people API', async () => {
    const secondRole = roleFixture({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
      name: 'Trainees',
    });
    let requestedRoleIds: string[] = [];
    let requestedAccountStatuses: string[] = [];
    let requestedLaborordnungStatuses: string[] = [];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.rolesread,
            PermissionId.laborordnungrequestsread,
          ]),
        ),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [roleFixture(), secondRole], nextCursor: null }),
      ),
      http.get('*/api/v1/people', ({ request }) => {
        const params = new URL(request.url).searchParams;
        requestedRoleIds = params.getAll('roleIds');
        requestedAccountStatuses = params.getAll('accountStatuses');
        requestedLaborordnungStatuses = params.getAll('laborordnungStatuses');
        return HttpResponse.json(peoplePage([]));
      }),
    );

    const { router } = renderRoute(
      <App />,
      `/people?role=${roleFixture().id}&role=${secondRole.id}&labRules=current&labRules=pending&status=enabled&status=no_account`,
    );
    const user = userEvent.setup();

    await waitFor(() =>
      expect(requestedRoleIds).toEqual([roleFixture().id, secondRole.id]),
    );
    expect(requestedAccountStatuses).toEqual(['enabled', 'no_account']);
    expect(requestedLaborordnungStatuses).toEqual(['current', 'pending']);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const filters = screen.getByRole('region', { name: 'Directory filters' });
    expect(within(filters).getAllByText('2', { selector: '.cds--tag__label' })).toHaveLength(3);

    await user.click(within(filters).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=1'));
  });

  it('keeps Person roles visible while omitting sensitive and Account columns', async () => {
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

    renderRoute(<App />, '/people');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Matriculation number/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Status/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Roles/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Lab Rules/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
  });

  it('creates selected email-less member accounts without a password identity', async () => {
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
        HttpResponse.json(peoplePage([personFixture({ account: null, email: null, phone: '+43 660 123456' })])),
      ),
      http.post('*/api/v1/people/:personId/account', async ({ request }) => {
        accountRequest = await request.json();
        return HttpResponse.json(accountFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/people');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select row/i }));
    await user.click(screen.getByRole('button', { name: 'Create accounts' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/This creates active accounts/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/without one, the person cannot sign in/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create accounts' }));

    await waitFor(() =>
      expect(accountRequest).toEqual({
        expectedVersion: 1,
      }),
    );
  });

  it('assigns an allowed role to selected people', async () => {
    let roleRequest: unknown;
    const role = roleFixture();
    const account = accountFixture();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.peoplerolesassign,
            PermissionId.rolesread,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(peoplePage([personFixture({ account, roles: [] })])),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [role], nextCursor: null }),
      ),
      http.put('*/api/v1/people/:personId/roles/:roleId', async ({ request }) => {
        roleRequest = await request.json();
        return HttpResponse.json(personFixture({ account, roles: [role] }));
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/people');

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

  it('permanently deletes selected accounts while retaining their people', async () => {
    const account = accountFixture();
    let accountDeleted = false;
    let deleteRequest: unknown;
    let deletedAccountId: string | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountsdelete,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          peoplePage([
            personFixture({ account: accountDeleted ? null : account }),
          ]),
        ),
      ),
      http.delete('*/api/v1/accounts/:accountId', async ({ params, request }) => {
        deletedAccountId = String(params.accountId);
        deleteRequest = await request.json();
        accountDeleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/people');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select row/i }));
    await user.click(screen.getByRole('button', { name: 'Delete accounts' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Delete accounts permanently?',
    });
    expect(within(dialog).getByText(/people records remain/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete accounts' }));

    await waitFor(() => {
      expect(deletedAccountId).toBe(account.id);
      expect(deleteRequest).toEqual({ expectedVersion: account.version });
    });
    expect(await screen.findByText('Accounts deleted')).toBeInTheDocument();
    expect(screen.getByText('No account')).toBeInTheDocument();
  });

  it('permanently deletes multiple selected people', async () => {
    const secondPersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a922';
    const account = accountFixture();
    let people = [
      personFixture({ account: null }),
      personFixture({
        id: secondPersonId,
        firstName: 'Katherine',
        lastName: 'Johnson',
        account,
      }),
    ];
    const deleteRequests = new Map<string, unknown>();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountsdelete,
            PermissionId.peopledelete,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(peoplePage(people)),
      ),
      http.delete('*/api/v1/people/:personId', async ({ params, request }) => {
        const personId = String(params.personId);
        deleteRequests.set(personId, await request.json());
        people = people.filter((person) => person.id !== personId);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/people');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: 'Delete people' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Delete people permanently?',
    });
    expect(within(dialog).getByText(/permanently deletes 2 selected people/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete people' }));

    await waitFor(() => expect(deleteRequests.size).toBe(2));
    expect(deleteRequests.get(otherPersonId)).toEqual({ expectedVersion: 1 });
    expect(deleteRequests.get(secondPersonId)).toEqual({ expectedVersion: 1 });
    expect(await screen.findByText('People deleted')).toBeInTheDocument();
  });

  it('skips people with accounts when account deletion is not permitted', async () => {
    const accountPersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a923';
    const deletedPersonIds: string[] = [];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.peopledelete,
          ]),
        ),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json(
          peoplePage([
            personFixture({ account: null }),
            personFixture({
              id: accountPersonId,
              firstName: 'Katherine',
              lastName: 'Johnson',
              account: accountFixture(),
            }),
          ]),
        ),
      ),
      http.delete('*/api/v1/people/:personId', ({ params }) => {
        deletedPersonIds.push(String(params.personId));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();

    renderRoute(<App />, '/people');

    await screen.findByText('Grace Hopper');
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: 'Delete people' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Delete people permanently?',
    });
    expect(within(dialog).getByText(/permanently deletes 1 selected person/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Some people will be skipped')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete people' }));

    await waitFor(() => expect(deletedPersonIds).toEqual([otherPersonId]));
    expect(await screen.findByText(/1 skipped because deleting their account is not permitted/i)).toBeInTheDocument();
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

    renderRoute(<App />, '/people');

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

    renderRoute(<App />, '/people');

    expect(await screen.findByText('Unable to load people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
