import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcademicBreak, OpenDay, OpenDayPeriodStatus, RecurrenceOccurrence, SaveOpenDayScheduleRequest } from '../../api/generated/models';
import { testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { ScheduleEditorPage } from './ScheduleEditorPage';
import { longDate, timeRange } from './format';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const breakId = '0192f6f8-743e-7c77-a349-cd07c3e8a951';
const supervisorRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8a961';
const traineeRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8a962';
const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8a971';

afterEach(() => vi.restoreAllMocks());

function academicBreak(overrides: Partial<AcademicBreak> = {}): AcademicBreak {
  return {
    id: breakId,
    name: 'Autumn break',
    startsOn: '2026-10-27',
    endsOn: '2026-10-28',
    version: 1,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function openDay(overrides: Partial<OpenDay> = {}): OpenDay {
  return {
    id: openDayId,
    periodId,
    startsAt: '2026-10-26T15:00:00Z',
    endsAt: '2026-10-26T18:00:00Z',
    internalNote: 'Keep this setup',
    status: 'scheduled',
    requirements: [
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a981', kind: 'supervisor', requiredCount: 2, assignedCount: 1, eligibleRoleIds: [supervisorRoleId] },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a982', kind: 'trainee', requiredCount: 1, assignedCount: 0, eligibleRoleIds: [traineeRoleId] },
    ],
    version: 1,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

type RenderOptions = {
  items?: OpenDay[];
  recurrence?: RecurrenceOccurrence[];
  status?: OpenDayPeriodStatus;
};

function renderEditor(initialBreaks: AcademicBreak[] = [academicBreak()], options: RenderOptions = {}) {
  const breaks = initialBreaks;
  let savedBody: SaveOpenDayScheduleRequest | undefined;
  let transitionTarget: OpenDayPeriodStatus | undefined;
  const items = options.items ?? [];
  const schedule = {
    period: {
      id: periodId,
      name: 'Winter Semester 2026/27',
      startsOn: '2026-10-26',
      endsOn: '2026-10-28',
      status: options.status ?? 'draft',
      totalOpenDays: items.length,
      fullyStaffedCount: 0,
      needsStaffCount: items.length,
      openSupervisorPositions: items.length,
      cancelledCount: 0,
      myAssignmentCount: 0,
      version: 1,
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-01T10:00:00Z',
    },
    items,
    timeZone: 'Europe/Vienna',
  };
  server.use(
    http.get('*/api/v1/open-day-periods/:periodId/open-days', () => HttpResponse.json(schedule)),
    http.get('*/api/v1/open-day-eligibility-roles', () => HttpResponse.json({ items: [{ id: supervisorRoleId, name: 'Supervisor' }, { id: traineeRoleId, name: 'Trainee' }] })),
    http.get('*/api/v1/open-day-periods/:periodId/calendar-context', () => {
      return HttpResponse.json({
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: 'AT-6',
        languageCode: 'de',
        entries: [
          { name: 'Nationalfeiertag', startsOn: '2026-10-26', endsOn: '2026-10-26', category: 'publicHoliday', source: 'holidayLibrary' },
          ...breaks.map((item) => ({ id: item.id, name: item.name, startsOn: item.startsOn, endsOn: item.endsOn, category: 'academicBreak', source: 'manual' })),
        ],
        academicBreaks: breaks,
      });
    }),
    http.post('*/api/v1/open-day-periods/:periodId/schedule/recurrence-preview', () => HttpResponse.json({ occurrences: options.recurrence ?? [] })),
    http.put('*/api/v1/open-day-periods/:periodId/schedule', async ({ request }) => {
      savedBody = await request.json() as SaveOpenDayScheduleRequest;
      return HttpResponse.json(schedule);
    }),
    ...([
      ['open-for-staffing', 'staffing'],
      ['return-to-draft', 'draft'],
      ['publish', 'published'],
      ['return-to-staffing', 'staffing'],
      ['archive', 'archived'],
    ] as const).map(([path, status]) => http.post(`*/api/v1/open-day-periods/:periodId/${path}`, () => {
      transitionTarget = status;
      return HttpResponse.json({ ...schedule.period, status, version: schedule.period.version + 1 });
    })),
  );
  const router = createMemoryRouter([
    { path: '/open-days/:periodId', element: <ScheduleEditorPage /> },
    { path: '/open-days', element: <h1>Open Days overview</h1> },
  ], {
    initialEntries: [{
      pathname: `/open-days/${periodId}`,
      search: '?mode=edit',
    }],
  });
  const result = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, getSavedBody: () => savedBody, getTransitionTarget: () => transitionTarget };
}

describe('schedule editor calendar context', () => {
  it('right-aligns the editor controls in the requested order and expands filters inline', async () => {
    renderEditor([], { status: 'staffing' });
    const user = userEvent.setup();

    const heading = await screen.findByRole('heading', { name: 'Winter Semester 2026/27' });
    const pageHeader = heading.closest('.page-header')!;
    const toolbar = screen.getByRole('group', { name: 'Schedule editor tools' });
    const controls = [
      within(toolbar).getByRole('button', { name: 'Filter' }),
      within(toolbar).getByRole('button', { name: 'Undo' }),
      within(toolbar).getByRole('button', { name: 'Save' }),
      within(toolbar).getByRole('button', { name: 'Create' }),
      within(toolbar).getByRole('button', { name: 'Preview' }),
      within(toolbar).getByRole('button', { name: 'Table view' }),
    ];

    for (let index = 0; index < controls.length - 1; index += 1) {
      expect(controls[index].compareDocumentPosition(controls[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
    for (const control of [controls[0], controls[1], controls[2], controls[4]]) {
      expect(control).toHaveClass('cds--btn--icon-only');
    }
    expect(controls[3]).not.toHaveClass('cds--btn--icon-only');
    expect(within(pageHeader).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(within(pageHeader).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'Calendar view' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Period summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Day defaults' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage academic breaks' })).not.toBeInTheDocument();

    await user.click(controls[0]);
    expect(screen.getByRole('group', { name: 'Filter by day and time' })).toBeInTheDocument();
  });

  it.each([
    ['draft', ['Open for staffing'], ['Move back to Draft', 'Publish', 'Unpublish and return to staffing', 'Archive']],
    ['staffing', ['Move back to Draft', 'Publish'], ['Open for staffing', 'Unpublish and return to staffing', 'Archive']],
    ['published', ['Unpublish and return to staffing', 'Archive'], ['Open for staffing', 'Move back to Draft', 'Publish']],
  ] as const)('shows the valid lifecycle buttons while editing a %s period', async (status, visible, hidden) => {
    renderEditor([], { status });

    expect(await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).toBeInTheDocument();
    for (const label of visible) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    for (const label of hidden) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it.each([
    ['staffing', 'Move back to Draft', 'This period will no longer be visible to staff. Existing assignments will be kept.'],
    ['published', 'Unpublish and return to staffing', 'This period will no longer appear in the public calendar. Internal staffing will remain available.'],
  ] as const)('explains the consequence of moving a %s period backwards', async (status, action, confirmation) => {
    renderEditor([], { status });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: action }));

    const dialog = screen.getByRole('dialog', { name: action });
    expect(within(dialog).getByText(confirmation)).toBeInTheDocument();
  });

  it('publishes from the edit screen', async () => {
    const { getTransitionTarget } = renderEditor([], { status: 'staffing' });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Publish' })).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(getTransitionTarget()).toBe('published'));
  });

  it('shows Austrian holidays and break ranges without blocking manual Open Days', async () => {
    const { container } = renderEditor();
    const user = userEvent.setup();

    expect(await screen.findByLabelText('Public holiday: Nationalfeiertag')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Academic break: Autumn break, 27.10.2026 to 28.10.2026')).toHaveLength(2);
    const planningCalendar = screen.getByLabelText('Schedule planning calendar');
    expect(within(planningCalendar).getAllByText('Autumn break')).toHaveLength(2);
    expect(within(planningCalendar).queryByText('Academic break: Autumn break')).not.toBeInTheDocument();

    const holidayAdd = screen.getByRole('button', { name: 'Add Open Day on 26.10.2026' });
    const breakAdd = screen.getByRole('button', { name: 'Add Open Day on 27.10.2026' });
    expect(holidayAdd).toBeEnabled();
    expect(breakAdd).toBeEnabled();
    fireEvent.click(holidayAdd);
    await user.click(within(screen.getByRole('dialog', { name: 'Create Open Day' })).getByRole('button', { name: 'Create' }));
    fireEvent.click(breakAdd);
    await user.click(within(screen.getByRole('dialog', { name: 'Create Open Day' })).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(container.querySelectorAll('.calendar-slot--editable')).toHaveLength(2));
  }, 15_000);

  it('uses the shared month grid and opens an existing Open Day for editing and explicit removal', async () => {
    renderEditor([], { items: [openDay()] });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(document.querySelector('.calendar-weekdays')?.textContent).toBe('SuMoTuWeThFrSa');
    fireEvent.click(screen.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ }));
    const editDialog = await screen.findByRole('dialog', { name: 'Edit Open Day' });
    expect(within(editDialog).getByLabelText('Internal note')).toHaveValue('Keep this setup');
    await user.click(within(editDialog).getByRole('button', { name: 'Delete Open Day' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Delete Open Day?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Delete Open Day' }));
    expect(screen.queryByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  }, 30_000);

  it('configures a newly created Open Day in the create modal and saves the atomic working copy', async () => {
    const { getSavedBody } = renderEditor([], { items: [openDay()] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add Open Day on 27.10.2026' }));
    const createDialog = await screen.findByRole('dialog', { name: 'Create Open Day' });
    expect(createDialog).toHaveClass('cds--modal-container--sm');
    expect(within(createDialog).queryByLabelText('Time zone')).not.toBeInTheDocument();
    const supervisorCount = within(createDialog).getByRole('spinbutton', { name: 'Supervisors' });
    fireEvent.change(supervisorCount, { target: { value: '4' } });
    const supervisorRoles = within(createDialog).getByRole('combobox', { name: /^Eligible supervisor roles/ });
    await user.click(supervisorRoles);
    await user.click(within(createDialog).getByRole('option', { name: 'Trainee' }));
    expect(within(createDialog).getByRole('combobox', { name: /^Eligible trainee roles/ })).toBeInTheDocument();
    await user.click(within(createDialog).getByRole('button', { name: 'Create' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(getSavedBody()).toBeDefined());
    const body = getSavedBody();
    expect(body?.updates).toEqual([]);
    expect(body?.creates).toHaveLength(1);
    expect(body?.creates[0].requirements.find((item) => item.kind === 'supervisor')).toEqual({ kind: 'supervisor', requiredCount: 4, eligibleRoleIds: [supervisorRoleId, traineeRoleId] });
  }, 30_000);

  it('shows the working schedule as a table and deletes an individual draft Open Day after confirmation', async () => {
    const { getSavedBody } = renderEditor([], { items: [openDay()] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Table view' }));
    const table = screen.getByRole('table', { name: 'Editable Open Days' });
    expect(within(table).getByRole('columnheader', { name: /Date/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Time/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Supervisors' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Trainees' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Staffing status' })).not.toBeInTheDocument();
    expect(within(table).getByText('Keep this setup')).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: 'Delete Open Day' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Delete Open Day?' });
    expect(within(confirmation).getByText('This draft Open Day will be permanently deleted when you save the schedule.')).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: 'Delete Open Day' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(screen.getByRole('table', { name: 'Editable Open Days' })).queryByText('Keep this setup')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getSavedBody()).toBeDefined());
    expect(getSavedBody()?.removals).toEqual([{ id: openDayId, expectedVersion: 1 }]);
  }, 30_000);

  it('filters the editable table by multiple weekdays and start times and sorts its dates and times', async () => {
    const secondOpenDay = openDay({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a972',
      startsAt: '2026-10-27T09:00:00Z',
      endsAt: '2026-10-27T12:00:00Z',
    });
    renderEditor([], { items: [openDay(), secondOpenDay] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Table view' }));
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const weekday = screen.getByRole('combobox', { name: 'Filter by weekday' });
    const startTime = screen.getByRole('combobox', { name: 'Filter by start time' });
    const dateTimeFilters = screen.getByRole('group', { name: 'Filter by day and time' });

    await user.click(weekday);
    await user.click(within(dateTimeFilters).getByRole('option', { name: 'Monday' }));
    await waitFor(() => expect(within(dateTimeFilters).getByRole('option', { name: 'Monday' })).toHaveAttribute('aria-checked', 'true'));
    await user.click(within(dateTimeFilters).getByRole('option', { name: 'Tuesday' }));
    await waitFor(() => expect(within(dateTimeFilters).getByRole('option', { name: 'Tuesday' })).toHaveAttribute('aria-checked', 'true'));
    let table = screen.getByRole('table', { name: 'Editable Open Days' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(within(table).getByText(timeRange(secondOpenDay, 'Europe/Vienna'))).toBeInTheDocument();

    await user.click(startTime);
    await user.click(within(dateTimeFilters).getByRole('option', { name: '16:00' }));
    await waitFor(() => expect(within(dateTimeFilters).getByRole('option', { name: '16:00' })).toHaveAttribute('aria-checked', 'true'));
    expect(within(screen.getByRole('table', { name: 'Editable Open Days' })).getAllByRole('row')).toHaveLength(2);
    await user.click(within(dateTimeFilters).getByRole('option', { name: '10:00' }));
    await waitFor(() => expect(within(dateTimeFilters).getByRole('option', { name: '10:00' })).toHaveAttribute('aria-checked', 'true'));
    expect(within(dateTimeFilters).getByRole('option', { name: '16:00' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Editable Open Days' })).getAllByRole('row')).toHaveLength(3));

    table = screen.getByRole('table', { name: 'Editable Open Days' });
    const dateHeader = within(table).getByRole('columnheader', { name: /Date/ });
    await user.click(within(dateHeader).getByRole('button'));
    await user.click(within(dateHeader).getByRole('button'));
    expect(within(within(table).getAllByRole('row')[1]).getByText(longDate(secondOpenDay.startsAt, 'Europe/Vienna'))).toBeInTheDocument();

    const timeHeader = within(table).getByRole('columnheader', { name: /Time/ });
    await user.click(within(timeHeader).getByRole('button'));
    await user.click(within(timeHeader).getByRole('button'));
    expect(within(within(table).getAllByRole('row')[1]).getByText(timeRange(openDay(), 'Europe/Vienna'))).toBeInTheDocument();
  }, 30_000);

  it('bulk edits selected Open Days while preserving their dates', async () => {
    const secondOpenDayId = '0192f6f8-743e-7c77-a349-cd07c3e8a972';
    const { getSavedBody } = renderEditor([], { items: [openDay(), openDay({ id: secondOpenDayId, startsAt: '2026-10-27T15:00:00Z', endsAt: '2026-10-27T18:00:00Z' })] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Table view' }));
    for (const checkbox of screen.getAllByRole('checkbox', { name: /select row/i })) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Edit selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit 2 selected Open Days' });
    fireEvent.change(within(dialog).getByLabelText('Start'), { target: { value: '17:00' } });
    fireEvent.change(within(dialog).getByLabelText('End'), { target: { value: '20:00' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Supervisors required' }), { target: { value: '4' } });
    fireEvent.change(within(dialog).getByLabelText('Internal note'), { target: { value: 'Shared setup' } });
    await user.click(within(dialog).getByRole('button', { name: 'Apply to selected' }));
    expect(screen.getAllByText('Shared setup')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getSavedBody()).toBeDefined());
    const updates = getSavedBody()?.updates ?? [];
    expect(updates).toHaveLength(2);
    expect(updates.map((item) => item.startsAt.slice(0, 10))).toEqual(['2026-10-26', '2026-10-27']);
    expect(updates.every((item) => item.internalNote === 'Shared setup')).toBe(true);
    expect(updates.every((item) => item.requirements.find((requirement) => requirement.kind === 'supervisor')?.requiredCount === 4)).toBe(true);
  }, 30_000);

  it('shows mixed bulk values and applies only the fields the user changes', async () => {
    const secondOpenDayId = '0192f6f8-743e-7c77-a349-cd07c3e8a972';
    const first = openDay();
    const second = openDay({
      id: secondOpenDayId,
      startsAt: '2026-10-27T08:00:00Z',
      endsAt: '2026-10-27T11:00:00Z',
      internalNote: 'Different setup',
      requirements: [
        { id: '0192f6f8-743e-7c77-a349-cd07c3e8a983', kind: 'supervisor', requiredCount: 5, assignedCount: 0, eligibleRoleIds: [traineeRoleId] },
        { id: '0192f6f8-743e-7c77-a349-cd07c3e8a984', kind: 'trainee', requiredCount: 3, assignedCount: 0, eligibleRoleIds: [supervisorRoleId] },
      ],
    });
    const { getSavedBody } = renderEditor([], { items: [first, second] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Table view' }));
    for (const checkbox of screen.getAllByRole('checkbox', { name: /select row/i })) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Edit selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit 2 selected Open Days' });

    expect(dialog).toHaveClass('cds--modal-container--sm');
    expect(within(dialog).getByText('Only values you change are applied.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Fields that differ/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Start')).toHaveValue('');
    expect(within(dialog).getByLabelText('Start')).toHaveAttribute('placeholder', 'Mixed');
    expect(within(dialog).getByLabelText('End')).toHaveAttribute('placeholder', 'Mixed');
    expect(within(dialog).getByRole('spinbutton', { name: 'Supervisors required' })).toHaveAttribute('placeholder', 'Mixed');
    expect(within(dialog).getByRole('spinbutton', { name: 'Trainees required' })).toHaveAttribute('placeholder', 'Mixed');
    expect(within(dialog).getByLabelText('Internal note')).toHaveAttribute('placeholder', 'Mixed');
    const supervisorRoles = within(dialog).getByRole('combobox', { name: /^Eligible supervisor roles/ });
    expect(supervisorRoles).toHaveTextContent('Mixed');
    expect(within(dialog).getByRole('button', { name: 'Apply to selected' })).toBeDisabled();

    await user.click(supervisorRoles);
    await user.click(within(dialog).getByRole('option', { name: 'Supervisor' }));
    await user.click(within(dialog).getByRole('option', { name: 'Trainee' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply to selected' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(getSavedBody()).toBeDefined());
    const updates = new Map((getSavedBody()?.updates ?? []).map((item) => [item.id, item]));
    expect(updates.get(first.id)).toMatchObject({ startsAt: first.startsAt, endsAt: first.endsAt, internalNote: first.internalNote });
    expect(updates.get(second.id)).toMatchObject({ startsAt: second.startsAt, endsAt: second.endsAt, internalNote: second.internalNote });
    expect(updates.get(first.id)?.requirements.find((item) => item.kind === 'supervisor')).toMatchObject({ requiredCount: 2, eligibleRoleIds: [supervisorRoleId, traineeRoleId] });
    expect(updates.get(second.id)?.requirements.find((item) => item.kind === 'supervisor')).toMatchObject({ requiredCount: 5, eligibleRoleIds: [supervisorRoleId, traineeRoleId] });
    expect(updates.get(first.id)?.requirements.find((item) => item.kind === 'trainee')).toMatchObject({ requiredCount: 1, eligibleRoleIds: [traineeRoleId] });
    expect(updates.get(second.id)?.requirements.find((item) => item.kind === 'trainee')).toMatchObject({ requiredCount: 3, eligibleRoleIds: [supervisorRoleId] });
  }, 30_000);

  it('bulk deletes selected draft Open Days as one working-copy action', async () => {
    const secondOpenDayId = '0192f6f8-743e-7c77-a349-cd07c3e8a972';
    const { getSavedBody } = renderEditor([], { items: [openDay(), openDay({ id: secondOpenDayId, startsAt: '2026-10-27T15:00:00Z', endsAt: '2026-10-27T18:00:00Z' })] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Table view' }));
    for (const checkbox of screen.getAllByRole('checkbox', { name: /select row/i })) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Delete selected?' });
    expect(within(confirmation).getByText('These 2 draft Open Days will be permanently deleted when you save the schedule.')).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: 'Delete selected' }));
    expect(within(screen.getByRole('table', { name: 'Editable Open Days' })).getAllByRole('row')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getSavedBody()).toBeDefined());
    expect(getSavedBody()?.removals).toEqual([
      { id: openDayId, expectedVersion: 1 },
      { id: secondOpenDayId, expectedVersion: 1 },
    ]);
  }, 30_000);

  it('switches in place without discarding unsaved changes and still blocks leaving the period', async () => {
    const { router } = renderEditor([]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add Open Day on 26.10.2026' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Create Open Day' })).getByRole('button', { name: 'Create' }));
    const blockerDialog = screen.getByRole('dialog', { name: 'Discard unsaved schedule changes?' });
    expect(blockerDialog.closest('.cds--modal')).not.toHaveClass('is-visible');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('group', { name: 'Open Days tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveClass('cds--btn--icon-only');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveClass('cds--btn--icon-only');
    expect(blockerDialog.closest('.cds--modal')).not.toHaveClass('is-visible');
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('button', { name: /Supervisor position open/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('group', { name: 'Schedule editor tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Open Days' }));
    await waitFor(() => expect(blockerDialog.closest('.cds--modal')).toHaveClass('is-visible'));
    await user.click(within(blockerDialog).getByRole('button', { name: 'Keep editing' }));
  }, 30_000);

  it('shows the period preview in the same page shell when there are no unsaved changes', async () => {
    const { router } = renderEditor([]);
    const user = userEvent.setup();

    const page = (await screen.findByRole('heading', { name: 'Winter Semester 2026/27' })).closest('.page-shell');
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByRole('group', { name: 'Open Days tools' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Winter Semester 2026/27' }).closest('.page-shell')).toBe(page);
    expect(screen.queryByRole('group', { name: 'Schedule editor tools' })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/open-days/${periodId}`);
    expect(router.state.location.search).toBe('');
  });

  it('adds reviewed recurrence occurrences without requiring secure-context browser APIs', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is unavailable');
    });
    renderEditor([], { recurrence: [{ date: '2026-10-28', startsAt: '2026-10-28T15:00:00Z', endsAt: '2026-10-28T18:00:00Z', disposition: 'create' }] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Create' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Open Day' });
    await user.click(within(dialog).getByRole('radio', { name: 'Series' }));
    await user.click(within(dialog).getByRole('button', { name: 'Preview series' }));
    expect(await within(dialog).findByRole('checkbox', { name: '28.10.2026 · create' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add selected' }));
    expect(screen.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  }, 30_000);

  it('asks for confirmation only when saving changes to a published schedule', async () => {
    const { getSavedBody } = renderEditor([], { status: 'published' });
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Winter Semester 2026/27' });
    expect(screen.queryByText('Published schedule')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Open Day on 26.10.2026' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Create Open Day' })).getByRole('button', { name: 'Create' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Save changes to published schedule?' });
    expect(getSavedBody()).toBeUndefined();
    expect(within(confirmation).getByText(/update the public calendar and calendar feed/i)).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: 'Save published schedule' }));

    await waitFor(() => expect(getSavedBody()?.creates).toHaveLength(1));
  }, 30_000);

  it('keeps academic-break management off the edit screen', async () => {
    renderEditor([academicBreak({ name: 'Winter break' })]);

    expect(await screen.findAllByLabelText('Academic break: Winter break, 27.10.2026 to 28.10.2026')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Manage academic breaks' })).not.toBeInTheDocument();
  });
});
