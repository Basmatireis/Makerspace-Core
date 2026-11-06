import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarFeedStatus } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import CalendarSubscriptionDialog from './CalendarSubscriptionDialog';

const inactive: CalendarFeedStatus = { active: false, createdAt: null, lastUsedAt: null };
const active: CalendarFeedStatus = { active: true, createdAt: '2026-11-01T10:00:00Z', lastUsedAt: null };
const token = 'a'.repeat(43);

describe('calendar subscription', () => {
  it('creates a link, shows it once and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let status: CalendarFeedStatus = inactive;
    server.use(
      http.get('*/api/v1/me/calendar-feed', () => HttpResponse.json(status)),
      http.post('*/api/v1/me/calendar-feed', () => {
        status = active;
        return HttpResponse.json(
          { url: `https://lab.example/api/v1/calendar/${token}.ics`, createdAt: active.createdAt },
          { status: 201 },
        );
      }),
    );
    renderRoute(<CalendarSubscriptionDialog onClose={() => undefined} />);

    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    const field = await screen.findByLabelText('Subscription link');
    expect(field).toHaveValue(`https://lab.example/api/v1/calendar/${token}.ics`);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://lab.example/api/v1/calendar/${token}.ics`));
    expect(await screen.findByText('Copied to the clipboard.')).toBeInTheDocument();
  });

  it('never shows the link of an existing subscription and revokes it after a confirmation', async () => {
    const user = userEvent.setup();
    let revoked = false;
    server.use(
      http.get('*/api/v1/me/calendar-feed', () => HttpResponse.json(revoked ? inactive : active)),
      http.delete('*/api/v1/me/calendar-feed', () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<CalendarSubscriptionDialog onClose={() => undefined} />);

    expect(await screen.findByText(/cannot be shown again/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Subscription link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke subscription' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(revoked).toBe(true);
  });

  it('warns before replacing the link', async () => {
    const user = userEvent.setup();
    server.use(http.get('*/api/v1/me/calendar-feed', () => HttpResponse.json(active)));
    renderRoute(<CalendarSubscriptionDialog onClose={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: 'Create a new link' }));
    expect(screen.getByText(/old link stops working at once/)).toBeInTheDocument();
  });
});
