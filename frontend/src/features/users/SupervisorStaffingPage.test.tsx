import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

function supervisorDashboard() {
  return {
    semester: {
      periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
      name: 'Autumn',
      startsOn: '2026-10-01',
      endsOn: '2027-01-31',
    },
    requirements: { minOpenDaysPerSemester: 2, traineeOpenDaysForPromotion: 3, supervisorRoleConfigured: true },
    supervisors: [
      {
        personId: otherPersonId,
        personVersion: 1,
        name: 'Grace Hopper',
        kind: 'supervisor',
        hasProfileImage: false,
        laborordnungState: 'outdated',
        staffed: 1,
        booked: 0,
        staffedAsTrainee: 0,
        minimum: 2,
        status: 'missing',
        missing: 1,
        lastOpenDayAt: null,
        memberSince: '2026-01-01T00:00:00Z',
      },
    ],
    totals: {
      supervisors: 1,
      profileImagesComplete: 0,
      laborordnungCurrent: 0,
      laborordnungOutdated: 1,
    },
  };
}

describe('Members inside Directory', () => {
  it('keeps the privacy-minimized overview available without directory access', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.supervisor_dashboardread])),
      ),
      http.get('*/api/v1/supervisor-dashboard', () => HttpResponse.json(supervisorDashboard())),
    );

    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByRole('heading', { name: 'Supervisor staffing' })).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Supervisors' })).not.toBeInTheDocument();
    const breadcrumbs = within(screen.getByLabelText('Breadcrumb'));
    expect(breadcrumbs.getByText('Directory')).toBeInTheDocument();
    expect(breadcrumbs.getByText('Members')).toBeInTheDocument();
    expect(breadcrumbs.queryByText('Supervisor staffing')).not.toBeInTheDocument();
  });

  it('adds contextual links only when their original permissions are present', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.supervisor_dashboardread,
            PermissionId.peoplereadall,
            PermissionId.open_daysread,
          ]),
        ),
      ),
      http.get('*/api/v1/supervisor-dashboard', () => HttpResponse.json(supervisorDashboard())),
    );

    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByRole('link', { name: 'Grace Hopper' })).toHaveAttribute(
      'href',
      `/people/${otherPersonId}`,
    );
    const directoryButton = screen.getByRole('button', { name: 'People' });
    expect(screen.queryByRole('heading', { name: 'Designated supervisors' })).not.toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table.closest('.people-table-container')).toHaveClass('supervisor-staffing-table');
    const toolbar = screen.getByLabelText('Members table toolbar');
    expect(toolbar).toContainElement(directoryButton);
    expect(directoryButton).toBe(toolbar.querySelector('.cds--toolbar-content')?.lastElementChild);
    const toolbarControls = toolbar.querySelector('.cds--toolbar-content')?.children;
    expect(toolbarControls?.item(0)).toContainElement(screen.getByRole('searchbox', { name: 'Search members' }));
    expect(toolbarControls?.item(1)).toContainElement(screen.getByRole('button', { name: 'Filters' }));
    expect(toolbarControls?.item(2)).toBe(directoryButton);
    expect(document.querySelector('.supervisor-staffing-table > .cds--pagination')).toBeInTheDocument();
    expect(within(table).getByText('Outdated')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Member$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Open days this semester$/ })).toBeInTheDocument();
    const memberCells = within(screen.getByRole('row', { name: /Grace Hopper/ })).getAllByRole('cell');
    expect(memberCells[3]).toHaveTextContent('1 of 2');
    expect(memberCells[4]).toHaveTextContent('1 missing');
    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
    expect(screen.queryByText('Member readiness')).not.toBeInTheDocument();

    const filterButton = screen.getByRole('button', { name: 'Filters' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(filterButton);
    const filters = screen.getByRole('group', { name: 'Members filters' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    const profilePictureFilter = within(filters).getByRole('group', { name: 'Profile picture' });
    expect(within(filters).getByRole('group', { name: 'Lab Rules' })).toBeInTheDocument();
    await user.click(within(profilePictureFilter).getByRole('checkbox', { name: 'Complete' }));
    await user.click(within(filters).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('heading', { name: 'No members found' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters (1 applied)' }));
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByRole('link', { name: 'Grace Hopper' })).toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: 'Search members' });
    await user.type(search, 'Nobody');
    expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No members found' })).toBeInTheDocument();
  });

  it('redirects the legacy Supervisor URL into the Directory area', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.supervisor_dashboardread])),
      ),
      http.get('*/api/v1/supervisor-dashboard', () => HttpResponse.json(supervisorDashboard())),
    );

    renderRoute(<App />, '/supervisors');

    expect(await screen.findByRole('heading', { name: 'Supervisor staffing' })).toBeInTheDocument();
    const breadcrumbs = screen.getByLabelText('Breadcrumb');
    expect(within(breadcrumbs).getByText('Directory')).toBeInTheDocument();
    expect(within(breadcrumbs).getByText('Members')).toBeInTheDocument();
  });
});

