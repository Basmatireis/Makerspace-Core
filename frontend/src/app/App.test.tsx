import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../api/generated/models';
import { server } from '../test/server';
import { currentUserFixture } from '../test/fixtures';
import { renderRoute } from '../test/render';
import { App } from './App';

describe('protected application routing', () => {
  it('redirects an anonymous visitor to sign in', async () => {
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Makerspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects an authenticated user away from settings they cannot access', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())),
    );
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows settings and its permitted tool only', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
    );
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('keeps the authenticated state when server-side logout fails', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())),
      http.post('*/api/v1/auth/logout', () =>
        HttpResponse.json(
          { code: 'server_error', message: 'Unable to sign out.' },
          { status: 500 },
        ),
      ),
    );
    const { queryClient } = renderRoute(<App />, '/dashboard');
    const user = userEvent.setup();
    queryClient.setQueryData(['private', 'sentinel'], { retained: true });

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Open profile menu for Ada Lovelace' }),
    );
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Sign out failed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['private', 'sentinel'])).toEqual({ retained: true });
  });
});

describe('role protection UX', () => {
  it('keeps the master role read-only even for a master actor', async () => {
    const actor = currentUserFixture(
      [PermissionId.rolesread, PermissionId.rolesmanage],
      true,
    );
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(actor)),
      http.get('*/api/v1/roles/:roleId', () =>
        HttpResponse.json({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a903',
          name: 'Master',
          description: 'Protected master role',
          systemKey: 'master',
          permissionIds: [PermissionId.rolesread, PermissionId.rolesmanage],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          version: 2,
        }),
      ),
      http.get('*/api/v1/permissions', () =>
        HttpResponse.json({
          items: [
            { id: PermissionId.rolesread, description: 'Read roles' },
            { id: PermissionId.rolesmanage, description: 'Manage roles' },
          ],
        }),
      ),
    );
    renderRoute(<App />, '/settings/roles/0192f6f8-743e-7c77-a349-cd07c3e8a903');
    expect(await screen.findByRole('heading', { name: 'Master' })).toBeInTheDocument();
    expect(screen.getByText('Protected system role with every application permission.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
