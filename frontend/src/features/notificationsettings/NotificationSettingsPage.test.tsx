import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationSettings } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, restrictedUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const serviceId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const newsId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const ruleId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';

const settings: NotificationSettings = {
  consents: [
    {
      categoryId: serviceId,
      key: null,
      name: 'Service & safety',
      description: 'Service text.',
      basis: 'required',
      textVersion: 1,
      granted: null,
      answeredAt: null,
      current: true,
    },
    {
      categoryId: newsId,
      key: null,
      name: 'News & events',
      description: 'News text.',
      basis: 'consent',
      textVersion: 1,
      granted: true,
      answeredAt: '2026-10-01T10:00:00Z',
      current: true,
    },
  ],
  consentPending: false,
  askFeedbackAtCheckout: true,
  rules: [
    {
      ruleId,
      name: 'Monthly newsletter',
      description: '',
      categoryId: newsId,
      categoryName: 'News & events',
      mandatory: false,
      why: ['You are a visitor'],
      triggerSummary: 'Once a month',
      defaultChannels: ['email'],
      effectiveChannels: ['email'],
      blockedByConsent: false,
    },
  ],
};

function signedIn(me: object) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(me)),
    http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(settings)),
  );
}

describe('notification settings page', () => {
  it('shows a restricted session the settings without the application shell or the app link', async () => {
    signedIn(restrictedUserFixture());
    renderRoute(<App />, '/notification-settings');

    expect(await screen.findByRole('heading', { name: 'Your notification settings', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Allow News & events' })).toBeChecked();
    expect(screen.getByText('Monthly newsletter')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Ask me at check-out' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in the app' })).not.toBeInTheDocument();
    // No subscriptions, no navigation of the application.
    expect(document.querySelector('.cds--side-nav, .cds--header')).toBeNull();
    expect(screen.queryByText(/Your own subscriptions/)).not.toBeInTheDocument();
  });

  it('saves a change with the endpoints a restricted session may call', async () => {
    signedIn(restrictedUserFixture());
    let body: unknown;
    server.use(
      http.put('*/api/v1/me/notifications/rules/:ruleId/preference', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/notification-settings');
    await user.click(await screen.findByRole('switch', { name: 'Monthly newsletter: in the app' }));
    await waitFor(() => expect(body).toEqual({ inApp: true, email: true }));
  });

  it('links a full session to the subscriptions in the app', async () => {
    signedIn(currentUserFixture());
    renderRoute(<App />, '/notification-settings');
    const link = await screen.findByRole('link', { name: 'Open in the app' });
    expect(link).toHaveAttribute('href', '/profile/notifications');
    expect(await screen.findByRole('switch', { name: 'Allow News & events' })).toBeInTheDocument();
  });

  it('sends a restricted session away from every application page', async () => {
    signedIn(restrictedUserFixture());
    const { router } = renderRoute(<App />, '/dashboard');
    await waitFor(() => expect(router.state.location.pathname).toBe('/notification-settings'));
    expect(await screen.findByRole('heading', { name: 'Your notification settings' })).toBeInTheDocument();
  });

  it('asks an anonymous visitor to sign in with a code and returns afterwards', async () => {
    let signedInNow = false;
    const login = vi.fn();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        signedInNow
          ? HttpResponse.json(restrictedUserFixture())
          : HttpResponse.json({ code: 'unauthenticated', message: 'x' }, { status: 401 }),
      ),
      http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(settings)),
      http.post('*/api/v1/auth/email-code', () => new HttpResponse(null, { status: 202 })),
      http.post('*/api/v1/auth/email-code/login', async ({ request }) => {
        login(await request.json());
        signedInNow = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/notification-settings');

    expect(await screen.findByText('Sign in to manage your notification settings.')).toBeInTheDocument();
    // The code form is preselected for this target.
    await user.type(screen.getByLabelText('Email'), 'visitor@example.test');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in with code' }));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'visitor@example.test',
        code: '123456',
        purpose: 'notification_settings',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Your notification settings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/notification-settings');
  });

  it('keeps the plain sign-in free of the purpose and still explains a refused web sign-in', async () => {
    const login = vi.fn();
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json({ code: 'unauthenticated', message: 'x' }, { status: 401 })),
      http.post('*/api/v1/auth/email-code', () => new HttpResponse(null, { status: 202 })),
      http.post('*/api/v1/auth/email-code/login', async ({ request }) => {
        login(await request.json());
        return HttpResponse.json({ code: 'web_sign_in_not_permitted', message: 'no' }, { status: 403 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/login');
    await user.click(await screen.findByRole('button', { name: 'Email code' }));
    await user.type(screen.getByLabelText('Email'), 'visitor@example.test');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in with code' }));

    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: 'visitor@example.test', code: '123456' }));
    expect(await screen.findByText(/may not sign in to the web application/)).toBeInTheDocument();
  });
});
