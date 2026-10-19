import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../api/generated/models';
import { server } from '../test/server';
import { currentUserFixture } from '../test/fixtures';
import { renderRoute } from '../test/render';
import { App } from './App';

describe('protected application routing', () => {
  it('shows the signed-in person name and profile image in the account control', async () => {
    const currentUser = currentUserFixture();
    currentUser.person.profileImage = {
      fileId: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
      source: 'self_upload',
      downloadUrl: `/api/v1/people/${currentUser.person.id}/profile-image`,
    };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUser)),
    );

    renderRoute(<App />, '/dashboard');

    const dashboardHeading = await screen.findByRole('heading', { name: 'Dashboard' });
    expect(dashboardHeading.closest('[data-page-shell]')).toHaveAttribute('data-page-width', 'standard');
    expect(document.querySelector('.app-header__logo')).toHaveAttribute(
      'src',
      '/brand/htumkr-symbol.png',
    );
    expect(document.querySelector('.header-account__name')).toHaveTextContent('Ada Lovelace');
    expect(document.querySelector('.cds--header__action img.person-avatar')).toHaveAttribute(
      'src',
      `/api/v1/people/${currentUser.person.id}/profile-image`,
    );
  });

  it.each([
    [PermissionId.oidcmanage, 'OpenID Connect'],
    [PermissionId.mailmanage, 'Email delivery'],
    [PermissionId.brandingmanage, 'Branding & legal'],
  ])('allows settings navigation with only %s', async (permission, title) => {
    server.use(http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture([permission])),
    ));
    renderRoute(<App />, '/settings');
    const settingsHeading = await screen.findByRole('heading', { name: 'Settings' });
    expect(settingsHeading.closest('[data-page-shell]')).toHaveAttribute('data-page-width', 'standard');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Directory' })).not.toBeInTheDocument();
  });

  it.each(['/settings/oidc', '/settings/mail', '/settings/branding-legal'])('denies %s without its permission', async (path) => {
    server.use(http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture([PermissionId.rolesread])),
    ));
    renderRoute(<App />, path);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('uses client-side navigation for settings tiles and no longer lists printer connectors', async () => {
    server.use(http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture([
        PermissionId.rolesread,
        PermissionId.printer_connectorsread,
      ])),
    ));
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/settings');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Printer connectors/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Roles/ }));
    expect(router.state.location.pathname).toBe('/settings/roles');
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
    expect(document.querySelector('.auth-card__logo')).toHaveAttribute(
      'src',
      '/brand/htumkr-symbol.png',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Need access?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reset password' })).toHaveAttribute(
      'href',
      '/reset-password',
    );
  });

  it('returns an expired entrance-terminal staff session to the public terminal', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json({
        code: 'unauthenticated',
        message: 'Authentication is required',
        details: { postSessionDestination: 'visitor_terminal' },
      }, { status: 401 })),
      http.get('*/api/v1/terminal/context', () => HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        checkoutMode: 'public_tap',
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['password', 'pin'],
        capabilities: [],
        staffDestination: 'login',
      })),
      http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
    );
    const { router } = renderRoute(<App />, '/dashboard');

    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/terminal');
  });

  it('redirects an authenticated user away from settings they cannot access', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())),
    );
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('allows statistics-only attendance access without requesting person-level visits', async () => {
    let visitRequests = 0;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.attendancestatisticsread]))),
      http.get('*/api/v1/visits', () => { visitRequests += 1; return HttpResponse.json({ items: [] }); }),
      http.get('*/api/v1/attendance/statistics', () => HttpResponse.json({
        from: '2026-09-09T00:00:00Z', to: '2026-10-09T00:00:00Z', visitorCount: 12,
        uniqueVisitors: 8, visitorHours: '24.5', peakOccupancy: 4, currentOccupancy: 1,
        averageCompletedVisitMinutes: '122.5',
      })),
    );
    renderRoute(<App />, '/attendance');

    expect(await screen.findByRole('heading', { name: 'Attendance' })).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Currently here' })).not.toBeInTheDocument();
    expect(visitRequests).toBe(0);
  });

  it('promotes Directory without granting access to Settings', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.peoplereadall])),
      ),
      http.get('*/api/v1/people', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0 }),
      ),
    );
    renderRoute(<App />, '/people');
    expect(await screen.findByRole('heading', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people');
    expect(screen.queryByRole('link', { name: 'Organizations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows only the accessible People destination for supervisor-only users', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.supervisor_dashboardread])),
      ),
    );
    renderRoute(<App />, '/dashboard');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Directory' }));
    expect(screen.getByRole('link', { name: 'Staffing' })).toHaveAttribute('href', '/people/staffing');
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows the complete permission-aware navigation hierarchy', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([
          PermissionId.machine_jobsread,
          PermissionId.inventoryread,
          PermissionId.machinesread,
          PermissionId.statisticsread,
          PermissionId.peoplereadall,
          PermissionId.supervisor_dashboardread,
          PermissionId.organizationsread,
          PermissionId.open_daysread,
          PermissionId.eventsread,
          PermissionId.attendanceread,
          PermissionId.ordersread,
          PermissionId.paymentsread,
          PermissionId.external_invoice_requestsread,
          PermissionId.pricingread,
          PermissionId.oidcmanage,
          PermissionId.auditread,
        ])),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const groupOrder = within(navigation).getAllByRole('button').map((button) => button.textContent?.trim());
    expect(groupOrder.filter((name) => ['Workshop', 'Sales & payments', 'Operations', 'Directory'].includes(name ?? ''))).toEqual(['Workshop', 'Sales & payments', 'Operations', 'Directory']);
    for (const group of ['Operations', 'Directory', 'Workshop', 'Sales & payments']) {
      await user.click(within(navigation).getByRole('button', { name: group }));
    }
    for (const name of ['Open Days', 'Events', 'Attendance', 'People', 'Organizations', 'Staffing', 'Jobs', 'Machines', 'Inventory', 'Statistics', 'Orders', 'Payments', 'Pricing']) {
      expect(within(navigation).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(navigation).getAllByRole('link', { name: 'Overview' })).toHaveLength(2);
    expect(within(navigation).queryByRole('link', { name: 'External invoicing' })).not.toBeInTheDocument();
    const workshop = within(navigation).getAllByRole('link').map((link) => link.getAttribute('href')).filter((href) => href?.startsWith('/machine-logbook'));
    expect(workshop).toEqual(['/machine-logbook', '/machine-logbook/jobs', '/machine-logbook/machines', '/machine-logbook/inventory', '/machine-logbook/statistics']);
    expect(within(navigation).getByText('Administration')).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'About' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Imprint' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Privacy policy' })).toBeInTheDocument();

    for (const name of [
      'Dashboard',
      'Settings',
      'Audit Log',
      'About',
      'Imprint',
      'Privacy policy',
    ]) {
      expect(within(navigation).getByRole('link', { name }).querySelector('svg')).toBeInTheDocument();
    }
    for (const group of ['Operations', 'Directory', 'Workshop', 'Sales & payments']) {
      expect(within(navigation).getByRole('button', { name: group }).querySelectorAll('svg')).toHaveLength(2);
    }
  });

  it('renders the About information page', async () => {
    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())));
    renderRoute(<App />, '/about');
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('redirects the legacy legal route to the public imprint', async () => {
    server.use(http.get('*/api/v1/public/legal/imprint', () => HttpResponse.json({ kind: 'imprint', title: 'Imprint', mode: 'internal', markdown: '', externalUrl: null })));
    const { router } = renderRoute(<App />, '/legal-and-privacy');
    expect(await screen.findByRole('heading', { name: 'Imprint' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/legal/imprint');
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
    expect(screen.queryByRole('heading', { name: 'Directory' })).not.toBeInTheDocument();
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
    const openDaysHeading = await screen.findByRole('heading', { name: 'Open Days' });
    expect(openDaysHeading.closest('[data-page-shell]')).toHaveAttribute('data-page-width', 'standard');
    expect(screen.getByRole('link', { name: 'Open Days' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New period' })).not.toBeInTheDocument();
  });

  it('renders the authenticated not-found route in the canonical shell', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())),
    );
    renderRoute(<App />, '/missing-page');

    const heading = await screen.findByRole('heading', { name: 'Page not found' });
    expect(heading.closest('[data-page-shell]')).toHaveAttribute('data-page-width', 'standard');
    expect(document.querySelector('#main-content main')).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /Actions for Master/ })).toBeInTheDocument();
  });

  describe('Machines & Jobs routes', () => {
    const id = '0192f6f8-743e-7c77-a349-cd07c3e8a950';
    const permissions = [PermissionId.machine_jobsread, PermissionId.inventoryread, PermissionId.machinesread, PermissionId.statisticsread];
    const signIn = (granted = permissions) => server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(granted))),
      // The pages behind these routes are not under test; answer their requests with an error state.
      http.get('*/api/v1/*', () => HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 })),
    );

    it.each([
      [`/machine-logbook/inventory/${id}`, `/machine-logbook/inventory/materials/${id}`],
      ['/machine-logbook/spools', '/machine-logbook/inventory?tab=spools'],
      [`/machine-logbook/spools/${id}`, `/machine-logbook/inventory/spools/${id}`],
      [`/machine-logbook/machines/${id}/printer`, `/machine-logbook/machines/${id}?tab=printer`],
      ['/machine-logbook/inventory/materials', '/machine-logbook/inventory?tab=materials'],
      ['/machine-logbook/inventory/spools', '/machine-logbook/inventory?tab=spools'],
    ])('redirects the former URL %s to %s', async (from, to) => {
      signIn();
      const { router } = renderRoute(<App />, from);
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(to));
    });

    it('drops the query string of a former URL and keeps the new material and spool URLs as they are', async () => {
      signIn();
      const redirected = renderRoute(<App />, `/machine-logbook/spools/${id}?search=ada`);
      await waitFor(() => expect(redirected.router.state.location.pathname).toBe(`/machine-logbook/inventory/spools/${id}`));
      expect(redirected.router.state.location.search).toBe('');
      redirected.unmount();
      const material = renderRoute(<App />, `/machine-logbook/inventory/materials/${id}`);
      await screen.findByRole('navigation', { name: 'Primary navigation' });
      expect(material.router.state.location.pathname).toBe(`/machine-logbook/inventory/materials/${id}`);
    });

    it('sends a former URL to the dashboard when the person lacks the permission of its new destination', async () => {
      signIn([PermissionId.inventoryread]);
      const { router } = renderRoute(<App />, `/machine-logbook/machines/${id}/printer`);
      expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/dashboard');
    });

    it('shows a run by its readable file name on its own route', async () => {
      server.use(
        http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsread]))),
        http.get(`*/api/v1/machine-runs/${id}`, () => HttpResponse.json({
          id, displayId: 'RN-00001', machineId: id, machineName: 'Prusa MK4', source: 'recorded', state: 'finished', fileName: 'gearbox_housing_v3.gcode', connectorName: 'Prusa Link',
          startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T09:00:00Z', durationSeconds: 3600, outcome: 'successful', outcomeFromMachine: true, usages: [], usagesFromMachine: false, version: 1, events: [],
        })),
      );
      renderRoute(<App />, `/machine-logbook/jobs/runs/${id}`);
      expect(await screen.findByRole('heading', { name: 'Gearbox housing v3' })).toBeInTheDocument();
      expect(screen.getByText('Finished')).toBeInTheDocument();
    });

    it('sends the former print URL to the run', async () => {
      server.use(
        http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsread]))),
        http.get(`*/api/v1/machine-runs/${id}`, () => HttpResponse.json({
          id, displayId: 'RN-00001', machineId: id, machineName: 'Prusa MK4', source: 'recorded', state: 'finished', fileName: 'bracket.gcode', startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T09:00:00Z',
          durationSeconds: 3600, outcome: null, outcomeFromMachine: false, usages: [], usagesFromMachine: false, version: 1, events: [],
        })),
      );
      const { router } = renderRoute(<App />, `/machine-logbook/jobs/prints/${id}`);
      expect(await screen.findByRole('heading', { name: 'Bracket' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(`/machine-logbook/jobs/runs/${id}`);
    });

    it('denies a run without the job permission', async () => {
      server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machinesread]))));
      renderRoute(<App />, `/machine-logbook/jobs/runs/${id}`);
      expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    });
  });
});
