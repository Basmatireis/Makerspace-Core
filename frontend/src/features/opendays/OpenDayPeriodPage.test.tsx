import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpenDayPeriodStatus, PermissionId as Permission } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('./ScheduleEditorPage', () => ({
  ScheduleEditorPage: () => <h1>Schedule planning</h1>,
}));

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';

function period(status: OpenDayPeriodStatus = 'staffing') {
  return {
    id: periodId,
    name: 'Winter Semester 2026/27',
    startsOn: '2026-10-01',
    endsOn: '2026-10-01',
    status,
    totalOpenDays: 0,
    fullyStaffedCount: 0,
    needsStaffCount: 0,
    cancelledCount: 0,
    myAssignmentCount: 0,
    version: 3,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
  };
}

function mockPeriodPage(status: OpenDayPeriodStatus, permissions: Permission[] = [PermissionId.open_daysmanage]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/open-day-periods/:periodId/open-days', () =>
      HttpResponse.json({ period: period(status), items: [], timeZone: 'Europe/Vienna' }),
    ),
    http.get('*/api/v1/open-day-periods/:periodId/calendar-context', () =>
      HttpResponse.json({
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: 'AT-6',
        languageCode: 'de',
        entries: [],
        academicBreaks: [],
      }),
    ),
  );
}

describe('Open Day period lifecycle controls', () => {
  it.each([
    ['draft', ['Open for staffing'], ['Move back to Draft', 'Publish', 'Unpublish and return to staffing', 'Archive']],
    ['staffing', ['Move back to Draft', 'Publish'], ['Open for staffing', 'Unpublish and return to staffing', 'Archive']],
    ['published', ['Unpublish and return to staffing', 'Archive'], ['Open for staffing', 'Move back to Draft', 'Publish']],
    ['archived', [], ['Open for staffing', 'Move back to Draft', 'Publish', 'Unpublish and return to staffing', 'Archive']],
  ] as const)('shows only valid actions for %s periods', async (status, visible, hidden) => {
    mockPeriodPage(status);
    renderRoute(<App />, `/open-days/${periodId}`);

    expect(await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();
    for (const label of visible) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    for (const label of hidden) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it.each([
    ['staffing', 'Move back to Draft', 'This period will no longer be visible to staff. Existing assignments will be kept.'],
    ['published', 'Unpublish and return to staffing', 'This period will no longer appear in the public calendar. Internal staffing will remain available.'],
  ] as const)('explains the consequence of moving a %s period backwards', async (status, action, confirmation) => {
    mockPeriodPage(status);
    renderRoute(<App />, `/open-days/${periodId}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: action }));

    expect(screen.getByText(confirmation)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hides management transitions from readers', async () => {
    mockPeriodPage('staffing', [PermissionId.open_daysread]);
    renderRoute(<App />, `/open-days/${periodId}`);

    expect(await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move back to Draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit schedule' })).not.toBeInTheDocument();
  });
});

describe('Open Day period creation', () => {
  it('opens the schedule editor immediately after creating a draft period', async () => {
    const created = period('draft');
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.open_daysmanage]))),
      http.get('*/api/v1/open-day-periods', () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/open-day-periods', () => HttpResponse.json(created, { status: 201 })),
      http.get('*/api/v1/open-day-periods/:periodId/open-days', () =>
        HttpResponse.json({ period: created, items: [], timeZone: 'Europe/Vienna' }),
      ),
      http.get('*/api/v1/open-day-eligibility-roles', () => HttpResponse.json({ items: [] })),
    );
    renderRoute(<App />, '/open-days');
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole('button', { name: 'New period' }))[0]);
    await user.type(screen.getByLabelText('Name'), created.name);
    await user.type(screen.getByLabelText('Start date'), created.startsOn);
    await user.type(screen.getByLabelText('End date'), created.endsOn);
    await user.click(screen.getByRole('button', { name: 'Create period' }));

    expect(await screen.findByRole('heading', { name: 'Schedule planning' })).toBeInTheDocument();
  });
});
