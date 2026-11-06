import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StaffingRules, UpdateStaffingRulesRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const exceptionRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';

const requirements: StaffingRules = {
  supervisorMinimum: 2,
  traineeMinimum: 2,
  traineeReadyAfter: 3,
  warningWindowDays: 14,
  countBy: 'timeslot',
  defaultDeadline: 'period_end',
  exceptions: [{ roleId: exceptionRoleId, roleName: 'Board', minimum: 0 }],
  version: 4,
  updatedAt: '2026-10-01T00:00:00Z',
};

function serve(permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/staffing-rules', () => HttpResponse.json(requirements)),
  );
}

describe('open day requirements settings', () => {
  it('appears on the settings page only with open_days.manage', async () => {
    serve([PermissionId.open_daysmanage]);
    const { unmount } = renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Open days & staffing' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open days & staffing/ })).toHaveAttribute('href', '/settings/open-days');
    unmount();

    serve([PermissionId.rolesread]);
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Open days & staffing' })).not.toBeInTheDocument();
  });

  it('sends people without open_days.manage back to the dashboard', async () => {
    serve([PermissionId.open_daysread]);
    renderRoute(<App />, '/settings/open-days');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('validates the numbers before saving', async () => {
    const user = userEvent.setup();
    let saved = false;
    serve([PermissionId.open_daysmanage]);
    server.use(
      http.put('*/api/v1/staffing-rules', () => {
        saved = true;
        return HttpResponse.json(requirements);
      }),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester for supervisors' });
    const save = screen.getByRole('button', { name: 'Save staffing rules' });
    expect(save).toBeDisabled();
    await user.clear(minimum);
    await user.type(minimum, '25');
    expect(await screen.findByText('Enter a whole number from 0 to 20.')).toBeInTheDocument();
    await user.click(save);
    expect(saved).toBe(false);

    const threshold = screen.getByRole('spinbutton', { name: 'Open days as trainee before becoming a supervisor' });
    await user.clear(threshold);
    await user.type(threshold, '0');
    expect(await screen.findByText('Enter a whole number from 1 to 20.')).toBeInTheDocument();
    expect(saved).toBe(false);
  });

  it('saves the numbers with the loaded version and keeps the exceptions', async () => {
    const user = userEvent.setup();
    let body: UpdateStaffingRulesRequest | undefined;
    serve([PermissionId.open_daysmanage]);
    server.use(
      http.put('*/api/v1/staffing-rules', async ({ request }) => {
        body = (await request.json()) as UpdateStaffingRulesRequest;
        return HttpResponse.json({ ...requirements, ...body, version: 5 });
      }),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester for supervisors' });
    await user.clear(minimum);
    await user.type(minimum, '3');
    await user.click(screen.getByRole('button', { name: 'Save staffing rules' }));

    await waitFor(() =>
      expect(body).toEqual({
        supervisorMinimum: 3,
        traineeMinimum: 2,
        traineeReadyAfter: 3,
        warningWindowDays: 14,
        countBy: 'timeslot',
        defaultDeadline: 'period_end',
        exceptions: [{ roleId: exceptionRoleId, minimum: 0 }],
        expectedVersion: 4,
      }),
    );
    expect(await screen.findByText('Staffing rules saved')).toBeInTheDocument();
  });

  it('explains a refused save', async () => {
    const user = userEvent.setup();
    serve([PermissionId.open_daysmanage]);
    server.use(
      http.put('*/api/v1/staffing-rules', () =>
        HttpResponse.json({ code: 'conflict', message: 'Version changed.' }, { status: 409 }),
      ),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester for supervisors' });
    await user.clear(minimum);
    await user.type(minimum, '4');
    await user.click(screen.getByRole('button', { name: 'Save staffing rules' }));
    expect(await screen.findByText(/Someone else changed these settings/)).toBeInTheDocument();
  });
});
