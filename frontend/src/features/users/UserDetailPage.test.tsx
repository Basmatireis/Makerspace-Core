import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  Account,
  CreateAccountRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import {
  accountFixture,
  currentUserFixture,
  otherPersonId,
  personFixture,
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

    renderRoute(<App />, `/settings/users/${otherPersonId}`);

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit person' }));
    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('creates an Account and sends a recipient-owned invitation', async () => {
    let person = personFixture({ account: null });
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
            status: 'disabled',
            passwordStatus: 'not_set',
            authIdentities: [],
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
          return HttpResponse.json({ account, expiresAt: '2026-01-01T00:30:00Z' }, { status: 201 });
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/users/${otherPersonId}`);

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Create account' }));
    const createDialog = screen.getByRole('dialog');
    const loginEmail = within(createDialog).getByLabelText('Login email');
    await user.clear(loginEmail);
    await user.type(loginEmail, 'member@example.test');
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
    expect(within(accountSection as HTMLElement).getByText('member@example.test')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Send invitation' }));
    const invitationDialog = screen.getByRole('dialog');
    await user.click(within(invitationDialog).getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(invitationRequested).toBe(true));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
  });

  it('separates account, authentication, personal, role, and Makerspace information', async () => {
    const account = accountFixture({
      roles: [{
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a903',
        name: 'Workshop supervisors',
        systemKey: null,
      }],
      authIdentities: [
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a906',
          kind: 'password',
          displayIdentifier: 'grace.login@example.test',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a907',
          kind: 'pin',
          displayIdentifier: 'grace',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a908',
          kind: 'oidc',
          providerSlug: 'tugraz',
          displayIdentifier: 'Grace Hopper · TU Graz',
          verifiedAt: '2026-01-01T00:00:00Z',
          disabledAt: null,
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
            PermissionId.open_daysread_assignments,
            PermissionId.laborordnungrequestsread,
          ]),
        ),
      ),
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(personFixture({ account })),
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

    renderRoute(<App />, `/settings/users/${otherPersonId}`);

    const accountHeading = await screen.findByRole('heading', { name: 'Account access' });
    const authenticationHeading = screen.getByRole('heading', { name: 'Authentication methods' });
    expect(accountHeading).toBeInTheDocument();
    expect(authenticationHeading).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Personal information' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Profile picture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Roles' })).toBeInTheDocument();
    expect(within(accountHeading.closest('.person-detail-card') as HTMLElement).getByText('grace.login@example.test')).toBeInTheDocument();
    expect(within(authenticationHeading.closest('.person-detail-card') as HTMLElement).queryByText('grace.login@example.test')).not.toBeInTheDocument();
    expect(screen.getByText('Username: grace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper · TU Graz')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Makerspace status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lab Rules' })).toBeInTheDocument();
    expect(screen.getByText('Confirmation pending')).toBeInTheDocument();
    expect(screen.getByText('2026-09')).toBeInTheDocument();
    expect(screen.getByText('2025-09')).toBeInTheDocument();
    expect(screen.getByText('Autumn Open Days')).toBeInTheDocument();
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
  });
});
