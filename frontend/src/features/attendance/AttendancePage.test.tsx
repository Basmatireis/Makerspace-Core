import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type Visit, type VoidVisitRequest } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, personFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const visit: Visit = {
  id: '01995ea6-6d00-7000-8000-000000000201',
  personId: '01995ea6-6d00-7000-8000-000000000202',
  displayName: 'Grace Hopper',
  checkedInAt: '2026-10-11T08:00:00Z',
  checkedOutAt: null,
  status: 'checked_in',
  checkInMethod: 'supervisor',
  checkOutMethod: null,
  admissionDecision: 'admitted',
  correctionReason: null,
  version: 3,
};

async function openVoidDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions for Grace Hopper' }));
  const matches = await screen.findAllByText('Void record');
  await user.click(matches.find((element) => element.closest('.cds--overflow-menu-options'))!);
}

describe('Attendance corrections', () => {
  it('requires a reason and confirmation before voiding a visible visit', async () => {
    let currentVisits = [visit];
    let submitted: VoidVisitRequest | undefined;
    let finishRequest!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.attendanceread, PermissionId.attendancecorrect])),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: currentVisits })),
      http.post('*/api/v1/visits/:visitId/void', async ({ request }) => {
        submitted = (await request.json()) as VoidVisitRequest;
        await responseReady;
        currentVisits = [];
        return HttpResponse.json({ ...visit, status: 'voided', correctionReason: submitted.reason, version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/attendance');

    await openVoidDialog(user);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Void attendance record for Grace Hopper?')).toBeInTheDocument();
    expect(within(dialog).getByText(/survey invitations are cancelled/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Void record' })).toBeDisabled();
    expect(submitted).toBeUndefined();

    await user.type(within(dialog).getByLabelText('Correction reason'), 'Duplicate check-in');
    await user.click(within(dialog).getByRole('button', { name: 'Void record' }));

    await waitFor(() => expect(submitted).toEqual({ expectedVersion: 3, reason: 'Duplicate check-in' }));
    await user.keyboard('{Escape}');
    expect(dialog.closest('.cds--modal')).toHaveClass('is-visible');
    expect(within(dialog).getByLabelText('Correction reason')).toHaveValue('Duplicate check-in');
    finishRequest();
    await waitFor(() => expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument());
  });

  it('removes a visit from the table after checking it out', async () => {
    let currentVisits = [visit];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.attendanceread, PermissionId.attendanceassist])),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: currentVisits })),
      http.post('*/api/v1/visits/:visitId/check-out', () => {
        currentVisits = [];
        return HttpResponse.json({ ...visit, status: 'checked_out', checkedOutAt: '2026-10-11T10:00:00Z' });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/attendance');

    await user.click(await screen.findByRole('button', { name: 'Actions for Grace Hopper' }));
    const matches = await screen.findAllByText('Check out');
    await user.click(matches.find((element) => element.closest('.cds--overflow-menu-options'))!);

    expect(await screen.findByText('Nobody is checked in.')).toBeInTheDocument();
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
  });

  it('does not expose correction controls without attendance.correct', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.attendanceread]))),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [visit] })),
    );
    renderRoute(<App />, '/attendance');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('does not fetch private visit details for assist-only access', async () => {
    let visitListRequested = false;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.attendanceassist]))),
      http.get('*/api/v1/visits', () => {
        visitListRequested = true;
        return HttpResponse.json({ items: [visit] });
      }),
    );
    renderRoute(<App />, '/attendance');

    expect(await screen.findByRole('heading', { name: 'Attendance' })).toBeInTheDocument();
    expect(visitListRequested).toBe(false);
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
  });
});

describe('Assisted check-in', () => {
  const candidate = personFixture({ id: visit.personId, firstName: 'Katherine', lastName: 'Johnson' });

  async function startAssistedCheckIn(user: ReturnType<typeof userEvent.setup>) {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([PermissionId.attendanceread, PermissionId.attendanceassist, PermissionId.peoplereadall]),
        ),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/people', () => HttpResponse.json({ items: [candidate], page: 1, pageSize: 25, total: 1 })),
    );
    renderRoute(<App />, '/attendance');
    await user.click(await screen.findByRole('button', { name: 'Check someone in' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByText('Katherine Johnson'));
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }));
    return dialog;
  }

  it('tells staff that a person who must confirm the Lab Rules has to do it themselves', async () => {
    server.use(
      http.post('*/api/v1/visits', () =>
        HttpResponse.json(
          { code: 'lab_rules_confirmation_required', message: 'Lab Rules confirmation required' },
          { status: 409 },
        ),
      ),
    );
    const dialog = await startAssistedCheckIn(userEvent.setup());

    expect(
      await within(dialog).findByText(
        'Katherine Johnson must confirm the Lab Rules on the tablet or in the app first.',
      ),
    ).toBeInTheDocument();
  });

  it('closes the dialog after a successful assisted check-in', async () => {
    server.use(http.post('*/api/v1/visits', () => HttpResponse.json({ ...visit, personId: candidate.id })));
    await startAssistedCheckIn(userEvent.setup());

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
