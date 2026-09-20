import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a932';

function supervisorDashboard() {
  return {
    periods: [{
      id: periodId,
      name: 'Autumn Open Days',
      status: 'staffing',
      supervisorAssignments: 3,
    }],
    supervisors: [{
      personId: otherPersonId,
      name: 'Grace Hopper',
      hasProfileImage: false,
      laborordnungState: 'outdated',
      assignmentCounts: [{ periodId, count: 2 }],
    }],
    totals: {
      supervisors: 1,
      profileImagesComplete: 0,
      laborordnungCurrent: 0,
      laborordnungOutdated: 1,
    },
  };
}

describe('Supervisor staffing inside People', () => {
  it('keeps the privacy-minimized overview available without People-directory access', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.supervisor_dashboardread])),
      ),
      http.get('*/api/v1/supervisor-dashboard', () =>
        HttpResponse.json(supervisorDashboard()),
      ),
    );

    renderRoute(<App />, '/settings/users/staffing');

    expect(await screen.findByRole('heading', { name: 'Supervisor staffing' })).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'People directory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Supervisors' })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Breadcrumb')).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('adds contextual links only when their original permissions are present', async () => {
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

    renderRoute(<App />, '/settings/users/staffing');

    expect(await screen.findByRole('link', { name: 'Grace Hopper' })).toHaveAttribute(
      'href',
      `/settings/users/${otherPersonId}`,
    );
    expect(screen.getByRole('link', { name: 'Autumn Open Days' })).toHaveAttribute(
      'href',
      `/open-days/${periodId}`,
    );
    expect(screen.getByRole('button', { name: 'People directory' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Outdated')).toBeInTheDocument();
    expect(within(table).getByText('2')).toBeInTheDocument();
  });

  it('redirects the legacy Supervisor URL into the People area', async () => {
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
    expect(within(breadcrumbs).getByText('People')).toBeInTheDocument();
  });
});
