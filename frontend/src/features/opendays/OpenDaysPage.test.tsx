import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PermissionId, OpenDayPeriodStatus } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { openDay, period, requirement, slot } from './testData';

const day = (id: string, date: string, joinable = true) =>
  openDay(id, [
    slot(`${id}-slot`, date, '17:00', '21:00', [
      requirement(`${id}-sup`, 'supervisor', 2, { assignedCount: 1, eligible: true, canJoin: joinable }),
      requirement(`${id}-tr`, 'trainee', 1),
    ]),
  ]);

function mock(
  permissions: PermissionId[],
  periods = [
    period({ id: 'p-staffing' }),
    period({ id: 'p-draft', name: 'Summer draft', status: 'draft' as OpenDayPeriodStatus }),
  ],
) {
  const schedule = (id: string) => ({
    period: periods.find((item) => item.id === id) ?? periods[0],
    items: [day(`${id}-d1`, '2099-11-10'), day(`${id}-d2`, '2099-11-12', false)],
    timeZone: 'Europe/Vienna',
  });
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/open-day-periods', () => HttpResponse.json({ items: periods })),
    http.get('*/api/v1/open-day-periods/:id/open-days', ({ params }) => HttpResponse.json(schedule(String(params.id)))),
    http.get('*/api/v1/open-day-periods/:id/calendar-context', () =>
      HttpResponse.json({
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: null,
        languageCode: 'en',
        entries: [],
        academicBreaks: [],
      }),
    ),
    http.get('*/api/v1/open-day-periods/:id/series', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/open-day-eligibility-roles', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/me/dashboard', () =>
      HttpResponse.json({ person: { firstName: 'Ada', memberSince: '2026-01-01' } }),
    ),
    http.get('*/api/v1/supervisor-dashboard', () =>
      HttpResponse.json({ code: 'forbidden', message: 'no' }, { status: 403 }),
    ),
    http.get('*/api/v1/academic-breaks', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/open-day-academic-breaks', () => HttpResponse.json({ items: [] })),
  );
}

describe('Open Days routing', () => {
  it('sends people without open_days.manage to the schedule of the current visible period, never a draft', async () => {
    mock(['open_days.read', 'open_days.signup']);
    const { router } = renderRoute(<App />, '/open-days');
    await waitFor(() => expect(router.state.location.pathname).toBe('/open-days/p-staffing'));
    expect(await screen.findByRole('heading', { name: 'Open Days' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Open for me/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Short-staffed/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Summer draft')).not.toBeInTheDocument();
  });

  it('gives the Leitung the period list with Periods and Breaks tabs, drafts included', async () => {
    mock(['open_days.read', 'open_days.manage']);
    const { router } = renderRoute(<App />, '/open-days');
    expect(await screen.findByRole('tab', { name: 'Periods' })).toBeInTheDocument();
    expect(await screen.findByText('Summer draft')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/open-days');
    await userEvent.click(screen.getByRole('tab', { name: 'Breaks' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=breaks'));
  });

  it('opens the old day URL as the period schedule with that day selected', async () => {
    mock(['open_days.read', 'open_days.signup']);
    const { router } = renderRoute(<App />, '/open-days/p-staffing/days/p-staffing-d1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/open-days/p-staffing'));
    expect(router.state.location.search).toBe('?day=p-staffing-d1');
    const panel = await screen.findByRole('dialog', { name: 'Open day details' });
    expect(await within(panel).findByRole('heading', { name: /Supervisors/ })).toBeInTheDocument();
  });

  it('shows Join only where the API says the viewer can join', async () => {
    mock(['open_days.read', 'open_days.signup']);
    renderRoute(<App />, '/open-days/p-staffing');
    const rows = await screen.findAllByRole('listitem', { name: /17:00–21:00/ });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });
});
