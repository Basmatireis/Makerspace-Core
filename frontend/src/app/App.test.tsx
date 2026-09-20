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
  it.each([
    [PermissionId.oidcmanage, 'OpenID Connect'],
    [PermissionId.mailmanage, 'Email delivery'],
  ])('allows settings navigation with only %s', async (permission, title) => {
    server.use(http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture([permission])),
    ));
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument();
  });

  it.each(['/settings/oidc', '/settings/mail'])('denies %s without its permission', async (path) => {
    server.use(http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture([PermissionId.rolesread])),
    ));
    renderRoute(<App />, path);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

	it('shows a nonblocking Lab Rules warning and creates a request only on explicit action', async () => {
		const currentUser = currentUserFixture();
		currentUser.laborordnungStatus = {
			mode: 'warning',
			state: 'outdated',
			actionRequired: true,
			currentVersion: {
				id: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
				status: 'published',
				humanRevision: '2026-09',
				pdfFileId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
				sha256: 'a'.repeat(64),
				effectiveAt: '2026-09-01T00:00:00Z',
				publishedAt: '2026-08-20T00:00:00Z',
				createdAt: '2026-08-20T00:00:00Z',
			},
			latestConfirmedVersion: null,
			requestId: null,
		};
		let requestCount = 0;
		server.use(
			http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
			http.post('*/api/v1/laborordnung/requests/me', () => {
				requestCount += 1;
				return HttpResponse.json({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a932' }, { status: 201 });
			}),
		);
		const user = userEvent.setup();
		renderRoute(<App />, '/dashboard');

		expect(await screen.findByText('Your Lab Rules confirmation is outdated')).toBeInTheDocument();
		expect(screen.getByText(/Normal application access remains available/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'View current Lab Rules PDF' })).toHaveAttribute(
			'href',
			'/api/v1/laborordnung/versions/0192f6f8-743e-7c77-a349-cd07c3e8a930/pdf',
		);
		expect(requestCount).toBe(0);

		await user.click(screen.getByRole('button', { name: 'Request signature confirmation' }));
		expect(requestCount).toBe(1);
		expect(screen.queryByText(/Laborordnung/i)).not.toBeInTheDocument();
	});

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
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('shows the managed-devices settings tile only with inventory access', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread])),
      ),
    );
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Managed devices' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('shows Open Days navigation only with an Open Days read or manage permission', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.open_daysread])),
      ),
      http.get('*/api/v1/open-day-periods', () => HttpResponse.json({ items: [] })),
    );
    renderRoute(<App />, '/open-days');
    expect(await screen.findByRole('heading', { name: 'Open Days' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Days' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New period' })).not.toBeInTheDocument();
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
      http.get('*/api/v1/roles', () =>
        HttpResponse.json({ items: [{
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a903', name: 'Master', description: 'Protected master role', systemKey: 'master',
          permissionGrants: [PermissionId.rolesread, PermissionId.rolesmanage].map((permissionId) => ({ permissionId, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' })),
          profileImageRequired: false, laborordnungMode: 'not_required', supervisorDashboard: false,
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 2,
        }], nextCursor: null }),
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
    expect(await screen.findByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument();
    expect(screen.getAllByText('Master').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Protected system role')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for Master/ })).not.toBeInTheDocument();
  });
});
