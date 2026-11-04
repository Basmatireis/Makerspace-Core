import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../api/generated/models';
import { server } from '../../test/server';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import GuideOffer from './GuideOffer';
import { GuideProvider } from './GuideProvider';

const hoisted = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../auth/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/auth')>()),
  useCurrentUser: () => hoisted.user,
}));
vi.mock('./content', () => ({ guides: [] }));

function progress(items: { guideId: string; status: 'completed' | 'dismissed' }[]) {
  server.use(
    http.get('*/api/v1/me/guides', () =>
      HttpResponse.json({ items: items.map((item) => ({ ...item, updatedAt: '2026-01-01T00:00:00Z' })) }),
    ),
  );
}

function renderOffer(user: CurrentUser = currentUserFixture()) {
  hoisted.user = user;
  return renderRoute(
    <GuideProvider>
      <GuideOffer />
    </GuideProvider>,
  );
}

describe('welcome tour offer', () => {
  it('is shown to someone who has not seen the tour, and "Not now" dismisses it for good', async () => {
    progress([]);
    let body: unknown = null;
    server.use(
      http.put('*/api/v1/me/guides/welcome', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ guideId: 'welcome', status: 'dismissed', updatedAt: '2026-01-01T00:00:00Z' });
      }),
    );
    const user = userEvent.setup();
    renderOffer();

    expect(await screen.findByText('New here?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(body).toEqual({ status: 'dismissed' }));
    expect(screen.queryByText('New here?')).not.toBeInTheDocument();
  });

  it('stays away once the tour was completed or dismissed', async () => {
    progress([{ guideId: 'welcome', status: 'dismissed' }]);
    renderOffer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText('New here?')).not.toBeInTheDocument();
  });

  it('is not offered on managed devices or visitor-terminal sessions, which never ask the server', async () => {
    const requested = vi.fn();
    server.use(
      http.get('*/api/v1/me/guides', () => {
        requested();
        return HttpResponse.json({ items: [] });
      }),
    );
    const device = currentUserFixture();
    device.managedDevice = { id: 'd', name: 'Tablet' } as unknown as CurrentUser['managedDevice'];
    const { unmount } = renderOffer(device);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText('New here?')).not.toBeInTheDocument();
    unmount();

    const kiosk = currentUserFixture();
    kiosk.session = { ...kiosk.session, postSessionDestination: 'visitor_terminal' };
    renderOffer(kiosk);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText('New here?')).not.toBeInTheDocument();
    expect(requested).not.toHaveBeenCalled();
  });
});
