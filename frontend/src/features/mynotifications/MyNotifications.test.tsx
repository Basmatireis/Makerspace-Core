import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationRule, NotificationSettings } from '../../api/generated/models';
import { App } from '../../app/App';
import { catalogFixture, printerRule } from '../../test/notificationCenter';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { startersFor } from './starters';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const serviceId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const newsId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const surveysId = '0192f6f8-743e-7c77-a349-cd07c3e8c003';
const errorRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
const balanceRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';
const newsletterRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d003';

const consent = (categoryId: string, name: string, basis: string, granted: boolean | null, current = true) => ({
  categoryId,
  key: null,
  name,
  description: `${name} text.`,
  basis,
  textVersion: 1,
  granted,
  answeredAt: granted === null ? null : '2026-10-01T10:00:00Z',
  current,
});

function settingsFixture(): NotificationSettings {
  return {
    consents: [
      consent(serviceId, 'Service & safety', 'required', null),
      consent(newsId, 'News & events', 'consent', false),
      consent(surveysId, 'Surveys & feedback', 'consent', true),
    ],
    consentPending: false,
    askFeedbackAtCheckout: true,
    rules: [
      {
        ruleId: errorRuleId,
        name: 'Printer error',
        description: '',
        categoryId: serviceId,
        categoryName: 'Service & safety',
        mandatory: true,
        why: ['You hold the role Supervisor'],
        defaultChannels: ['in_app', 'email'],
        effectiveChannels: ['in_app'],
        blockedByConsent: false,
      },
      {
        ruleId: balanceRuleId,
        name: 'Open balance reminder',
        description: '',
        categoryId: surveysId,
        categoryName: 'Surveys & feedback',
        mandatory: false,
        why: ['You are a member'],
        defaultChannels: ['email'],
        effectiveChannels: ['email'],
        blockedByConsent: false,
      },
      {
        ruleId: newsletterRuleId,
        name: 'Monthly newsletter',
        description: '',
        categoryId: newsId,
        categoryName: 'News & events',
        mandatory: false,
        why: ['You are a member'],
        defaultChannels: ['email'],
        effectiveChannels: [],
        blockedByConsent: true,
      },
    ],
  };
}

const mineSubscription: NotificationRule = {
  ...printerRule,
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d010',
  name: 'My machine alert',
  categoryId: null,
  mandatory: false,
  systemKey: null,
  definition: {
    ...printerRule.definition,
    actions: [{ ...printerRule.definition.actions[0], recipients: ['me'] }],
    escalation: null,
  },
};

function signedIn(options: { consentRequired?: boolean } = {}) {
  const me = { ...currentUserFixture(), notificationConsentRequired: options.consentRequired ?? false };
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(me)),
    http.get('*/api/v1/notification-rules/catalog', () => HttpResponse.json(catalogFixture)),
    http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(settingsFixture())),
    http.get('*/api/v1/me/notification-subscriptions', () => HttpResponse.json({ items: [mineSubscription] })),
  );
  return me;
}

// The header actions get their accessible name from a tooltip, so the button is found by its tour target.
const profileMenuButton = () =>
  waitFor(() => {
    const button = document.querySelector<HTMLElement>('[data-guide="header-profile"]');
    if (!button) throw new Error('profile menu button not rendered yet');
    return button;
  });

