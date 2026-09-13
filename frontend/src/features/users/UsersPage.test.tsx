import { delay, http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import {
  accountFixture,
  currentUserFixture,
  personFixture,
} from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

function peoplePage(items: ReturnType<typeof personFixture>[]) {
  return { items, page: 1, pageSize: 25, total: items.length };
}

describe('Users page', () => {
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
              account: accountFixture(),
            }),
          ]),
        ),
      ),
    );

    renderRoute(<App />, '/settings/users');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add person' })).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Matriculation number/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Account/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('M-0042')).toBeInTheDocument();
    expect(screen.getByText('enabled')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument();
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
