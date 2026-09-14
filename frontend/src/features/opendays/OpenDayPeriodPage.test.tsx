import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpenDay, OpenDayPeriodStatus, OpenDayRequirementKind, PermissionId as Permission } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('./ScheduleEditorPage', () => ({
  ScheduleEditorPage: () => <h1>Schedule planning</h1>,
}));

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';

function requirement(id: string, kind: OpenDayRequirementKind, assignedCount: number, requiredCount: number) {
  return { id, kind, assignedCount, requiredCount };
}

function openDay(id: string, startsOn: string, overrides: Partial<OpenDay> = {}): OpenDay {
  return {
    id,
    periodId,
    startsAt: `${startsOn}T08:00:00Z`,
    endsAt: `${startsOn}T11:00:00Z`,
    status: 'scheduled',
    requirements: [
      requirement(`${id.slice(0, -1)}1`, 'supervisor', 2, 2),
      requirement(`${id.slice(0, -1)}2`, 'trainee', 1, 1),
    ],
    version: 1,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

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
    openSupervisorPositions: 3,
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
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();
    if (status === 'archived') {
      expect(screen.queryByRole('button', { name: 'Actions' })).not.toBeInTheDocument();
      return;
    }
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Create recurring' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit schedule' })).toBeInTheDocument();
    for (const label of visible) expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    for (const label of hidden) expect(screen.queryByRole('menuitem', { name: label })).not.toBeInTheDocument();
  });

  it.each([
    ['staffing', 'Move back to Draft', 'This period will no longer be visible to staff. Existing assignments will be kept.'],
    ['published', 'Unpublish and return to staffing', 'This period will no longer appear in the public calendar. Internal staffing will remain available.'],
  ] as const)('explains the consequence of moving a %s period backwards', async (status, action, confirmation) => {
    mockPeriodPage(status);
    renderRoute(<App />, `/open-days/${periodId}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: action }));

    expect(screen.getByText(confirmation)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hides management transitions from readers', async () => {
    mockPeriodPage('staffing', [PermissionId.open_daysread]);
    renderRoute(<App />, `/open-days/${periodId}`);

    expect(await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions' })).not.toBeInTheDocument();
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

describe('Open Day period management entry points', () => {
  function mockPeriodList(permissions: Permission[]) {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
      http.get('*/api/v1/open-day-periods', () => HttpResponse.json({ items: [period('draft')] })),
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

  it('shows the backend supervisor-position aggregate and opens planning from a manager card', async () => {
    mockPeriodList([PermissionId.open_daysmanage]);
    renderRoute(<App />, '/open-days');
    const user = userEvent.setup();

    const label = await screen.findByText('Open supervisor positions');
    expect(within(label.parentElement!).getByText('3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit period' }));

    expect(await screen.findByRole('heading', { name: 'Schedule planning' })).toBeInTheDocument();
  });

  it('does not show a period card Edit action to readers', async () => {
    mockPeriodList([PermissionId.open_daysread]);
    renderRoute(<App />, '/open-days');

    expect(await screen.findByText('Open supervisor positions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit period' })).not.toBeInTheDocument();
  });

  it('opens the same planning workflow from Manage Open Days', async () => {
    mockPeriodList([PermissionId.open_daysmanage]);
    renderRoute(<App />, '/open-days/manage');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Edit period' }));

    expect(await screen.findByRole('heading', { name: 'Schedule planning' })).toBeInTheDocument();
  });
});

describe('Open Day table and calendar filters', () => {
  const supervisorVacancy = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a921', '2026-10-01', {
    requirements: [
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a931', 'supervisor', 1, 2),
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a932', 'trainee', 1, 1),
    ],
  });
  const traineeVacancy = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a922', '2026-10-02', {
    requirements: [
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a933', 'supervisor', 2, 2),
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a934', 'trainee', 0, 1),
    ],
  });
  const fullyStaffedMine = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a923', '2026-10-03', {
    myAssignment: {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
      openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
      requirementId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
      personId,
      displayName: 'Ada Lovelace',
      isCurrentUser: true,
      createdAt: '2026-09-02T10:00:00Z',
    },
  });
  const cancelledMine = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a924', '2026-10-04', {
    status: 'cancelled',
    requirements: [
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a935', 'supervisor', 0, 2),
      requirement('0192f6f8-743e-7c77-a349-cd07c3e8a936', 'trainee', 1, 1),
    ],
    myAssignment: {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
      openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a924',
      requirementId: '0192f6f8-743e-7c77-a349-cd07c3e8a935',
      personId,
      displayName: 'Ada Lovelace',
      isCurrentUser: true,
      createdAt: '2026-09-02T10:00:00Z',
    },
  });

  function mockFilteredPeriodPage(permissions: Permission[] = [PermissionId.open_daysread]) {
    const openDays = [supervisorVacancy, traineeVacancy, fullyStaffedMine, cancelledMine];
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
      http.get('*/api/v1/open-day-periods/:periodId/open-days', () =>
        HttpResponse.json({
          period: { ...period('staffing'), endsOn: '2026-10-04', totalOpenDays: 4 },
          items: openDays,
          timeZone: 'UTC',
        }),
      ),
      http.get('*/api/v1/open-days/:openDayId', ({ params }) => {
        const selected = openDays.find((day) => day.id === params.openDayId);
        if (!selected) return new HttpResponse(null, { status: 404 });
        return HttpResponse.json({
          ...selected,
          requirements: selected.requirements.map((item) => ({ ...item, assignments: [] })),
        });
      }),
      http.get('*/api/v1/open-day-periods/:periodId/calendar-context', () =>
        HttpResponse.json({
          timeZone: 'UTC',
          countryCode: 'AT',
          subdivisionCode: 'AT-6',
          languageCode: 'de',
          entries: [
            { name: 'National Day', startsOn: '2026-10-01', endsOn: '2026-10-01', category: 'publicHoliday', source: 'holidayLibrary' },
            { id: '0192f6f8-743e-7c77-a349-cd07c3e8a951', name: 'Autumn break', startsOn: '2026-10-02', endsOn: '2026-10-04', category: 'academicBreak', source: 'manual' },
          ],
          academicBreaks: [],
        }),
      ),
    );
  }

  it('uses accessible status icons, removes empty trailing weeks, and starts weeks on Sunday', async () => {
    mockFilteredPeriodPage();
    const { container } = renderRoute(<App />, `/open-days/${periodId}`);

    const calendar = await screen.findByLabelText('Semester calendar');
    const legend = screen.getByLabelText('Calendar status legend');
    expect(Array.from(legend.querySelectorAll('.calendar-legend__group--context > span')).map((item) => item.textContent)).toEqual([
      'Public holiday',
      'Academic break',
      'Cancelled',
    ]);
    expect(Array.from(legend.querySelectorAll('.calendar-legend__group--staffing > span')).map((item) => item.textContent)).toEqual([
      'Fully staffed',
      'Supervisor position open',
      'Your assignment',
    ]);
    expect(within(calendar).getByTitle('Supervisor position open')).toBeInTheDocument();
    expect(within(calendar).getByTitle('Trainee position open')).toBeInTheDocument();
    expect(within(calendar).getByTitle('Fully staffed')).toBeInTheDocument();
    expect(within(calendar).getByTitle('Cancelled')).toBeInTheDocument();
    expect(within(calendar).getAllByTitle('Your assignment')).toHaveLength(2);
    expect(within(calendar).getByText('National Day')).toBeInTheDocument();
    expect(within(calendar).queryByText('Public holiday: National Day')).not.toBeInTheDocument();
    expect(within(calendar).getByText('Autumn break')).toBeInTheDocument();
    expect(within(calendar).getAllByLabelText('Academic break: Autumn break, 2026-10-02 to 2026-10-04')).toHaveLength(3);

    const staffedEvent = within(calendar).getByTitle('Fully staffed').closest('.calendar-slot');
    const cancelledEvent = within(calendar).getByTitle('Cancelled').closest('.calendar-slot');
    expect(staffedEvent).toHaveClass('calendar-slot--staffed');
    expect(cancelledEvent).toHaveClass('calendar-slot--cancelled');
    expect(within(staffedEvent as HTMLElement).getByTitle('Your assignment')).toBeInTheDocument();
    expect(within(staffedEvent as HTMLElement).getByTitle('2 other people registered')).toBeInTheDocument();
    expect(within(staffedEvent as HTMLElement).getByText('+2')).toBeInTheDocument();
    expect(within(staffedEvent as HTMLElement).queryByTitle('3 people registered')).not.toBeInTheDocument();
    expect(within(cancelledEvent as HTMLElement).getByTitle('Your assignment')).toBeInTheDocument();
    expect(within(cancelledEvent as HTMLElement).queryByTitle(/other (person|people) registered/)).not.toBeInTheDocument();

    const vacancyEvent = within(calendar).getByTitle('Supervisor position open').closest('.calendar-slot');
    expect(within(vacancyEvent as HTMLElement).getByTitle('2 people registered')).toBeInTheDocument();
    expect(within(vacancyEvent as HTMLElement).queryByText(/^\+/)).not.toBeInTheDocument();

    const holidayMarker = within(calendar).getByText('National Day').closest('.calendar-marker');
    const holidayIcon = within(calendar).getByLabelText('Public holiday: National Day');
    const breakMarker = within(calendar).getByText('Autumn break').closest('.calendar-marker');
    expect(holidayMarker).toHaveClass('calendar-marker--label');
    expect(holidayMarker?.closest('.calendar-cell__header')).toBeNull();
    expect(holidayIcon.parentElement).toHaveClass('calendar-cell__context');
    expect(breakMarker?.parentElement).toHaveClass('calendar-cell__context');
    expect(breakMarker?.closest('.calendar-cell__header')).not.toBeNull();

    const weekdays = container.querySelector('.calendar-weekdays');
    expect(Array.from(weekdays?.children ?? []).map((item) => item.textContent)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    expect(container.querySelectorAll('.calendar-month:first-child .calendar-cell--empty')).toHaveLength(4);
    expect(container.querySelectorAll('.calendar-month:first-child .calendar-days > .calendar-cell')).toHaveLength(35);
    expect(container.querySelector<HTMLElement>('.calendar-month:first-child .calendar-days')?.style.gridTemplateRows).toBe('repeat(5, minmax(5rem, auto))');
  });

  it('shares filters across views and preserves the active selection', async () => {
    mockFilteredPeriodPage();
    const { container } = renderRoute(<App />, `/open-days/${periodId}`);
    const user = userEvent.setup();

    await screen.findByLabelText('Semester calendar');

    const viewSwitcher = container.querySelector<HTMLElement>('[aria-label="Open Days view"]');
    const filterSwitcher = container.querySelector<HTMLElement>('[aria-label="Filter Open Days"]');
    const sharedToolbar = screen.getByLabelText('Open Days tools');
    expect(viewSwitcher).not.toBeNull();
    expect(filterSwitcher).not.toBeNull();
    expect(within(filterSwitcher!).getAllByRole('button')).toHaveLength(3);
    expect(within(filterSwitcher!).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(viewSwitcher!).getByRole('button', { name: 'Calendar view' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(viewSwitcher!).getByRole('button', { name: 'Table view' }));
    expect(screen.getByLabelText('Open Days tools')).toBe(sharedToolbar);
    expect(within(viewSwitcher!).getByRole('button', { name: 'Table view' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);

    await user.click(within(filterSwitcher!).getByText('Needs staff'));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    await user.click(within(viewSwitcher!).getByRole('button', { name: 'Calendar view' }));
    expect(screen.getByLabelText('Open Days tools')).toBe(sharedToolbar);
    const filteredCalendar = screen.getByLabelText('Semester calendar');
    expect(within(filteredCalendar).getByTitle('Supervisor position open')).toBeInTheDocument();
    expect(within(filteredCalendar).queryByTitle('Trainee position open')).not.toBeInTheDocument();
    expect(within(filteredCalendar).queryByTitle('Fully staffed')).not.toBeInTheDocument();
    expect(within(filteredCalendar).queryByTitle('Cancelled')).not.toBeInTheDocument();

    await user.click(within(filterSwitcher!).getByText('My Open Days'));
    expect(within(screen.getByLabelText('Semester calendar')).getAllByTitle('Your assignment')).toHaveLength(2);

    await user.click(within(viewSwitcher!).getByRole('button', { name: 'Table view' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);

    await user.click(within(filterSwitcher!).getByText('All'));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
  });

  it('shows date details on hover and handles self-registration in a modal', async () => {
    let joinedRequirementId = '';
    mockFilteredPeriodPage([PermissionId.open_daysread, PermissionId.open_dayssignup]);
    server.use(
      http.put('*/api/v1/open-days/:openDayId/assignments/me', async ({ request }) => {
        joinedRequirementId = String((await request.json() as { requirementId: string }).requirementId);
        return HttpResponse.json({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a999',
          openDayId: supervisorVacancy.id,
          requirementId: joinedRequirementId,
          personId,
          displayName: 'Ada Lovelace',
          isCurrentUser: true,
          createdAt: '2026-09-02T10:00:00Z',
        });
      }),
    );
    const { container } = renderRoute(<App />, `/open-days/${periodId}`);
    const user = userEvent.setup();

    const calendar = await screen.findByLabelText('Semester calendar');
    const openDayButton = within(calendar).getByRole('button', { name: /Supervisor position open/ });
    const dateTrigger = openDayButton.closest('.calendar-cell')?.querySelector<HTMLElement>('.calendar-cell__date-tooltip');
    expect(dateTrigger).not.toBeNull();

    await user.hover(dateTrigger!);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Public holiday: National Day');
    expect(tooltip).toHaveTextContent(/08:00.*11:00.*Supervisor position open/);
    await user.unhover(dateTrigger!);

    await user.click(openDayButton);
    const registration = await screen.findByRole('dialog', { name: /Thursday, October 1, 2026/ });
    expect(within(registration).getByText(/08:00.*11:00/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();

    await user.click(within(registration).getByRole('button', { name: 'Join as supervisor' }));
    await waitFor(() => expect(joinedRequirementId).toBe(supervisorVacancy.requirements[0].id));
    expect(container.querySelector('.open-day-period-page')).toBeInTheDocument();
  });
});
