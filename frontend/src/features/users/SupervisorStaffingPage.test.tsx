import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const rules = {
  supervisorMinimum: 2,
  traineeMinimum: 2,
  traineeReadyAfter: 3,
  warningWindowDays: 14,
  countBy: 'timeslot',
  defaultDeadline: 'period_end',
  exceptions: [],
  version: 7,
  updatedAt: '2026-10-01T00:00:00Z',
};

function member(index: number, overrides: Record<string, unknown> = {}) {
  return {
    personId: index === 1 ? otherPersonId : `0192f6f8-743e-7c77-a349-cd07c3e9${String(index).padStart(4, '0')}`,
    personVersion: 3,
    name: `Member ${String(index).padStart(2, '0')}`,
    membership: 'supervisor',
    extraRoles: [],
    hasProfileImage: true,
    laborordnungState: 'current',
    staffed: 2,
    booked: 0,
    staffedAsTrainee: 0,
    minimum: 2,
    minimumSource: 'membership',
    minimumExceptionRole: null,
    excused: false,
    excusalReason: null,
    status: 'fulfilled',
    missing: 0,
    lastOpenDayAt: null,
    nextAssignment: null,
    memberSince: '2026-01-01',
    ...overrides,
  };
}

function serve(rows: ReturnType<typeof member>[], permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/supervisor-dashboard', () =>
      HttpResponse.json({
        semester: {
          periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
          name: 'Autumn',
          startsOn: '2026-10-01',
          endsOn: '2027-01-31',
          signUpBy: '2026-12-15',
        },
        rules,
        supervisors: rows,
        totals: { supervisors: rows.length, profileImagesComplete: 0, laborordnungCurrent: 0, laborordnungOutdated: 0 },
      }),
    ),
    http.get('*/api/v1/staffing-rules', () => HttpResponse.json(rules)),
  );
}

const members = [
  member(1, { status: 'missing', missing: 1, staffed: 1 }),
  member(2, { laborordnungState: 'outdated' }),
  member(3, { membership: 'trainee', status: 'ready', staffedAsTrainee: 3 }),
];
const bodyRows = () => screen.getAllByRole('row').slice(1);
const read = [PermissionId.supervisor_dashboardread];

describe('Staffing people', () => {
  it('lists people, filters them with the glance tiles and counts the filters in the toolbar', async () => {
    const user = userEvent.setup();
    serve(members, read);
    renderRoute(<App />, '/people/staffing');

    expect(await screen.findByRole('heading', { name: 'Staffing' })).toBeInTheDocument();
    expect(await screen.findByText('Member 03')).toBeInTheDocument();
    // People who need action come first.
    expect(within(bodyRows()[0]).getByText('Member 01')).toBeInTheDocument();
    expect(within(bodyRows()[1]).getByText('Member 03')).toBeInTheDocument();

    const tiles = within(screen.getByLabelText('At a glance'));
    const below = tiles.getByRole('button', { name: /^Below minimum/ });
    await user.click(below);
    expect(below).toHaveAttribute('aria-pressed', 'true');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveTextContent('1');

    await user.click(tiles.getByRole('button', { name: /Lab rules not confirmed/ }));
    expect(within(bodyRows()[0]).getByText('Member 02')).toBeInTheDocument();
    await user.click(tiles.getByRole('button', { name: /Lab rules not confirmed/ }));
    expect(bodyRows()).toHaveLength(3);
  });

  it('sorts a column and searches', async () => {
    const user = userEvent.setup();
    serve(members, read);
    renderRoute(<App />, '/people/staffing');
    await screen.findByText('Member 03');

    await user.click(screen.getByRole('button', { name: /^Name/ }));
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    expect(within(bodyRows()[0]).getByText('Member 03')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search people' }), 'Member 02');
    expect(bodyRows()).toHaveLength(1);
  });

  it('shows membership and excuse actions only to people who may use them', async () => {
    const user = userEvent.setup();
    serve(members, read);
    const view = renderRoute(<App />, '/people/staffing');
    await user.click(await screen.findByRole('button', { name: 'Show Member 03' }));
    expect(await screen.findByRole('heading', { name: 'Member 03' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Member 03' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign to an open day' })).not.toBeInTheDocument();
    view.unmount();

    serve(members, [...read, PermissionId.peoplerolesassign, PermissionId.open_daysmanage]);
    renderRoute(<App />, '/people/staffing');
    await user.click(await screen.findByRole('button', { name: 'Show Member 03' }));
    await user.click(await screen.findByRole('button', { name: 'Actions for Member 03' }));
    expect(screen.getByText('Make supervisor')).toBeInTheDocument();
    expect(screen.queryByText('Make trainee')).not.toBeInTheDocument();
    expect(screen.getByText('Make visitor')).toBeInTheDocument();
    expect(screen.getByText('Excuse for this semester')).toBeInTheDocument();
  });

  it('changes the membership after a confirmation with the person version', async () => {
    const user = userEvent.setup();
    let body: unknown;
    serve(members, [...read, PermissionId.peoplerolesassign]);
    server.use(
      http.put('*/api/v1/people/:personId/membership', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    renderRoute(<App />, '/people/staffing');
    await user.click(await screen.findByRole('button', { name: 'Show Member 03' }));
    await user.click(await screen.findByRole('button', { name: 'Actions for Member 03' }));
    await user.click(screen.getByText('Make supervisor'));
    await user.click(await screen.findByRole('button', { name: 'Make supervisor' }));
    await waitFor(() => expect(body).toEqual({ membership: 'supervisor', expectedVersion: 3 }));
  });
});

describe('Staffing rules', () => {
  const edit = [...read, PermissionId.open_daysmanage];

  async function openRules(permissions: PermissionId[]) {
    serve(members, permissions);
    server.use(http.get('*/api/v1/open-day-eligibility-roles', () => HttpResponse.json({ items: [] })));
    renderRoute(<App />, '/people/staffing?tab=rules');
    return screen.findByLabelText(/Open days per semester/, { selector: '#staffing-supervisorMinimum' });
  }

  it('is read-only without open_days.manage', async () => {
    const field = await openRules(read);
    expect(field).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
  });

  it('enables Discard and Save only while the draft differs and saves with the loaded version', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    const field = await openRules(edit);
    server.use(
      http.put('*/api/v1/staffing-rules', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...rules, supervisorMinimum: 4, version: 8 });
      }),
    );
    const save = screen.getByRole('button', { name: 'Save rules' });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: '4' } });
    expect(save).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: '4' } });
    await user.click(save);
    await waitFor(() => expect(body).toMatchObject({ supervisorMinimum: 4, expectedVersion: 7 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled());
  });

  it('refuses invalid numbers and explains a version conflict', async () => {
    const user = userEvent.setup();
    const field = await openRules(edit);
    server.use(
      http.put('*/api/v1/staffing-rules', () =>
        HttpResponse.json({ code: 'version_conflict', message: 'Stale.' }, { status: 409 }),
      ),
    );
    fireEvent.change(field, { target: { value: '99' } });
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '5' } });
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('The rules changed meanwhile')).toBeInTheDocument();
  });
});
