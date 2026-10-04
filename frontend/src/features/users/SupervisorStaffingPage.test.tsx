import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a932';
const secondPeriodId = '0192f6f8-743e-7c77-a349-cd07c3e8a933';

function supervisorDashboard() {
  return {
    periods: [
      {
        id: periodId,
        name: 'Autumn Open Days',
        status: 'staffing',
        supervisorAssignments: 3,
      },
      {
        id: secondPeriodId,
        name: 'Spring Open Days',
        status: 'published',
        supervisorAssignments: 1,
      },
    ],
    supervisors: [{
      personId: otherPersonId,
      name: 'Grace Hopper',
      hasProfileImage: false,
      laborordnungState: 'outdated',
      assignmentCounts: [
        { periodId, supervisorCount: 2, traineeCount: 1 },
        { periodId: secondPeriodId, supervisorCount: 0, traineeCount: 2 },
      ],
    }],
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
      http.get('*/api/v1/supervisor-dashboard', () =>
        HttpResponse.json(supervisorDashboard()),
      ),
    );

    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByRole('heading', { name: 'Supervisor staffing' })).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Directory' })).not.toBeInTheDocument();
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
        HttpResponse.json(currentUserFixture([
          PermissionId.supervisor_dashboardread,
          PermissionId.peoplereadall,
          PermissionId.open_daysread,
        ])),
      ),
      http.get('*/api/v1/supervisor-dashboard', () =>
        HttpResponse.json(supervisorDashboard()),
      ),
    );

    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByRole('link', { name: 'Grace Hopper' })).toHaveAttribute(
      'href',
      `/people/${otherPersonId}`,
    );
    const directoryButton = screen.getByRole('button', { name: 'Directory' });
    expect(screen.queryByRole('heading', { name: 'Designated supervisors' })).not.toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table.closest('.people-table-container')).toHaveClass('supervisor-staffing-table');
    const toolbar = screen.getByLabelText('Members table toolbar');
    expect(toolbar).toContainElement(directoryButton);
    expect(directoryButton).toBe(toolbar.querySelector('.cds--toolbar-content')?.lastElementChild);
    const toolbarControls = toolbar.querySelector('.cds--toolbar-content')?.children;
    expect(toolbarControls?.item(0)).toContainElement(screen.getByRole('searchbox', { name: 'Search members' }));
    expect(toolbarControls?.item(1)).toContainElement(screen.getByRole('button', { name: 'Filters' }));
    expect(toolbarControls?.item(2)).toContainElement(screen.getByRole('combobox', { name: 'Open Days period' }));
    expect(toolbarControls?.item(3)).toBe(directoryButton);
    expect(document.querySelector('.supervisor-staffing-table > .cds--pagination')).toBeInTheDocument();
    expect(within(table).getByText('Outdated')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Member$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Supervisor$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Trainee$/ })).toBeInTheDocument();
    let memberCells = within(screen.getByRole('row', { name: /Grace Hopper/ })).getAllByRole('cell');
    expect(memberCells[3]).toHaveTextContent('2');
    expect(memberCells[4]).toHaveTextContent('1');
    const periodSelector = screen.getByRole('combobox', { name: 'Open Days period' });
    await user.click(periodSelector);
    await user.click(screen.getByRole('option', { name: 'Spring Open Days' }));
    memberCells = within(screen.getByRole('row', { name: /Grace Hopper/ })).getAllByRole('cell');
    expect(memberCells[3]).toHaveTextContent('0');
    expect(memberCells[4]).toHaveTextContent('2');
    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
    expect(screen.queryByText('Member readiness')).not.toBeInTheDocument();

    const filterButton = screen.getByRole('button', { name: 'Filters' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(filterButton);
    const filters = screen.getByRole('region', { name: 'Members filters' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    const profilePictureFilter = within(filters).getByRole('combobox', { name: 'Profile picture' });
    expect(within(filters).getByRole('combobox', { name: 'Lab Rules' })).toBeInTheDocument();
    await user.click(profilePictureFilter);
    await user.click(screen.getByRole('option', { name: 'Complete' }));
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('heading', { name: 'No members found' })).toBeInTheDocument();
    await user.click(within(filters).getByRole('button', { name: 'Clear filters' }));
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
      http.get('*/api/v1/supervisor-dashboard', () =>
        HttpResponse.json(supervisorDashboard()),
      ),
    );

    renderRoute(<App />, '/supervisors');

    expect(await screen.findByRole('heading', { name: 'Supervisor staffing' })).toBeInTheDocument();
    const breadcrumbs = screen.getByLabelText('Breadcrumb');
    expect(within(breadcrumbs).getByText('Directory')).toBeInTheDocument();
    expect(within(breadcrumbs).getByText('Members')).toBeInTheDocument();
  });
});
