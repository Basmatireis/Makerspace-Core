import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  type AttendanceHold,
  type ConfirmLaborordnungRequest,
  type LaborordnungRequest,
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

    expect((await screen.findAllByText('Katherine Johnson')).length).toBeGreaterThan(0);
    expect(screen.getByText('Awaiting sign-off', { selector: '.cds--tag *' })).toBeInTheDocument();
    expect(screen.getByText('Waiting since', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('0 checked in · 1 awaiting sign-off')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting for Lab Rules confirmation' })).toBeInTheDocument();
    expect(screen.getByText(/at the entrance since/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Katherine Johnson' }));
    expect(await screen.findAllByText('Cancel check-in')).not.toHaveLength(0);
    await user.click(
      (await screen.findAllByText('Confirm Lab Rules')).find((el) => el.closest('.cds--overflow-menu-options'))!,
    );
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
    await waitFor(() => expect(screen.queryByText('Katherine Johnson')).not.toBeInTheDocument());
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

    const user = userEvent.setup();
    expect((await screen.findAllByText('Katherine Johnson')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Actions for Katherine Johnson' }));
    expect(await screen.findAllByText('Cancel check-in')).not.toHaveLength(0);
    expect(screen.queryByText('Confirm Lab Rules')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm Lab Rules for/ })).not.toBeInTheDocument();
  });
});

describe('Lab Rules confirmation notice', () => {
  const request: LaborordnungRequest = {
    id: hold.laborordnungRequestId!,
    personId: hold.personId,
    personName: 'Katherine Johnson',
    requiredVersion: { humanRevision: 'R2' } as LaborordnungRequest['requiredVersion'],
    previousVersion: null,
    status: 'pending',
    requestedAt: '2026-10-11T08:30:00Z',
    completedAt: null,
    physicalDocumentReference: null,
    signedDate: null,
    archiveNote: null,
  };
  const other: LaborordnungRequest = {
    ...request,
    id: '01995ea6-6d00-7000-8000-000000000401',
    personId: '01995ea6-6d00-7000-8000-000000000402',
    personName: 'Mary Jackson',
  };

  it('lists people at the entrance first, then other open requests, and confirms from the notice', async () => {
    let requests = [request, other];
    let confirmedId: string | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.attendanceread,
            PermissionId.laborordnungrequestsread,
            PermissionId.laborordnungconfirm,
          ]),
        ),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [hold] })),
      http.get('*/api/v1/laborordnung/requests', () => HttpResponse.json({ items: requests })),
      http.post('*/api/v1/laborordnung/requests/:requestId/confirm', ({ params }) => {
        confirmedId = params.requestId as string;
        requests = requests.filter((item) => item.id !== confirmedId);
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/attendance');

    expect(await screen.findByRole('heading', { name: 'Waiting for Lab Rules confirmation' })).toBeInTheDocument();
    expect(await screen.findByText('Mary Jackson')).toBeInTheDocument();
    // The person at the entrance appears once in the notice (plus once in the table), never as a second request.
    expect(screen.getAllByRole('button', { name: 'Confirm Lab Rules for Katherine Johnson' })).toHaveLength(1);
    expect(screen.getByText(/Lab Rules revision R2 · requested/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm Lab Rules for Mary Jackson' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Physical document reference'), 'Folder 1');
    await user.click(within(dialog).getByRole('checkbox', { name: /I have seen Mary Jackson's signature/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and check in' }));

    await waitFor(() => expect(confirmedId).toBe(other.id));
    await waitFor(() => expect(screen.queryByText('Mary Jackson')).not.toBeInTheDocument());
  });

  it('shows a calm notice when only requests are open and nothing when none are', async () => {
    let requests = [other];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(
          currentUserFixture([
            PermissionId.attendanceread,
            PermissionId.laborordnungrequestsread,
            PermissionId.laborordnungconfirm,
          ]),
        ),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/laborordnung/requests', () => HttpResponse.json({ items: requests })),
    );
    const { unmount } = renderRoute(<App />, '/attendance');
    expect(await screen.findByRole('heading', { name: 'Lab Rules to confirm' })).toBeInTheDocument();
    expect(screen.getByText('Mary Jackson')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Waiting for Lab Rules confirmation' })).not.toBeInTheDocument();
    unmount();

    requests = [];
    renderRoute(<App />, '/attendance');
    await screen.findByRole('heading', { name: 'Attendance' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Lab Rules to confirm' })).not.toBeInTheDocument(),
    );
  });

  it('does not fetch requests without laborordnung.requests.read', async () => {
    let queueRequested = false;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.attendanceread]))),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/laborordnung/requests', () => {
        queueRequested = true;
        return HttpResponse.json({ items: [request] });
      }),
    );
    renderRoute(<App />, '/attendance');
    expect(
      await screen.findByText('Currently here', { selector: 'h4, .cds--data-table-header__title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lab Rules to confirm' })).not.toBeInTheDocument();
    expect(queueRequested).toBe(false);
  });

  it('shows requests read-only without laborordnung.confirm', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.attendanceread, PermissionId.laborordnungrequestsread])),
      ),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/attendance/holds', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/laborordnung/requests', () => HttpResponse.json({ items: [request] })),
    );
    renderRoute(<App />, '/attendance');
    expect(await screen.findByText('Katherine Johnson')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm Lab Rules for/ })).not.toBeInTheDocument();
  });
});
