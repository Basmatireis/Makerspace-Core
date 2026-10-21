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
        name: 'Grace Hopper',
        kind: 'supervisor',
        hasProfileImage: false,
        laborordnungState: 'outdated',
        staffed: 1,
        booked: 0,
        staffedAsTrainee: 0,
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
    expect(memberCells[4]).toHaveTextContent('Below minimum');
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
