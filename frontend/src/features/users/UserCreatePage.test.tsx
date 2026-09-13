import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CreatePersonRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import {
  currentUserFixture,
  otherPersonId,
  personFixture,
} from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

describe('Create person page', () => {
  it('submits the permitted fields and opens the new Person', async () => {
    const created = personFixture({
      firstName: 'Katherine',
      lastName: 'Johnson',
      email: 'katherine@example.test',
      phone: null,
      matriculationNumber: 'M-2042',
    });
    let submitted: CreatePersonRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.peoplereadall,
            PermissionId.peoplecreate,
            PermissionId.peopleupdatematriculation,
          ]),
        ),
      ),
      http.post('*/api/v1/people', async ({ request }) => {
        submitted = (await request.json()) as CreatePersonRequest;
        return HttpResponse.json(created, { status: 201 });
      }),
      http.get(`*/api/v1/people/${otherPersonId}`, () =>
        HttpResponse.json(created),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/users/new');

    await user.type(await screen.findByLabelText('First name'), '  Katherine  ');
    await user.type(screen.getByLabelText('Last name'), 'Johnson');
    await user.type(
      screen.getByLabelText('Contact email'),
      'katherine@example.test',
    );
    await user.type(screen.getByLabelText('Matriculation number'), 'M-2042');
    await user.click(screen.getByRole('button', { name: 'Create person' }));

    await waitFor(() =>
      expect(submitted).toEqual({
        firstName: 'Katherine',
        lastName: 'Johnson',
        email: 'katherine@example.test',
        phone: null,
        matriculationNumber: 'M-2042',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Katherine Johnson' }),
    ).toBeInTheDocument();
  });
});
