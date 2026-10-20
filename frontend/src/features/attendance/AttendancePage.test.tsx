import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type Visit, type VoidVisitRequest } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
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

    await user.click(await screen.findByRole('button', { name: 'Void record' }));
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

  it('does not expose correction controls without attendance.correct', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.attendanceread]))),
      http.get('*/api/v1/visits', () => HttpResponse.json({ items: [visit] })),
    );
    renderRoute(<App />, '/attendance');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void record' })).not.toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Assisted check-in' })).toBeInTheDocument();
    expect(visitListRequested).toBe(false);
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
  });
});
