import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type UpdatePersonRequest } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

describe('Profile page', () => {
  it('edits the current person with optimistic concurrency and refreshes the profile', async () => {
    let currentUser = currentUserFixture([
      PermissionId.peopleupdateself,
      PermissionId.peoplereadmatriculation,
      PermissionId.peopleupdatematriculation,
    ]);
    let submitted: UpdatePersonRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
      http.patch('*/api/v1/people/:personId', async ({ request }) => {
        submitted = (await request.json()) as UpdatePersonRequest;
        currentUser = {
          ...currentUser,
          person: {
            ...currentUser.person,
            firstName: submitted.firstName ?? currentUser.person.firstName,
            version: 2,
          },
        };
        return HttpResponse.json(currentUser.person);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile');

    const personalInformationCard = (await screen.findByRole('heading', { name: 'Personal information' }))
      .closest('.person-detail-card') as HTMLElement;
    await user.click(within(personalInformationCard).getByRole('button', { name: 'Edit' }));
    const firstName = screen.getByLabelText('First name');
    await user.clear(firstName);
    await user.type(firstName, 'Augusta');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(submitted).toEqual({ expectedVersion: 1, firstName: 'Augusta' }),
    );
    expect(
      await screen.findByRole('cell', { name: 'Augusta' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Matriculation number')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account access' })).toBeInTheDocument();
    expect(screen.queryByText('Login email')).not.toBeInTheDocument();
  });

  it('does not render the sensitive matriculation field without read permission', async () => {
    const currentUser = currentUserFixture([PermissionId.peopleupdateself]);
    currentUser.person.matriculationNumber = 'SECRET-42';
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
    );

    renderRoute(<App />, '/profile');

    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByText('Matriculation number')).not.toBeInTheDocument();
    expect(screen.queryByText('SECRET-42')).not.toBeInTheDocument();
  });

  it('uses the same profile-picture card action as the People detail page', async () => {
    const currentUser = currentUserFixture([
      PermissionId.peopleprofile_imageupdateself,
      PermissionId.peopleprofile_imageremoveself,
    ]);
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile');

    const profilePictureCard = (await screen.findByRole('heading', { name: 'Profile picture' }))
      .closest('.person-detail-card') as HTMLElement;
    await user.click(within(profilePictureCard).getByRole('button', { name: 'Edit' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit profile picture' });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByText('Drag an image here or click to upload')).not.toBeInTheDocument();
  });

  it('shows an active account without login methods as a valid separate state', async () => {
    const currentUser = currentUserFixture();
    currentUser.account.authIdentities = [];
    currentUser.account.loginEmail = null;
    currentUser.account.passwordStatus = 'not_set';
    currentUser.person.account = currentUser.account;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
    );

    renderRoute(<App />, '/profile');

    expect((await screen.findAllByText('Active')).length).toBeGreaterThan(0);
    expect(screen.getByText('No login methods')).toBeInTheDocument();
  });

  it('allows the only password method to be removed', async () => {
    const currentUser = currentUserFixture([PermissionId.accountspasswordremoveself]);
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
    );

    renderRoute(<App />, '/profile');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Local password' }));
    await user.click(await screen.findByText('Remove password method'));
    expect(screen.getByRole('dialog', { name: 'Remove password method' })).toBeInTheDocument();
  });
});

it('lets an OIDC-only account request reauthentication and link without a password', async () => {
  const current = currentUserFixture([PermissionId.identitiesoidclinkself]);
  current.account.passwordStatus = 'not_set';
  current.account.loginEmail = null;
  current.account.authIdentities = [{ id: current.account.id, kind: 'oidc', providerSlug: 'linked', displayIdentifier: 'Linked provider', verifiedAt: current.account.createdAt, disabledAt: null, usable: true, createdAt: current.account.createdAt }];
  let reauthenticated = false;
  let linkBody: unknown;
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(current)),
    http.get('*/api/v1/auth/oidc/providers', () => HttpResponse.json({ items: [{ slug: 'linked', displayName: 'Linked provider' }, { slug: 'another', displayName: 'Another provider' }] })),
    http.post('*/api/v1/auth/oidc/linked/reauthenticate', () => {
      reauthenticated = true;
      return HttpResponse.json({ code: 'oidc_provider_unavailable', message: 'Try again later' }, { status: 403 });
    }),
    http.post('*/api/v1/auth/oidc/another/link', async ({ request }) => {
      linkBody = await request.json();
      return HttpResponse.json({ code: 'reauthentication_required', message: 'Authenticate again before linking' }, { status: 403 });
    }),
  );
  const user = userEvent.setup();
  renderRoute(<App />, '/profile');
  await user.click(await screen.findByRole('button', { name: 'Actions for Linked provider' }));
  await user.click(await screen.findByText('Reauthenticate with Linked provider'));
  expect(await screen.findByText('Reauthentication failed')).toBeInTheDocument();
  expect(reauthenticated).toBe(true);
  expect(screen.queryByLabelText('Current local password (optional)')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for OIDC / SSO' }));
  await user.click(await screen.findByText('Link Another provider'));
  const linkDialog = screen.getByRole('dialog', { name: 'Link Another provider' });
  await user.click(within(linkDialog).getByRole('button', { name: 'Link provider' }));
  await waitFor(() => expect(linkBody).toEqual({}));
  expect(await screen.findByText('Authenticate again before linking')).toBeInTheDocument();
});
