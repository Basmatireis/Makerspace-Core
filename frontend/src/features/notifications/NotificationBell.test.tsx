import { useRef, useState } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Notification } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { NotificationAction, NotificationPanel } from './NotificationBell';

const first = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const second = '0192f6f8-743e-7c77-a349-cd07c3e8b002';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: first,
    kind: 'run_finished',
    title: 'Run R-2026-000012 finished',
    body: 'Run R-2026-000012 on Printer 1 finished.',
    link: '/machine-logbook/jobs/runs/run-1',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    readAt: null,
    ...overrides,
  };
}

function mockInbox(items: Notification[], unread = items.filter((item) => !item.readAt).length) {
  const calls: string[] = [];
  server.use(
    http.get('*/api/v1/notifications/unread-count', () => HttpResponse.json({ unreadCount: unread })),
    http.get('*/api/v1/notifications', () =>
      HttpResponse.json({ items, page: 1, pageSize: 20, total: items.length, unreadCount: unread }),
    ),
    http.post('*/api/v1/notifications/read-all', () => {
      calls.push('read-all');
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('*/api/v1/notifications/:id/read', ({ params }) => {
      calls.push(`read ${String(params.id)}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete('*/api/v1/notifications/:id', ({ params }) => {
      calls.push(`dismiss ${String(params.id)}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <NotificationAction expanded={open} actionRef={ref} onToggle={() => setOpen((value) => !value)} />
      <NotificationPanel expanded={open} actionRef={ref} onClose={() => setOpen(false)} />
    </>
  );
}

describe('Notification bell', () => {
  it('shows the unread count on the bell and no badge at zero', async () => {
    mockInbox([notification()], 3);
    const view = renderRoute(<Harness />);
    expect(await screen.findByRole('button', { name: 'Open notifications, 3 unread' })).toBeInTheDocument();
    expect(view.container.querySelector('.cds--badge-indicator')).toHaveTextContent('3');
    view.unmount();

    mockInbox([], 0);
    const empty = renderRoute(<Harness />);
    expect(await screen.findByRole('button', { name: 'Open notifications' })).toBeInTheDocument();
    expect(empty.container.querySelector('.cds--badge-indicator')).toBeNull();
  });

  it('polls the unread count every minute', async () => {
    mockInbox([], 0);
    const view = renderRoute(<Harness />);
    await screen.findByRole('button', { name: 'Open notifications' });
    const options = view.queryClient.getQueryCache().find({ queryKey: ['notifications', 'unread'] })?.observers[0]
      ?.options as { refetchInterval?: number } | undefined;
    expect(options?.refetchInterval).toBe(60_000);
  });

  it('lists notifications, follows a link and marks the notification read', async () => {
    const user = userEvent.setup();
    const calls = mockInbox([
      notification(),
      notification({
        id: second,
        title: 'Supervisor place freed',
        body: 'A place is free.',
        link: null,
        readAt: '2026-10-22T10:00:00Z',
      }),
    ]);
    const view = renderRoute(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Open notifications/ }));
    expect(await screen.findByText('Run R-2026-000012 finished')).toBeInTheDocument();
    expect(screen.getAllByText('5 minutes ago')).toHaveLength(2);
    expect(screen.getAllByText('New')).toHaveLength(1);

    await user.click(screen.getByText('Run R-2026-000012 finished'));
    await waitFor(() => expect(calls).toContain(`read ${first}`));
    expect(view.router.state.location.pathname).toBe('/machine-logbook/jobs/runs/run-1');
    await waitFor(() => expect(screen.getByRole('button', { name: /Open notifications/ })).toBeInTheDocument());
  });

  it('dismisses a notification and marks all as read', async () => {
    const user = userEvent.setup();
    const calls = mockInbox([notification()]);
    renderRoute(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Open notifications/ }));
    await user.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(calls).toContain('read-all'));
    await user.click(await screen.findByRole('button', { name: /Dismiss notification: Run R-2026-000012 finished/ }));
    await waitFor(() => expect(calls).toContain(`dismiss ${first}`));
  });

  it('says so when there are no notifications and disables mark all as read', async () => {
    const user = userEvent.setup();
    mockInbox([]);
    renderRoute(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Open notifications/ }));
    expect(await screen.findByText('You have no notifications.')).toBeInTheDocument();
    expect(within(document.body).getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });
});
