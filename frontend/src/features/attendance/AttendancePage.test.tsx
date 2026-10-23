import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  type AttendanceHold,
  type ConfirmLaborordnungRequest,
  PermissionId,
  type Visit,
  type VoidVisitRequest,
} from '../../api/generated/models';
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

const hold: AttendanceHold = {
  id: '01995ea6-6d00-7000-8000-000000000301',
  personId: '01995ea6-6d00-7000-8000-000000000302',
  displayName: 'Katherine Johnson',
  requestedAt: '2026-10-11T08:30:00Z',
  expiresAt: '2026-10-11T09:30:00Z',
  checkInMethod: 'pin',
  laborordnungRequestId: '01995ea6-6d00-7000-8000-000000000303',
  requiredRevision: 'R2',
  previousRevision: null,
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
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [] })),
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

describe('Lab Rules hold', () => {
  it('lists held check-ins and confirms the signed document', async () => {
    let holds = [hold];
    let submitted: ConfirmLaborordnungRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.attendanceread,
            PermissionId.attendanceassist,
            PermissionId.laborordnungconfirm,
          ]),
        ),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: holds })),
      http.post('*/api/v1/laborordnung/requests/:requestId/confirm', async ({ request }) => {
        submitted = (await request.json()) as ConfirmLaborordnungRequest;
        holds = [];
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/attendance');

    expect(await screen.findByText('Waiting for Lab Rules confirmation')).toBeInTheDocument();
    expect(screen.getByText('Katherine Johnson')).toBeInTheDocument();
    expect(screen.getByText(/Has never signed the Lab Rules/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel check-in' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm Lab Rules' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and check in' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Physical document reference'), 'Folder 2, page 14');
    await user.click(
      within(dialog).getByRole('checkbox', { name: /I have seen Katherine Johnson's signature on revision R2/ }),
    );
    await user.click(confirm);

    await waitFor(() =>
      expect(submitted).toEqual({
        physicalDocumentReference: 'Folder 2, page 14',
        signedDate: null,
        archiveNote: null,
      }),
    );
    await waitFor(() => expect(screen.queryByText('Waiting for Lab Rules confirmation')).not.toBeInTheDocument());
  });

  it('continues an assisted check-in that comes back held in the confirmation step', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.attendanceread,
            PermissionId.attendanceassist,
            PermissionId.laborordnungconfirm,
            PermissionId.peoplereadall,
          ]),
        ),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/people', () =>
        HttpResponse.json({
          items: [personFixture({ id: hold.personId, firstName: 'Katherine', lastName: 'Johnson' })],
          page: 1,
          pageSize: 25,
          total: 1,
        }),
      ),
      http.post('*/api/v1/visits', () => HttpResponse.json(hold, { status: 202 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/attendance');

    await user.click(await screen.findByRole('button', { name: 'Check someone in' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByText('Katherine Johnson'));
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }));

    expect(await screen.findByText('Confirm Lab Rules for Katherine Johnson')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm and check in' })).toBeDisabled();
  });

  it('shows no confirm button without laborordnung.confirm', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.attendanceread, PermissionId.attendanceassist])),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [hold] })),
    );
    renderRoute(<App />, '/attendance');

    expect(await screen.findByText('Katherine Johnson')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel check-in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Lab Rules' })).not.toBeInTheDocument();
  });
});