function row(index: number, overrides: Record<string, unknown> = {}) {
  const id = `0192f6f8-743e-7c77-a349-cd07c3e9${String(index).padStart(4, '0')}`;
  return {
    ...supervisorDashboard().supervisors[0],
    personId: id,
    name: `Member ${String(index).padStart(2, '0')}`,
    hasProfileImage: true,
    laborordnungState: 'current',
    staffed: 2,
    booked: 0,
    status: 'fulfilled',
    missing: 0,
    ...overrides,
  };
}

function serveDashboard(
  supervisors: ReturnType<typeof row>[],
  permissions: PermissionId[] = [PermissionId.supervisor_dashboardread],
  supervisorRoleConfigured = true,
) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/supervisor-dashboard', () =>
      HttpResponse.json({
        ...supervisorDashboard(),
        requirements: { minOpenDaysPerSemester: 2, traineeOpenDaysForPromotion: 3, supervisorRoleConfigured },
        supervisors,
        totals: {
          supervisors: supervisors.length,
          profileImagesComplete: 0,
          laborordnungCurrent: 0,
          laborordnungOutdated: 0,
        },
      }),
    ),
  );
}

const bodyRows = () => screen.getAllByRole('row').slice(1);
const pageSizeSelect = () => screen.getByRole('combobox', { name: /Items per page/ });
const pageSelect = () => screen.getByRole('combobox', { name: /Page number|Page of/ });

describe('per-person open-day target', () => {
  it('shows each person against their own minimum, not the general one', async () => {
    serveDashboard([
      row(1, { status: 'missing', missing: 3, staffed: 1, minimum: 4 }),
      row(2, { status: 'fulfilled', staffed: 1, minimum: 1 }),
    ]);
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByText('Member 01')).toBeInTheDocument();
    expect(screen.getByText('Member 01: signed up for 1 of 4 open days')).toBeInTheDocument();
    expect(screen.getByText('Member 02: signed up for 1 of 1 open days')).toBeInTheDocument();
    expect(screen.getByText(/general minimum 2 open days per person/)).toBeInTheDocument();
  });
});

describe('staffing key figures', () => {
  const members = [
    row(1, { status: 'missing', missing: 1, staffed: 1 }),
    row(2, { laborordnungState: 'outdated' }),
    row(3, { kind: 'trainee', status: 'ready', staffedAsTrainee: 3 }),
    row(4, { hasProfileImage: false }),
    row(5),
  ];

  it('count the semester and filter the table; the active one is outlined and clears on a second click', async () => {
    const user = userEvent.setup();
    serveDashboard(members);
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByText('Member 05')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(5);
    // Sorted by what needs action: below minimum first, then ready for promotion.
    expect(within(bodyRows()[0]).getByText('Member 01')).toBeInTheDocument();
    expect(within(bodyRows()[1]).getByText('Member 03')).toBeInTheDocument();

    const keyFigures = within(screen.getByLabelText('Key figures'));
    const below = keyFigures.getByText('Below minimum').closest('[aria-pressed]') as HTMLElement;
    expect(below).toHaveAttribute('aria-pressed', 'false');
    await user.click(below);
    expect(below).toHaveAttribute('aria-pressed', 'true');
    expect(below).toHaveClass('staffing-metric--active');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Filters (1 applied)' })).toBeInTheDocument();

    // Another tile replaces the filter; the table adopts the new rows without crashing.
    await user.click(keyFigures.getByText('Lab rules not signed'));
    expect(within(bodyRows()[0]).getByText('Member 02')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(1);
    await user.click(keyFigures.getByText('Ready for supervisor'));
    expect(within(bodyRows()[0]).getByText('Member 03')).toBeInTheDocument();
    await user.click(keyFigures.getByText('No profile picture'));
    expect(within(bodyRows()[0]).getByText('Member 04')).toBeInTheDocument();

    await user.click(keyFigures.getByText('No profile picture'));
    expect(screen.getByLabelText('Key figures').querySelector('.staffing-metric--active')).toBeNull();
    expect(bodyRows()).toHaveLength(5);
  });

  it('paginate like other tables (default 25) and go back to page 1 when the filter or search changes', async () => {
    const user = userEvent.setup();
    serveDashboard(
      Array.from({ length: 30 }, (_, index) =>
        row(index + 1, index % 2 === 0 ? { status: 'missing', missing: 1, staffed: 1 } : {}),
      ),
    );
    renderRoute(<App />, '/people/staffing');

    await screen.findByText('Member 05');
    expect(bodyRows()).toHaveLength(25);
    expect(pageSizeSelect()).toHaveValue('25');
    expect(
      within(pageSizeSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['10', '25', '50', '100']);

    await user.selectOptions(pageSizeSelect(), '10');
    expect(bodyRows()).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: /Next page/ }));
    expect(pageSelect()).toHaveValue('2');

    await user.click(within(screen.getByLabelText('Key figures')).getByText('Below minimum'));
    expect(bodyRows()).toHaveLength(10);
    expect(pageSelect()).toHaveValue('1');
    await user.click(within(screen.getByLabelText('Key figures')).getByText('Below minimum'));

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    expect(pageSelect()).toHaveValue('2');
    await user.type(screen.getByRole('searchbox', { name: 'Search members' }), 'Member 0');
    expect(pageSelect()).toHaveValue('1');
  });
});