describe('My notifications page', () => {
  it('lists the categories, the rules that reach the person and their subscriptions', async () => {
    signedIn();
    renderRoute(<App />, '/profile/notifications');
    expect(await screen.findByRole('heading', { name: 'My notifications' })).toBeInTheDocument();
    expect(await screen.findByText('Always on')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Allow Surveys & feedback' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Allow News & events' })).not.toBeChecked();
    expect(screen.getByText('Printer error')).toBeInTheDocument();
    expect(screen.getByText("You don't get this: News & events is not allowed above.")).toBeInTheDocument();
    expect(screen.getByText('My machine alert')).toBeInTheDocument();
    // The catalog offers none of the events the ready-made subscriptions need.
    expect(screen.queryByText('When a machine is free')).not.toBeInTheDocument();
  });

  it('saves a channel change with both channel values', async () => {
    signedIn();
    let body: unknown;
    const settings = settingsFixture();
    server.use(
      http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(settings)),
      http.put('*/api/v1/me/notifications/rules/:ruleId/preference', async ({ request, params }) => {
        body = { ruleId: params.ruleId, ...((await request.json()) as object) };
        settings.rules[1].effectiveChannels = ['in_app', 'email'];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile/notifications');
    await user.click(await screen.findByRole('switch', { name: 'Open balance reminder: in the app' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ ruleId: balanceRuleId, inApp: true, email: true });
    expect(await screen.findByText('Added')).toBeInTheDocument();
  });

  it('shows a rule as muted when both channels are off', async () => {
    signedIn();
    const settings = settingsFixture();
    server.use(
      http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(settings)),
      http.put('*/api/v1/me/notifications/rules/:ruleId/preference', () => {
        settings.rules[1].effectiveChannels = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile/notifications');
    await user.click(await screen.findByRole('switch', { name: 'Open balance reminder: by e-mail' }));
    expect(await screen.findByText('Muted for you')).toBeInTheDocument();
  });

  it('keeps the last channel of a required rule switched on', async () => {
    signedIn();
    renderRoute(<App />, '/profile/notifications');
    expect(await screen.findByRole('switch', { name: 'Printer error: in the app' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Printer error: by e-mail' })).toBeEnabled();
    expect(screen.getByText('Required: keep at least one')).toBeInTheDocument();
  });

  it('withdraws a consent for the profile', async () => {
    signedIn();
    let body: unknown;
    server.use(
      http.put('*/api/v1/me/notifications/consents', async ({ request }) => {
        body = await request.json();
        const settings = settingsFixture();
        settings.consents[2].granted = false;
        return HttpResponse.json(settings);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile/notifications');
    await user.click(await screen.findByRole('switch', { name: 'Allow Surveys & feedback' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ answers: [{ categoryId: surveysId, granted: false }], place: 'profile' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow Surveys & feedback' })).not.toBeChecked());
  });

  it('saves the check-out feedback switch on its own', async () => {
    signedIn();
    let body: unknown;
    server.use(
      http.put('*/api/v1/me/notifications/feedback-at-checkout', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile/notifications');
    await user.click(await screen.findByRole('switch', { name: 'Ask me at check-out' }));
    await waitFor(() => expect(body).toEqual({ ask: false }));
  });

  it('is reached from the profile menu', async () => {
    signedIn();
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    await user.click(await profileMenuButton());
    await user.click(screen.getByRole('button', { name: 'My notifications' }));
    expect(await screen.findByRole('heading', { name: 'My notifications' })).toBeInTheDocument();
  });
});

describe('personal subscriptions', () => {
  it('creates a subscription that notifies only the person', async () => {
    signedIn();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/me/notification-subscriptions', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mineSubscription, id: '0192f6f8-743e-7c77-a349-cd07c3e8d099', version: 1 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/profile/notifications/subscriptions/new');
    await user.type(await screen.findByLabelText('Name'), 'Alert me');
    // A subscription has no category, no recipients to choose and no escalation.
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /To/ })).not.toBeInTheDocument();
    expect(screen.queryByText('If nobody reacts')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Signage/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Printer failed');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      name: 'Alert me',
      categoryId: null,
      enabled: true,
      definition: {
        trigger: { type: 'event', event: 'printer_error' },
        actions: [{ channel: 'in_app', recipients: ['me'], title: 'Printer failed' }],
      },
    });
    expect(await screen.findByRole('heading', { name: 'My notifications' })).toBeInTheDocument();
  });

  it('offers only the ready-made subscriptions the catalog supports', () => {
    expect(startersFor(catalogFixture)).toEqual([]);
    const catalog = {
      ...catalogFixture,
      triggers: [
        ...catalogFixture.triggers,
        {
          ...catalogFixture.triggers[0],
          key: 'run_finished',
          fields: [
            {
              key: 'machine',
              label: 'Machine',
              type: 'enum',
              options: [{ value: 'machine-1', label: 'Laser' }],
              unit: null,
            },
          ],
        },
      ],
    };
    const starters = startersFor(catalog);
    expect(starters.map((starter) => starter.key)).toEqual(['machine-free']);
    expect(starters[0].draft.definition.actions[0].recipients).toEqual(['me']);
    expect(starters[0].draft.definition.conditions.items).toEqual([
      { field: 'e.machine', op: 'is', value: 'machine-1', ref: null },
    ]);
  });
});

describe('the consent question after sign-in', () => {
  const pending = () => {
    const settings = settingsFixture();
    settings.consentPending = true;
    settings.consents[1] = consent(newsId, 'News & events', 'consent', null, false);
    settings.consents[2] = consent(surveysId, 'Surveys & feedback', 'consent', null, false);
    return settings;
  };

  it('replaces the application and saves every answer off', async () => {
    let required = true;
    let body: unknown;
    const me = () => ({ ...currentUserFixture(), notificationConsentRequired: required });
    signedIn({ consentRequired: true });
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(me())),
      http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(pending())),
      http.put('*/api/v1/me/notifications/consents', async ({ request }) => {
        body = await request.json();
        required = false;
        return HttpResponse.json(settingsFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const heading = await screen.findByRole('heading', { name: 'Which messages may we send you?' });
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    // Nothing is preselected, and the person can still sign out.
    const news = await screen.findByRole('switch', { name: 'News & events' });
    expect(news).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Surveys & feedback' })).not.toBeChecked();
    expect(screen.getByText('Service & safety')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument();
    await user.click(await profileMenuButton());
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      answers: [
        { categoryId: newsId, granted: false },
        { categoryId: surveysId, granted: false },
      ],
      place: 'app',
    });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Which messages may we send you?' })).not.toBeInTheDocument();
  });

  it('sends the answers the person gave', async () => {
    let body: unknown;
    signedIn({ consentRequired: true });
    server.use(
      http.get('*/api/v1/me/notifications/settings', () => HttpResponse.json(pending())),
      http.put('*/api/v1/me/notifications/consents', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(settingsFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    await user.click(await screen.findByRole('switch', { name: 'News & events' }));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      answers: [
        { categoryId: newsId, granted: true },
        { categoryId: surveysId, granted: false },
      ],
    });
  });

  it('is not shown when nothing is pending', async () => {
    signedIn();
    renderRoute(<App />, '/dashboard');
    const dashboard = await screen.findByRole('heading', { name: 'Dashboard' });
    expect(within(dashboard.closest('main')!).queryByText('Which messages may we send you?')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Which messages may we send you?' })).not.toBeInTheDocument();
  });
});
