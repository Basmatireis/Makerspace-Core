import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AcademicBreak, CreateAcademicBreakRequest, UpdateAcademicBreakRequest } from '../../api/generated/models';
import { testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { ScheduleEditorPage } from './ScheduleEditorPage';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const breakId = '0192f6f8-743e-7c77-a349-cd07c3e8a951';
const createdBreakId = '0192f6f8-743e-7c77-a349-cd07c3e8a952';

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

function renderEditor(initialBreaks: AcademicBreak[] = [academicBreak()]) {
  let breaks = initialBreaks;
  let contextRequests = 0;
  server.use(
    http.get('*/api/v1/open-day-periods/:periodId/open-days', () => HttpResponse.json({
      period: {
        id: periodId,
        name: 'Winter Semester 2026/27',
        startsOn: '2026-10-26',
        endsOn: '2026-10-28',
        status: 'draft',
        totalOpenDays: 0,
        fullyStaffedCount: 0,
        needsStaffCount: 0,
        openSupervisorPositions: 0,
        cancelledCount: 0,
        myAssignmentCount: 0,
        version: 1,
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-01T10:00:00Z',
      },
      items: [],
      timeZone: 'Europe/Vienna',
    })),
    http.get('*/api/v1/open-day-eligibility-roles', () => HttpResponse.json({ items: [] })),
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
  );
  const router = createMemoryRouter([
    { path: '/open-days/:periodId/schedule', element: <ScheduleEditorPage /> },
  ], { initialEntries: [`/open-days/${periodId}/schedule`] });
  const result = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, getContextRequests: () => contextRequests };
}

describe('schedule editor calendar context', () => {
  it('shows Austrian holidays and break ranges without blocking manual Open Days', async () => {
    const { container } = renderEditor();

    expect(await screen.findByLabelText('Public holiday: Nationalfeiertag')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Academic break: Autumn break, 2026-10-27 to 2026-10-28')).toHaveLength(2);
    expect(screen.getByText('Academic break: Autumn break')).toBeInTheDocument();
    expect(screen.getByText('Academic break')).toBeInTheDocument();

    const holidayAdd = screen.getByRole('button', { name: 'Add slot on 2026-10-26' });
    const breakAdd = screen.getByRole('button', { name: 'Add slot on 2026-10-27' });
    expect(holidayAdd).toBeEnabled();
    expect(breakAdd).toBeEnabled();
    fireEvent.click(holidayAdd);
    fireEvent.click(breakAdd);
    expect(container.querySelectorAll('.working-slot')).toHaveLength(2);
  }, 15_000);

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
