import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { eventFixture, eventId } from './testData';

function page(items: ReturnType<typeof eventFixture>[]) {
  return { items, page: 1, pageSize: 25, total: items.length };
}

function listRequests() {
  const urls: URL[] = [];
  server.use(
    http.get('*/api/v1/events', ({ request }) => {
      urls.push(new URL(request.url));
      return HttpResponse.json(page([eventFixture()]));
    }),
  );
  return urls;
}

describe('Event list', () => {
  it('shows organizers the planning columns and opens events in edit mode', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage])),
      ),
    );
    const urls = listRequests();
    renderRoute(<App />, '/events');
    const link = await screen.findByRole('link', { name: 'Autumn exhibition' });
    expect(link).toHaveAttribute('href', `/events/${eventId}?mode=edit`);
    const table = screen.getByRole('table', { name: 'Events' });
    for (const heading of [
      'Date',
      'Name',
      'Status',
      'Public page',
      'Helper signup',
      'Places filled',
      'Tasks',
      'Owner',
    ]) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(within(table).getByText('Live')).toBeInTheDocument();
    expect(within(table).getByText('Open')).toBeInTheDocument();
    expect(within(table).getByText('2/5')).toBeInTheDocument();
    expect(within(table).getByText('2/4 · 1 overdue')).toHaveClass('ev-overdue');
    expect(within(table).getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Drafts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create event' })).toBeInTheDocument();
    expect(urls[0].searchParams.get('scope')).toBe('upcoming');
  });

  it('asks the server for drafts, searches and pages', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage])),
      ),
    );
    const urls = listRequests();
    const user = userEvent.setup();
    renderRoute(<App />, '/events');
    await screen.findByRole('link', { name: 'Autumn exhibition' });
    await user.click(screen.getByRole('tab', { name: 'Drafts' }));
    await waitFor(() => expect(urls.some((url) => url.searchParams.get('scope') === 'drafts')).toBe(true));
    const search = await screen.findByLabelText('Search events', { selector: 'input' });
    await user.type(search, 'Autumn');
    await waitFor(() => expect(urls.some((url) => url.searchParams.get('search') === 'Autumn')).toBe(true));
    expect(urls.at(-1)?.searchParams.get('page')).toBe('1');
  });

  it('shows helpers only confirmed events with open places and their own shifts', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventssignup])),
      ),
      http.get('*/api/v1/events', () =>
        HttpResponse.json(
          page([
            eventFixture({
              myShifts: [
                {
                  assignmentId: 'a1',
                  shiftId: 's1',
                  requirementId: 'r1',
                  shiftName: 'Repair desk',
                  requirementName: 'Electronics',
                  startsAt: '2026-11-02T16:00:00Z',
                  endsAt: '2026-11-02T20:00:00Z',
                  shiftStatus: 'open',
                  version: 1,
                  canLeave: true,
                },
              ],
            }),
          ]),
        ),
      ),
    );
    renderRoute(<App />, '/events');
    const link = await screen.findByRole('link', { name: 'Autumn exhibition' });
    expect(link).toHaveAttribute('href', `/events/${eventId}`);
    const table = screen.getByRole('table', { name: 'Events' });
    expect(within(table).getByRole('columnheader', { name: 'Open places' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Your shifts' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Owner' })).not.toBeInTheDocument();
    expect(within(table).getByText('3 of 5')).toBeInTheDocument();
    expect(within(table).getByText('Repair desk · Electronics')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Drafts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create event' })).not.toBeInTheDocument();
  });

  it('creates an event with its first session and lands in edit mode', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage])),
      ),
      http.get('*/api/v1/events', () => HttpResponse.json(page([]))),
    );
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/events', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(eventFixture({ status: 'draft' }), { status: 201 });
      }),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(eventFixture({ status: 'draft' }))),
      http.get(`*/api/v1/events/${eventId}/**`, () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/events');
    await user.click(await screen.findByRole('button', { name: 'Create event' }));
    expect(await screen.findByRole('heading', { name: 'Create event' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Internal name'), 'Repair Café');
    await user.type(screen.getByLabelText('Location'), 'Main workshop');
    await user.click(screen.getAllByRole('button', { name: 'Create event' }).at(-1)!);
    await waitFor(() => expect(router.state.location.search).toBe('?mode=edit'));
    expect(body).toMatchObject({
      name: 'Repair Café',
      location: 'Main workshop',
      firstSession: { isPublic: true },
    });
    expect((body?.firstSession as { startsAt: string }).startsAt).toMatch(/Z$/);
  });
});
