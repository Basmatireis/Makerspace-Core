import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
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

    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const firstName = screen.getByLabelText('First name');
    await user.clear(firstName);
    await user.type(firstName, 'Augusta');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(submitted).toEqual({ expectedVersion: 1, firstName: 'Augusta' }),
    );
    expect(
      await screen.findByRole('cell', { name: 'Augusta Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Matriculation number')).toBeInTheDocument();
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
});
