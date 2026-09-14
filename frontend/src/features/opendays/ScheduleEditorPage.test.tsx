import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AcademicBreak, CreateAcademicBreakRequest, OpenDay, RecurrenceOccurrence, SaveOpenDayScheduleRequest, UpdateAcademicBreakRequest } from '../../api/generated/models';
import { testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { ScheduleEditorPage } from './ScheduleEditorPage';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const breakId = '0192f6f8-743e-7c77-a349-cd07c3e8a951';
const createdBreakId = '0192f6f8-743e-7c77-a349-cd07c3e8a952';
const supervisorRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8a961';
const traineeRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8a962';
const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8a971';

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
};

function renderEditor(initialBreaks: AcademicBreak[] = [academicBreak()], options: RenderOptions = {}) {
  let breaks = initialBreaks;
  let contextRequests = 0;
  let savedBody: SaveOpenDayScheduleRequest | undefined;
  const items = options.items ?? [];
  const schedule = {
    period: {
      id: periodId,
      name: 'Winter Semester 2026/27',
      startsOn: '2026-10-26',
      endsOn: '2026-10-28',
      status: 'draft' as const,
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
      contextRequests += 1;
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
    http.post('*/api/v1/open-day-academic-breaks', async ({ request }) => {
      const body = await request.json() as CreateAcademicBreakRequest;
      const created = academicBreak({ ...body, id: createdBreakId });
      breaks = [...breaks, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch('*/api/v1/open-day-academic-breaks/:academicBreakId', async ({ request, params }) => {
      const body = await request.json() as UpdateAcademicBreakRequest;
      const updated = academicBreak({ ...body, id: String(params.academicBreakId), version: body.expectedVersion + 1 });
      breaks = breaks.map((item) => item.id === updated.id ? updated : item);
      return HttpResponse.json(updated);
    }),
    http.delete('*/api/v1/open-day-academic-breaks/:academicBreakId', ({ params }) => {
      breaks = breaks.filter((item) => item.id !== params.academicBreakId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('*/api/v1/open-day-periods/:periodId/schedule/recurrence-preview', () => HttpResponse.json({ occurrences: options.recurrence ?? [] })),
    http.put('*/api/v1/open-day-periods/:periodId/schedule', async ({ request }) => {
      savedBody = await request.json() as SaveOpenDayScheduleRequest;
      return HttpResponse.json(schedule);
    }),
  );
  const router = createMemoryRouter([
    { path: '/open-days/:periodId/schedule', element: <ScheduleEditorPage /> },
    { path: '/open-days/:periodId', element: <h1>Period detail</h1> },
    { path: '/open-days', element: <h1>Open Days overview</h1> },
  ], { initialEntries: [`/open-days/${periodId}/schedule`] });
  const result = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, getContextRequests: () => contextRequests, getSavedBody: () => savedBody };
}

describe('schedule editor calendar context', () => {
  it('shows Austrian holidays and break ranges without blocking manual Open Days', async () => {
    const { container } = renderEditor();

    expect(await screen.findByLabelText('Public holiday: Nationalfeiertag')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Academic break: Autumn break, 2026-10-27 to 2026-10-28')).toHaveLength(2);
    expect(screen.getByText('Academic break: Autumn break')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Schedule planning calendar')).getByText('Academic break')).toBeInTheDocument();

    const holidayAdd = screen.getByRole('button', { name: 'Add Open Day on 2026-10-26' });
    const breakAdd = screen.getByRole('button', { name: 'Add Open Day on 2026-10-27' });
    expect(holidayAdd).toBeEnabled();
    expect(breakAdd).toBeEnabled();
    fireEvent.click(holidayAdd);
    fireEvent.click(breakAdd);
    expect(container.querySelectorAll('.calendar-slot--editable')).toHaveLength(2);
  }, 15_000);

  it('uses the shared month grid and opens an existing Open Day for editing and explicit removal', async () => {
    renderEditor([], { items: [openDay()] });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(document.querySelector('.calendar-weekdays')?.textContent).toBe('SuMoTuWeThFrSa');
    fireEvent.click(screen.getByRole('button', { name: 'Drag or edit Open Day 16:00 to 19:00' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Open Day' })).toBeInTheDocument();
    expect(screen.getByLabelText('Internal note')).toHaveValue('Keep this setup');
    await user.click(screen.getByRole('button', { name: 'Remove slot' }));
    expect(screen.queryByRole('button', { name: 'Drag or edit Open Day 16:00 to 19:00' })).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  }, 10_000);

  it('applies changed defaults only to newly added Open Days and saves the atomic working copy', async () => {
    const { getSavedBody } = renderEditor([], { items: [openDay()] });
    const user = userEvent.setup();

    const supervisorCount = await screen.findByRole('spinbutton', { name: 'Supervisors' });
    fireEvent.change(supervisorCount, { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: 'Eligible role defaults' }));
    const roleDefaults = await screen.findByRole('dialog', { name: 'Eligible role defaults' });
    const supervisorRoles = within(roleDefaults).getByRole('combobox', { name: /^Eligible supervisor roles/ });
    await user.click(supervisorRoles);
    await user.click(within(roleDefaults).getByRole('option', { name: 'Trainee' }));
    expect(within(roleDefaults).getByRole('combobox', { name: /^Eligible trainee roles/ })).toBeInTheDocument();
    await user.click(within(roleDefaults).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Add Open Day on 2026-10-27' }));
    await user.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByRole('heading', { name: 'Period detail' })).toBeInTheDocument();
    const body = getSavedBody();
    expect(body?.updates).toEqual([]);
    expect(body?.creates).toHaveLength(1);
    expect(body?.creates[0].requirements.find((item) => item.kind === 'supervisor')).toEqual({ kind: 'supervisor', requiredCount: 4, eligibleRoleIds: [supervisorRoleId, traineeRoleId] });
  }, 10_000);

  it('blocks navigation while local changes are unsaved', async () => {
    renderEditor([]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add Open Day on 2026-10-26' }));
    await user.click(screen.getByRole('link', { name: 'Open Days' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved schedule changes?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('heading', { name: 'Edit Winter Semester 2026/27' })).toBeInTheDocument();
  }, 10_000);

  it('adds reviewed recurrence occurrences to the working calendar before save', async () => {
    renderEditor([], { recurrence: [{ date: '2026-10-28', startsAt: '2026-10-28T15:00:00Z', endsAt: '2026-10-28T18:00:00Z', disposition: 'create' }] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Recurrence preview' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create recurring Open Days' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(await within(dialog).findByRole('checkbox', { name: '2026-10-28 · create' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add selected' }));
    expect(screen.getByRole('button', { name: 'Drag or edit Open Day 16:00 to 19:00' })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  }, 10_000);

  it('creates an academic break from the schedule editor and refreshes context', async () => {
    const { getContextRequests } = renderEditor([]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Manage academic breaks' }));
    expect(screen.getByText('No academic breaks overlap this period.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add academic break' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Christmas break' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-27' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-28' } });
    await user.click(screen.getByRole('button', { name: 'Create break' }));

    const managerAfterCreate = await screen.findByRole('dialog', { name: 'Academic breaks' });
    expect(within(managerAfterCreate).getByText('Christmas break')).toBeInTheDocument();
    expect(await screen.findAllByLabelText('Academic break: Christmas break, 2026-10-27 to 2026-10-28')).toHaveLength(2);
    expect(getContextRequests()).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('edits an academic break from the schedule editor and refreshes context', async () => {
    const { getContextRequests } = renderEditor([academicBreak({ name: 'Christmas break' })]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Manage academic breaks' }));
    const manager = await screen.findByRole('dialog', { name: 'Academic breaks' });
    await user.click(within(manager).getByRole('button', { name: 'Edit Christmas break' }));
    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Winter break' } });
    await user.click(screen.getByRole('button', { name: 'Save break' }));

    const managerAfterEdit = await screen.findByRole('dialog', { name: 'Academic breaks' });
    expect(within(managerAfterEdit).getByText('Winter break')).toBeInTheDocument();
    expect(await screen.findAllByLabelText('Academic break: Winter break, 2026-10-27 to 2026-10-28')).toHaveLength(2);
    expect(getContextRequests()).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('deletes an academic break from the schedule editor and refreshes context', async () => {
    const { getContextRequests } = renderEditor([academicBreak({ name: 'Winter break' })]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Manage academic breaks' }));
    const manager = await screen.findByRole('dialog', { name: 'Academic breaks' });
    await user.click(within(manager).getByRole('button', { name: 'Delete Winter break' }));
    expect(screen.getByText('Winter break will no longer appear as calendar context. Existing Open Days are unchanged.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete break' }));

    const managerAfterDelete = await screen.findByRole('dialog', { name: 'Academic breaks' });
    expect(within(managerAfterDelete).getByText('No academic breaks overlap this period.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Academic break: Winter break, 2026-10-27 to 2026-10-28')).not.toBeInTheDocument());
    expect(getContextRequests()).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
