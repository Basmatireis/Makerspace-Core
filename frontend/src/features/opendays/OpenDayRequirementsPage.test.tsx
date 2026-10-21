import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpenDayRequirements, Role, UpdateOpenDayRequirementsRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, roleFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const supervisorRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';

const requirements: OpenDayRequirements = {
  minOpenDaysPerSemester: 2,
  traineeOpenDaysForPromotion: 3,
  supervisorRoleId: null,
  version: 4,
  updatedAt: '2026-10-01T00:00:00Z',
};

function serve(permissions: PermissionId[], roles: Role[] = []) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/open-day-requirements', () => HttpResponse.json(requirements)),
    http.get('*/api/v1/roles', () => HttpResponse.json({ items: roles, nextCursor: null })),
  );
}

const roles = [
  roleFixture({ id: supervisorRoleId, name: 'Supervisor', staffingLevel: 'supervisor' }),
  roleFixture({ id: '0192f6f8-743e-7c77-a349-cd07c3e8c002', name: 'Trainee', staffingLevel: 'trainee' }),
];

describe('open day requirements settings', () => {
  it('appears on the settings page only with open_days.manage', async () => {
    serve([PermissionId.open_daysmanage]);
    const { unmount } = renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Open day requirements' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open day requirements/ })).toHaveAttribute('href', '/settings/open-days');
    unmount();

    serve([PermissionId.rolesread]);
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Roles' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Open day requirements' })).not.toBeInTheDocument();
  });

  it('sends people without open_days.manage back to the dashboard', async () => {
    serve([PermissionId.open_daysread]);
    renderRoute(<App />, '/settings/open-days');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('validates the numbers before saving', async () => {
    const user = userEvent.setup();
    let saved = false;
    serve([PermissionId.open_daysmanage, PermissionId.rolesread], roles);
    server.use(
      http.put('*/api/v1/open-day-requirements', () => {
        saved = true;
        return HttpResponse.json(requirements);
      }),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester' });
    const save = screen.getByRole('button', { name: 'Save requirements' });
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

  it('saves the numbers and the supervisor role with the loaded version', async () => {
    const user = userEvent.setup();
    let body: UpdateOpenDayRequirementsRequest | undefined;
    serve([PermissionId.open_daysmanage, PermissionId.rolesread], roles);
    server.use(
      http.put('*/api/v1/open-day-requirements', async ({ request }) => {
        body = (await request.json()) as UpdateOpenDayRequirementsRequest;
        return HttpResponse.json({ ...requirements, ...body, version: 5 });
      }),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester' });
    await user.clear(minimum);
    await user.type(minimum, '3');
    const role = screen.getByRole('combobox', { name: 'Supervisor role for promotions' });
    // Only roles with the supervisor staffing level can be chosen.
    expect(screen.queryByRole('option', { name: 'Trainee' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Supervisor' })).toBeInTheDocument());
    await user.selectOptions(role, supervisorRoleId);
    await user.click(screen.getByRole('button', { name: 'Save requirements' }));

    await waitFor(() =>
      expect(body).toEqual({
        minOpenDaysPerSemester: 3,
        traineeOpenDaysForPromotion: 3,
        supervisorRoleId,
        expectedVersion: 4,
      }),
    );
    expect(await screen.findByText('Requirements saved')).toBeInTheDocument();
  });

  it('explains a refused save', async () => {
    const user = userEvent.setup();
    serve([PermissionId.open_daysmanage]);
    server.use(
      http.put('*/api/v1/open-day-requirements', () =>
        HttpResponse.json({ code: 'conflict', message: 'Version changed.' }, { status: 409 }),
      ),
    );
    renderRoute(<App />, '/settings/open-days');

    const minimum = await screen.findByRole('spinbutton', { name: 'Minimum open days per semester' });
    await user.clear(minimum);
    await user.type(minimum, '4');
    await user.click(screen.getByRole('button', { name: 'Save requirements' }));
    expect(await screen.findByText(/Someone else changed these settings/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Supervisor role for promotions' })).toBeDisabled();
  });
});
