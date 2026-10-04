import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  Account,
  CreateAccountRequest,
  SetAccountPinRequest,
} from '../../api/generated/models';
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

describe('User detail page', () => {
  it('starts person editing from the page header action', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.peopleupdateall,
          ]),
        ),
      ),
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(personFixture()),
      ),
    );
    const user = userEvent.setup();

    const { router } = renderRoute(<App />, `/people/${otherPersonId}`);

    const actions = await screen.findByRole('button', { name: 'Actions' });
    const shell = actions.closest('[data-page-shell]');
    expect(shell).toHaveAttribute('data-page-width', 'standard');
    expect(shell?.querySelector('.page-header__tabs')).toContainElement(
      screen.getByRole('tablist', { name: 'Person detail sections' }),
    );
    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Edit person' }));
    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Grace Hopper')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=personal-information');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows a recipient-owned invitation link in a modal when contact email is missing', async () => {
    let person = personFixture({ account: null, email: null });
    let account: Account | undefined;
    let accountRequest: CreateAccountRequest | undefined;
    let invitationRequested = false;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountscreate,
            PermissionId.accountspasswordenrollall,
          ]),
        ),
      ),
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(person),
      ),
      http.post(
        `*/api/v1/people/${otherPersonId}/account`,
        async ({ request }) => {
          accountRequest = (await request.json()) as CreateAccountRequest;
          account = accountFixture({
            loginEmail: accountRequest.loginEmail,
            status: 'enabled',
            passwordStatus: 'not_set',
            authIdentities: [{
              id: '0192f6f8-743e-7c77-a349-cd07c3e8a909',
              kind: 'password',
              displayIdentifier: String(accountRequest.loginEmail),
              verifiedAt: null,
              disabledAt: null,
              usable: false,
              createdAt: '2026-01-01T00:00:00Z',
            }],
          });
          person = { ...person, account };
          return HttpResponse.json(account, { status: 201 });
        },
      ),
      http.get('*/api/v1/accounts/:accountId', () =>
        account
          ? HttpResponse.json(account)
          : HttpResponse.json({ code: 'not_found', message: 'Missing' }, { status: 404 }),
      ),
      http.post(
        '*/api/v1/accounts/:accountId/invitations',
        async () => {
          invitationRequested = true;
          account = { ...account!, provisioningSource: 'invitation', version: 2 };
          person = { ...person, account };
          return HttpResponse.json({
            account,
            expiresAt: '2026-01-01T00:30:00Z',
            deliveryStatus: 'manual',
            setupUrl: '/complete-invitation#account=example&code=secret',
          }, { status: 201 });
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}`);

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Create account' }));
    const createDialog = screen.getByRole('dialog');
    const loginEmail = within(createDialog).getByLabelText('Password login email (optional)');
    await user.clear(loginEmail);
    await user.type(loginEmail, '  member@example.test  ');
    await user.click(
      within(createDialog).getByRole('button', { name: 'Create account' }),
    );

    await waitFor(() =>
      expect(accountRequest).toEqual({
        loginEmail: 'member@example.test',
        expectedVersion: 1,
      }),
    );
    const accountSection = (await screen.findByRole('heading', { name: 'Account access' }))
      .closest('.person-detail-card');
    expect(accountSection).toBeInstanceOf(HTMLElement);
    expect(within(accountSection as HTMLElement).queryByText('member@example.test')).not.toBeInTheDocument();
    const authenticationSection = screen.getByRole('heading', { name: 'Authentication methods' }).closest('.person-detail-card');
    expect(within(authenticationSection as HTMLElement).getByText('member@example.test')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Send invitation' }));
    const invitationDialog = screen.getByRole('dialog');
    await user.click(within(invitationDialog).getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(invitationRequested).toBe(true));
    const manualLinkDialog = await screen.findByRole('dialog', { name: 'Manual setup link created' });
    expect(within(manualLinkDialog).getByLabelText('One-time setup link')).toHaveValue(
      `${window.location.origin}/complete-invitation#account=example&code=secret`,
    );
    await user.click(within(manualLinkDialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('One-time setup link')).not.toBeInTheDocument());
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('creates an Account without an authentication identity for %s login email input', async (_case, input) => {
    let person = personFixture({ account: null });
    let accountRequest: CreateAccountRequest | undefined;
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
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(person),
      ),
      http.post(
        `*/api/v1/people/${otherPersonId}/account`,
        async ({ request }) => {
          accountRequest = (await request.json()) as CreateAccountRequest;
          const account = accountFixture({
            loginEmail: null,
            status: 'enabled',
            passwordStatus: 'not_set',
            authIdentities: [],
          });
          person = { ...person, account };
          return HttpResponse.json(account, { status: 201 });
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}`);

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Create account' }));
    const createDialog = screen.getByRole('dialog');
    expect(within(createDialog).getByText('Create an active application account for this person. Authentication methods can be configured afterwards; without one, the person cannot sign in.')).toBeInTheDocument();
    const loginEmail = within(createDialog).getByLabelText('Password login email (optional)');
    expect(loginEmail).toHaveValue('');
    if (input) await user.type(loginEmail, input);
    await user.click(within(createDialog).getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(accountRequest).toEqual({
      loginEmail: null,
      expectedVersion: 1,
    }));
  });

  it('activates an identity-free Account and shows missing login methods separately', async () => {
    let account = accountFixture({
      loginEmail: null,
      status: 'disabled',
      passwordStatus: 'not_set',
      authIdentities: [],
    });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.accountsread,
        PermissionId.accountsenable,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account }))),
      http.post('*/api/v1/accounts/:accountId/enable', () => {
        account = { ...account, status: 'enabled', version: account.version + 1 };
        return HttpResponse.json(account);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=account-access`);

    const activateButton = await screen.findByRole('button', { name: 'Activate account' });
    expect(activateButton).toBeEnabled();
    expect(screen.getByText('No login methods')).toBeInTheDocument();
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0);
    await user.click(activateButton);
    await waitFor(() => expect(screen.getAllByText('Active').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Activate account' })).not.toBeInTheDocument();
    expect(screen.getByText('No login methods')).toBeInTheDocument();
    expect(screen.queryByText(/local login email/i)).not.toBeInTheDocument();
  });

  it('keeps activation available when a usable PIN method exists', async () => {
    const account = accountFixture({
      loginEmail: null,
      status: 'disabled',
      passwordStatus: 'not_set',
      authIdentities: [{
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
        kind: 'pin',
        displayIdentifier: 'phone.only',
        verifiedAt: '2026-01-01T00:00:00Z',
        disabledAt: null,
        usable: true,
        createdAt: '2026-01-01T00:00:00Z',
      }],
    });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.accountsread,
        PermissionId.accountsenable,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account }))),
    );
    renderRoute(<App />, `/people/${otherPersonId}?tab=account-access`);

    expect(await screen.findByText('Username: phone.only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate account' })).toBeEnabled();
    expect(screen.queryByText('No login methods')).not.toBeInTheDocument();
  });

  it('removes an authentication method without changing the account lifecycle state', async () => {
    let account = accountFixture();
    let person = personFixture({ account });
    let removedIdentityId: string | undefined;
    let removalBody: unknown;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.accountsread,
        PermissionId.accountspasswordremoveall,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(person)),
      http.delete('*/api/v1/accounts/:accountId/auth-identities/:identityId', async ({ params, request }) => {
        removedIdentityId = String(params.identityId);
        removalBody = await request.json();
        account = {
          ...account,
          loginEmail: null,
          passwordStatus: 'not_set',
          authIdentities: account.authIdentities.filter((identity) => identity.id !== removedIdentityId),
          version: account.version + 1,
        };
        person = { ...person, account };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=account-access`);

    await user.click(await screen.findByRole('button', { name: 'Actions for Local password' }));
    await user.click(await screen.findByText('Remove password method'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove local password?')).toBeInTheDocument();
    expect(within(dialog).getByText(/account remains active or inactive independently/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove method' }));

    await waitFor(() => expect(removedIdentityId).toBe('0192f6f8-743e-7c77-a349-cd07c3e8a906'));
    expect(removalBody).toEqual({ expectedVersion: 1 });
    await waitFor(() => expect(screen.queryByText('grace.login@example.test')).not.toBeInTheDocument());
    expect(screen.getByText('No login methods')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });

  it('validates and submits direct PIN setup while preserving the setup-link alternative', async () => {
    const account = accountFixture({
      loginEmail: null,
      status: 'disabled',
      passwordStatus: 'not_set',
      authIdentities: [],
    });
    let pinRequest: SetAccountPinRequest | undefined;
    let setupLinkRequested = false;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.accountsread,
        PermissionId.accountspinenrollall,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account }))),
      http.put('*/api/v1/accounts/:accountId/pin', async ({ request }) => {
        pinRequest = (await request.json()) as SetAccountPinRequest;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post('*/api/v1/accounts/:accountId/pin-enrollment', () => {
        setupLinkRequested = true;
        return HttpResponse.json({
          account: { ...account, version: 2 },
          expiresAt: '2026-01-01T00:30:00Z',
          deliveryStatus: 'manual',
          setupUrl: '/complete-pin-setup#account=example&code=secret',
        }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=account-access`);

    await user.click(await screen.findByRole('button', { name: 'Actions for Username and PIN' }));
    const addPINOptions = await screen.findAllByText('Add username and PIN');
    await user.click(addPINOptions.at(-1)!);
    const pinDialog = screen.getByRole('dialog');
    await user.type(within(pinDialog).getByLabelText('Username'), 'phone.only');
    await user.type(within(pinDialog).getByLabelText('PIN'), '123456');
    await user.type(within(pinDialog).getByLabelText('Confirm PIN'), '654321');
    await user.click(within(pinDialog).getByRole('button', { name: 'Set PIN login' }));
    expect(await within(pinDialog).findByText('The PINs do not match.')).toBeInTheDocument();
    await user.clear(within(pinDialog).getByLabelText('Confirm PIN'));
    await user.type(within(pinDialog).getByLabelText('Confirm PIN'), '123456');
    await user.click(within(pinDialog).getByRole('button', { name: 'Set PIN login' }));
    await waitFor(() => expect(pinRequest).toEqual({ loginName: 'phone.only', pin: '123456', expectedVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Actions for Username and PIN' }));
    await user.click(await screen.findByText('Create setup link instead'));
    const setupDialog = screen.getByRole('dialog');
    await user.click(within(setupDialog).getByRole('button', { name: 'Create PIN setup link' }));
    await waitFor(() => expect(setupLinkRequested).toBe(true));
    const manualLinkDialog = await screen.findByRole('dialog', { name: 'Manual setup link created' });
    expect(within(manualLinkDialog).getByLabelText('One-time setup link')).toHaveValue(
      `${window.location.origin}/complete-pin-setup#account=example&code=secret`,
    );
    await user.click(within(manualLinkDialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('One-time setup link')).not.toBeInTheDocument());
  });

  it('separates account, authentication, personal, role, and Makerspace information', async () => {
    const account = accountFixture({
      authIdentities: [
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a906',
          kind: 'password',
          displayIdentifier: 'grace.login@example.test',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          usable: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a907',
          kind: 'pin',
          displayIdentifier: 'grace',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          usable: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a908',
          kind: 'oidc',
          providerSlug: 'tugraz',
          displayIdentifier: 'Grace Hopper · TU Graz',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          usable: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.peoplereadmatriculation,
            PermissionId.accountsread,
            PermissionId.peoplerolesassign,
            PermissionId.rolesread,
            PermissionId.open_daysread_assignments,
            PermissionId.laborordnungrequestsread,
            PermissionId.supervisor_dashboardread,
          ]),
        ),
      ),
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({
          items: [roleFixture({ supervisorDashboard: true })],
          nextCursor: null,
        }),
      ),
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(personFixture({
          account,
          roles: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a903', name: 'Workshop supervisors', systemKey: null }],
        })),
      ),
      http.get(`*/api/v1/people/${otherPersonId}/makerspace-status`, () =>
        HttpResponse.json({
          upcomingOpenDayAssignments: [{
            assignmentId: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
            openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
            periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
            periodName: 'Autumn Open Days',
            startsAt: '2026-10-10T08:00:00Z',
            endsAt: '2026-10-10T12:00:00Z',
            role: 'supervisor',
          }, {
            assignmentId: '0192f6f8-743e-7c77-a349-cd07c3e8a938',
            openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a939',
            periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
            periodName: 'Winter Open Days',
            startsAt: '2026-12-05T09:00:00Z',
            endsAt: '2026-12-05T13:00:00Z',
            role: 'participant',
          }],
          laborordnungStatus: {
            mode: 'warning',
            state: 'outdated',
            actionRequired: true,
            currentVersion: {
              id: '0192f6f8-743e-7c77-a349-cd07c3e8a933',
              status: 'published',
              humanRevision: '2026-09',
              pdfFileId: '0192f6f8-743e-7c77-a349-cd07c3e8a934',
              sha256: 'a'.repeat(64),
              effectiveAt: '2026-09-01T00:00:00Z',
              publishedAt: '2026-08-20T00:00:00Z',
              createdAt: '2026-08-20T00:00:00Z',
            },
            latestConfirmedVersion: {
              id: '0192f6f8-743e-7c77-a349-cd07c3e8a935',
              status: 'published',
              humanRevision: '2025-09',
              pdfFileId: '0192f6f8-743e-7c77-a349-cd07c3e8a936',
              sha256: 'b'.repeat(64),
              effectiveAt: '2025-09-01T00:00:00Z',
              publishedAt: '2025-08-20T00:00:00Z',
              createdAt: '2025-08-20T00:00:00Z',
            },
            requestId: '0192f6f8-743e-7c77-a349-cd07c3e8a937',
          },
        }),
      ),
    );

    renderRoute(<App />, `/people/${otherPersonId}`);

    const accountHeading = await screen.findByRole('heading', { name: 'Account access' });
    const authenticationHeading = screen.getByRole('heading', { name: 'Authentication methods' });
    expect(accountHeading).toBeInTheDocument();
    expect(authenticationHeading).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Personal information' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Profile picture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Roles' })).toBeInTheDocument();
    expect(within(accountHeading.closest('.person-detail-card') as HTMLElement).queryByText('grace.login@example.test')).not.toBeInTheDocument();
    expect(within(authenticationHeading.closest('.person-detail-card') as HTMLElement).getByText('grace.login@example.test')).toBeInTheDocument();
    expect(screen.getByText('Username: grace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper · TU Graz')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Makerspace status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lab Rules' })).toBeInTheDocument();
    expect(screen.getByText('Confirmation pending')).toBeInTheDocument();
    expect(screen.getByText('2026-09')).toBeInTheDocument();
    expect(screen.getByText('2025-09')).toBeInTheDocument();
    expect(screen.getByText('Autumn Open Days')).toBeInTheDocument();
    expect(screen.getByText('Winter Open Days')).toBeInTheDocument();
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
    expect(screen.queryByText(/Included in supervisor staffing through/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Supervisor staffing' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage roles' })).toBeInTheDocument();
  });

  it('uses URL-backed focused tabs and preserves unrelated query parameters', async () => {
    const account = accountFixture();
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.peopleupdateall,
        PermissionId.peopleprofile_imageupdateall,
        PermissionId.accountsread,
        PermissionId.rolesread,
        PermissionId.open_daysread_assignments,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account }))),
      http.get('*/api/v1/roles', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(`*/api/v1/people/${otherPersonId}/makerspace-status`, () => HttpResponse.json({
        upcomingOpenDayAssignments: [],
      })),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(
      <App />,
      `/people/${otherPersonId}?tab=account-access&from=directory`,
    );

    expect(await screen.findByRole('tab', { name: 'Account access' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Authentication methods' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Profile picture' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Personal information' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=personal-information&from=directory'));
    const profileHeading = screen.getByRole('heading', { name: 'Profile picture' });
    const profileSection = profileHeading.closest('.person-detail-card') as HTMLElement;
    expect(within(profileSection).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Personal information' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Account access' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(router.state.location.search).toBe('?from=directory'));
    expect(screen.getByRole('heading', { name: 'Account access' })).toBeInTheDocument();
  });

  it('keeps Person roles visible while hiding Account-only tabs and normalizes an unauthorized deep link', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account: undefined }))),
    );
    const { router } = renderRoute(
      <App />,
      `/people/${otherPersonId}?tab=account-access&keep=1`,
    );

    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Personal information' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Account access' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Roles & permissions' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Makerspace status' })).not.toBeInTheDocument();
    expect(await screen.findByText('Account details unavailable')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe('?keep=1'));
  });

  it('copies the account ID and exposes only supported authentication action menus', async () => {
    const account = accountFixture({
      authIdentities: [
        ...accountFixture().authIdentities,
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a907',
          kind: 'pin',
          displayIdentifier: 'grace',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          usable: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a908',
          kind: 'oidc',
          providerSlug: 'tugraz',
          displayIdentifier: 'Grace Hopper · TU Graz',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          usable: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.peoplereadall,
        PermissionId.accountsread,
        PermissionId.accountspasswordreset,
        PermissionId.accountspasswordremoveall,
        PermissionId.accountspinreset,
        PermissionId.accountspinremoveall,
        PermissionId.identitiesoidcunlinkall,
      ]))),
      http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture({ account }))),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=account-access`);

    const copyButton = await screen.findByRole('button', { name: 'Copy account ID' });
    await user.click(copyButton);
    expect(await navigator.clipboard.readText()).toBe(account.id);

    expect(screen.getByRole('button', { name: 'Actions for Local password' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Username and PIN' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Grace Hopper · TU Graz' })).toBeInTheDocument();
  });
});