describe('making a trainee a supervisor', () => {
  const trainee = row(1, {
    kind: 'trainee',
    personVersion: 7,
    staffedAsTrainee: 3,
    status: 'ready',
    name: 'Tina Trainee',
  });
  const optionText = { selector: '.cds--overflow-menu-options__option-content' };

  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    const tooltip = await screen.findByText('Actions for Tina Trainee', { selector: '.cds--tooltip-content' });
    await user.click(tooltip.closest('.cds--popover-container')!.querySelector('button') as HTMLElement);
  }

  it('confirms first, then promotes with the person version', async () => {
    const user = userEvent.setup();
    let promoted: { id: string; body: unknown } | undefined;
    serveDashboard([trainee], [PermissionId.supervisor_dashboardread, PermissionId.peoplerolesassign]);
    server.use(
      http.get(`*/api/v1/people/${trainee.personId}`, () => {
        throw new Error('The promotion must not read the person first');
      }),
      http.post('*/api/v1/people/:id/promote-to-supervisor', async ({ params, request }) => {
        promoted = { id: String(params.id), body: await request.json() };
        return HttpResponse.json({ id: trainee.personId, version: 8 });
      }),
    );
    renderRoute(<App />, '/people/staffing');

    await openMenu(user);
    await user.click(await screen.findByText('Make supervisor', optionText));
    const dialog = await screen.findByRole('dialog', { name: 'Make Tina Trainee a supervisor?' });
    expect(promoted).toBeUndefined();
    expect(within(dialog).getByText(/has staffed 3 open days as trainee/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Make supervisor' }));

    await waitFor(() => expect(promoted).toEqual({ id: trainee.personId, body: { expectedVersion: 7 } }));
    expect(await screen.findByText('Tina Trainee is now a supervisor')).toBeInTheDocument();
  });

  it('shows the server message when the promotion is refused', async () => {
    const user = userEvent.setup();
    serveDashboard([trainee], [PermissionId.supervisor_dashboardread, PermissionId.peoplerolesassign]);
    server.use(
      http.post('*/api/v1/people/:id/promote-to-supervisor', () =>
        HttpResponse.json({ code: 'not_a_trainee', message: 'The person is not a trainee.' }, { status: 409 }),
      ),
    );
    renderRoute(<App />, '/people/staffing');

    await openMenu(user);
    await user.click(await screen.findByText('Make supervisor', optionText));
    const dialog = await screen.findByRole('dialog', { name: 'Make Tina Trainee a supervisor?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make supervisor' }));
    expect(await within(dialog).findByText('The person is not a trainee.')).toBeInTheDocument();
  });

  it('is disabled with an explanation when no supervisor role is configured', async () => {
    const user = userEvent.setup();
    serveDashboard([trainee], [PermissionId.supervisor_dashboardread, PermissionId.peoplerolesassign], false);
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByText(/No supervisor role is configured/)).toBeInTheDocument();
    await openMenu(user);
    expect((await screen.findByText('Make supervisor', optionText)).closest('button')).toBeDisabled();
  });

  it('is disabled with an explanation without the permission to assign roles', async () => {
    const user = userEvent.setup();
    serveDashboard([trainee]);
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByText(/You need permission to assign roles/)).toBeInTheDocument();
    await openMenu(user);
    expect((await screen.findByText('Make supervisor', optionText)).closest('button')).toBeDisabled();
  });

  it('offers no menu for supervisors', async () => {
    serveDashboard(
      [row(2, { name: 'Sam Supervisor' })],
      [PermissionId.supervisor_dashboardread, PermissionId.peoplerolesassign],
    );
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByText('Sam Supervisor')).toBeInTheDocument();
    expect(
      screen.queryByText('Actions for Sam Supervisor', { selector: '.cds--tooltip-content' }),
    ).not.toBeInTheDocument();
  });
});
