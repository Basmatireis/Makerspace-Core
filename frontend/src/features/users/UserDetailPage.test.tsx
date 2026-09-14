import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  Account,
  CreateAccountRequest,
  SetAccountPasswordRequest,
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
  it('starts member editing from the page header action', async () => {
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
    await user.click(await screen.findByRole('menuitem', { name: 'Edit member' }));
    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('creates an Account and provisions its password through the security forms', async () => {
    let person = personFixture({ account: null });
    let account: Account | undefined;
    let accountRequest: CreateAccountRequest | undefined;
    let passwordRequest: SetAccountPasswordRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.accountsread,
            PermissionId.accountscreate,
            PermissionId.accountspasswordset,
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
      http.put(
        '*/api/v1/accounts/:accountId/password',
        async ({ request }) => {
          passwordRequest = (await request.json()) as SetAccountPasswordRequest;
          account = { ...account!, passwordStatus: 'active', version: 2 };
          person = { ...person, account };
          return HttpResponse.json(account);
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
    expect(
      await screen.findByText('member@example.test', { selector: 'p' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set password' }));
    const passwordDialog = screen.getByRole('dialog');
    await user.type(
      within(passwordDialog).getByLabelText('New password'),
      'Long workshop password 42',
    );
    await user.type(
      within(passwordDialog).getByLabelText('Confirm password'),
      'Long workshop password 42',
    );
    await user.click(
      within(passwordDialog).getByRole('button', { name: 'Set password' }),
    );

    await waitFor(() =>
      expect(passwordRequest).toEqual({
        newPassword: 'Long workshop password 42',
        expectedVersion: 1,
      }),
    );
    expect(await screen.findByText('active', { exact: true })).toBeInTheDocument();
  });
});
