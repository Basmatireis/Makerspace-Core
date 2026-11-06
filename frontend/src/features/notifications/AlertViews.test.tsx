import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotificationAlert } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { NotificationAlertHost } from './NotificationAlertHost';

const ids = ['0192f6f8-743e-7c77-a349-cd07c3e8b101', '0192f6f8-743e-7c77-a349-cd07c3e8b102'] as const;

function alert(overrides: Partial<NotificationAlert> = {}): NotificationAlert {
  return {
    id: ids[0],
    appearance: 'toast',
    level: 'info',
    title: 'Printer 7 reports 0300-0100',
    body: 'Please have a look.',
    link: null,
    button: { kind: 'none', label: null, link: null },
    toastSeconds: 5,
    onlyButtonCloses: false,
    allowLater: false,
    createdAt: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}

/** Serves the poll and records the calls the views make. */
function mockPoll(poll: { fresh?: NotificationAlert[]; pinned?: NotificationAlert[] }) {
  const calls: string[] = [];
  server.use(
    http.get('*/api/v1/notifications/unread-count', () =>
      HttpResponse.json({ unreadCount: 1, fresh: poll.fresh ?? [], pinned: poll.pinned ?? [] }),
    ),
    http.post('*/api/v1/notifications/:id/:action', ({ params }) => {
      calls.push(`${String(params.action)} ${String(params.id)}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('Notification pop-ups, banners and dialogs', () => {
  it.each(['info', 'success', 'warning', 'error'] as const)(
    'shows a %s toast and reports it as seen',
    async (level) => {
      const calls = mockPoll({ fresh: [alert({ level })] });
      const view = renderRoute(<NotificationAlertHost />);
      const toast = await screen.findByText('Printer 7 reports 0300-0100');
      expect(toast.closest('.cds--toast-notification')).toHaveClass(`cds--toast-notification--${level}`);
      await waitFor(() => expect(calls).toEqual([`seen ${ids[0]}`]));
      view.unmount();
    },
  );

  it('closing a toast marks it read; a toast with a link button follows the link', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const calls = mockPoll({
      fresh: [
        alert({
          button: { kind: 'link', label: 'Open machine', link: 'https://example.org/machine' },
          toastSeconds: 0,
        }),
      ],
    });
    renderRoute(<NotificationAlertHost />);
    await user.click(await screen.findByRole('button', { name: 'Open machine' }));
    expect(open).toHaveBeenCalledWith('https://example.org/machine', '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(calls).toContain(`read ${ids[0]}`));
    await waitFor(() => expect(screen.queryByText('Printer 7 reports 0300-0100')).not.toBeInTheDocument());
  });

  it('follows an application path inside the app', async () => {
    const user = userEvent.setup();
    mockPoll({ pinned: [alert({ appearance: 'banner', button: { kind: 'link', label: null, link: '/machines/7' } })] });
    const view = renderRoute(<NotificationAlertHost />);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/machines/7'));
  });

  it('shows a pinned banner with a close icon, which marks it read', async () => {
    const user = userEvent.setup();
    const calls = mockPoll({ pinned: [alert({ appearance: 'banner', level: 'warning', body: 'Check the nozzle.' })] });
    renderRoute(<NotificationAlertHost />);
    const banner = (await screen.findByText('Check the nozzle.')).closest('.cds--actionable-notification');
    expect(banner).toHaveClass('cds--actionable-notification--warning');
    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => expect(calls).toContain(`read ${ids[0]}`));
    expect(screen.queryByText('Check the nozzle.')).not.toBeInTheDocument();
  });

  it('has no close icon when only the button may close a banner, and acknowledging calls the endpoint', async () => {
    const user = userEvent.setup();
    const calls = mockPoll({
      pinned: [
        alert({
          appearance: 'banner',
          level: 'error',
          onlyButtonCloses: true,
          button: { kind: 'acknowledge', label: null, link: null },
        }),
      ],
    });
    renderRoute(<NotificationAlertHost />);
    const acknowledge = await screen.findByRole('button', { name: 'Acknowledge' });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    await user.click(acknowledge);
    await waitFor(() => expect(calls).toContain(`acknowledge ${ids[0]}`));
    expect(calls).not.toContain(`read ${ids[0]}`);
    await waitFor(() => expect(screen.queryByText('Printer 7 reports 0300-0100')).not.toBeInTheDocument());
  });

  it('postpones a banner with "Remind me later"', async () => {
    const user = userEvent.setup();
    const calls = mockPoll({ pinned: [alert({ appearance: 'banner', allowLater: true })] });
    renderRoute(<NotificationAlertHost />);
    await user.click(await screen.findByRole('button', { name: 'Remind me later' }));
    await waitFor(() => expect(calls).toContain(`later ${ids[0]}`));
    expect(screen.queryByText('Printer 7 reports 0300-0100')).not.toBeInTheDocument();
  });

  it('shows a dialog whose button is the primary action, danger-styled for errors', async () => {
    const user = userEvent.setup();
    const calls = mockPoll({
      pinned: [
        alert({
          appearance: 'dialog',
          level: 'error',
          allowLater: true,
          onlyButtonCloses: true,
          button: { kind: 'acknowledge', label: 'I will take care of it', link: null },
        }),
      ],
    });
    renderRoute(<NotificationAlertHost />);
    const primary = await screen.findByRole('button', { name: 'I will take care of it' });
    expect(primary).toHaveClass('cds--btn--danger');
    expect(screen.getByText('Error')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByText('Printer 7 reports 0300-0100')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remind me later' }));
    await waitFor(() => expect(calls).toContain(`later ${ids[0]}`));
    await waitFor(() => expect(screen.queryByText('Printer 7 reports 0300-0100')).not.toBeInTheDocument());
  });

  it('shows one dialog at a time, the oldest first', async () => {
    const user = userEvent.setup();
    mockPoll({
      pinned: [
        alert({
          id: ids[1],
          appearance: 'dialog',
          title: 'Second',
          createdAt: '2026-11-06T10:05:00Z',
          button: { kind: 'ok', label: null, link: null },
        }),
        alert({ appearance: 'dialog', title: 'First', button: { kind: 'ok', label: null, link: null } }),
      ],
    });
    renderRoute(<NotificationAlertHost />);
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it('renders nothing when the poll brings nothing', async () => {
    mockPoll({});
    const view = renderRoute(<NotificationAlertHost />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.container.querySelector('.app-toasts, .notification-banners')).toBeNull();
  });
});
