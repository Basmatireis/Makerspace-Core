import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationRule } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import {
  balanceRule,
  balanceRuleId,
  catalogFixture,
  categoriesFixture,
  printerRule,
  printerRuleId,
} from '../../test/notificationCenter';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const read = PermissionId.notification_rulesread;
const manage = PermissionId.notification_rulesmanage;

function asStaff(rules: NotificationRule[] = [printerRule, balanceRule], ...permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/notification-rules/catalog', () => HttpResponse.json(catalogFixture)),
    http.get('*/api/v1/notification-rules', () => HttpResponse.json({ items: rules })),
    http.get('*/api/v1/notification-rules/:ruleId', ({ params }) =>
      HttpResponse.json(rules.find((rule) => rule.id === params.ruleId)),
    ),
    http.get('*/api/v1/notification-categories', () => HttpResponse.json({ items: categoriesFixture })),
  );
}

const firing = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8e001',
  ruleId: printerRuleId,
  ruleName: 'Printer error',
  trigger: 'event',
  summary: 'Bambu Lab H2D reported an error',
  channels: ['in_app', 'email'],
  reached: 2,
  result: 'escalated',
  resolvedReason: null,
  createdAt: '2026-03-01T10:00:00Z',
  recipients: [
    {
      name: 'Mia Gruber',
      channel: 'in_app',
      step: 0,
      status: 'sent',
      sentAt: '2026-03-01T10:00:01Z',
      readAt: '2026-03-01T10:02:00Z',
      deliveredAt: '2026-03-01T10:00:05Z',
      seenAt: '2026-03-01T10:01:00Z',
      acknowledgedAt: '2026-03-01T10:02:00Z',
    },
    {
      name: 'Jonas Huber',
      channel: 'email',
      step: 1,
      status: 'skipped_muted',
      sentAt: '2026-03-01T10:20:00Z',
      readAt: null,
      deliveredAt: null,
      seenAt: null,
      acknowledgedAt: null,
    },
  ],
};

const dryRun = {
  estimate30: 12,
  estimateNote: 'Counts only the people who allowed News & events.',
  items: [
    { name: 'Mia Gruber', values: { unpaid: '12,00 €' }, matched: true },
    { name: 'Jonas Huber', values: { unpaid: '0,00 €' }, matched: false },
  ],
  totalItems: 40,
  matchedItems: 7,
  summary: null,
  recipients: [
    { name: 'Mia Gruber', passed: true },
    { name: 'Jonas Huber', passed: false },
  ],
  previews: [
    {
      channel: 'email',
      recipients: ['Mia Gruber', 'Jonas Huber'],
      recipientCount: 5,
      title: 'Your open balance',
      body: 'You owe 12,00 €.',
    },
  ],
};

describe('activity tab', () => {
  it('lists the firings and opens the people a firing reached', async () => {
    asStaff(undefined, read, manage);
    let query = '';
    server.use(
      http.get('*/api/v1/notification-rules/activity', ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ items: [firing], total: 1, page: 1, pageSize: 10 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications?tab=activity');

    const rule = await screen.findByRole('link', { name: 'Printer error' });
    expect(rule).toHaveAttribute('href', `/settings/notifications/rules/${printerRuleId}`);
    expect(screen.getByText('Bambu Lab H2D reported an error')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(query).toContain('page=1');
    expect(screen.queryByText('Jonas Huber')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show who Printer error reached/ }));
    const recipients = await screen.findByRole('table', { name: 'Recipients' });
    expect(within(recipients).getByText('Mia Gruber')).toBeInTheDocument();
    expect(within(within(recipients).getByRole('row', { name: /Mia Gruber/ })).getByText('Sent')).toBeInTheDocument();
    expect(within(recipients).getByText('Skipped: muted')).toBeInTheDocument();
    for (const header of ['Recipient', 'Channel', 'Outcome', 'Sent', 'Delivered', 'Seen', 'Then']) {
      expect(within(recipients).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(
      within(within(recipients).getByRole('row', { name: /Mia Gruber/ })).getByText(/^Acknowledged /),
    ).toBeInTheDocument();
    expect(screen.getByText('Escalation step 1: 0 of 1 recipient reached')).toBeInTheDocument();
  });

  it('filters by rule', async () => {
    asStaff(undefined, read, manage);
    const queries: string[] = [];
    server.use(
      http.get('*/api/v1/notification-rules/activity', ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 10 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications?tab=activity&activity-rule=${balanceRuleId}`);
    expect(await screen.findByText('Nothing from this rule')).toBeInTheDocument();
    expect(queries.some((search) => search.includes(`ruleId=${balanceRuleId}`))).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Rule' })).toHaveValue('Open balance reminder');
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(await screen.findByText('Printer error')).toBeInTheDocument();
  });
});

describe('dry run in the editor', () => {
  it('shows the server answer and asks again after the draft rests', async () => {
    asStaff(undefined, read, manage);
    const bodies: { personal: boolean; rule: { name: string } }[] = [];
    server.use(
      http.post('*/api/v1/notification-rules/dry-run', async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.json(dryRun);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${balanceRuleId}`);

    expect(await screen.findByText('Dry run')).toBeInTheDocument();
    expect(screen.getByTestId('dry-run-head')).toHaveTextContent('7 of 40 people get through');
    expect(screen.getByTestId('dry-run-head')).toHaveTextContent('7 separate messages per action');
    const items = screen.getByRole('table', { name: 'Example people' });
    expect(within(items).getByText('12,00 €')).toBeInTheDocument();
    expect(within(items).getByLabelText('Does not get through')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Recipient conditions' })).toBeInTheDocument();
    expect(screen.getByTestId('estimate')).toHaveTextContent('12');
    expect(screen.getByText('Counts only the people who allowed News & events.')).toBeInTheDocument();
    expect(screen.getByText('→ Mia Gruber, Jonas Huber +3')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].personal).toBe(false);

    await user.type(screen.getByLabelText('Name'), ' now');
    expect(bodies).toHaveLength(1);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].rule.name).toBe('Open balance reminder now');
  });

  it('keeps editing possible when the server cannot evaluate the draft', async () => {
    asStaff(undefined, read, manage);
    server.use(
      http.post('*/api/v1/notification-rules/dry-run', () =>
        HttpResponse.json(
          { code: 'validation_failed', message: 'invalid', details: { reason: 'give the rule a name' } },
          { status: 422 },
        ),
      ),
    );
    renderRoute(<App />, '/settings/notifications/rules/new?type=event');
    expect(await screen.findByTestId('dry-run-problem')).toHaveTextContent('give the rule a name');
    expect(screen.getByLabelText('Name')).toBeEnabled();
  });
});

describe('run now and tests', () => {
  it('runs a scheduled rule after confirming and reports what was sent', async () => {
    asStaff(undefined, read, manage);
    let ran = 0;
    server.use(
      http.post('*/api/v1/notification-rules/dry-run', () => HttpResponse.json(dryRun)),
      http.post(`*/api/v1/notification-rules/${balanceRuleId}/run`, () => {
        ran += 1;
        return HttpResponse.json({ sent: { inApp: 0, email: 7 }, itemsExamined: 40, matched: 7 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${balanceRuleId}`);
    await screen.findByText('Dry run');
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Run “Open balance reminder” now?');
    expect(dialog).toHaveTextContent(
      'It looks at all 40 people and sends a message to each one that matches (7 right now).',
    );
    expect(ran).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Sent 7 messages')).toBeInTheDocument();
    expect(screen.getByText(/Looked at 40, 7 matched/)).toBeInTheDocument();
    expect(ran).toBe(1);
  });

  it('offers no run for event rules and sends a test to the person', async () => {
    asStaff(undefined, read, manage);
    let tested = 0;
    server.use(
      http.post(`*/api/v1/notification-rules/${printerRuleId}/test`, () => {
        tested += 1;
        return HttpResponse.json({ sent: { inApp: 1, email: 1 }, itemsExamined: 1, matched: 1 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);
    const button = await screen.findByRole('button', { name: 'Send a test to me' });
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByText('Test sent to you')).toBeInTheDocument();
    expect(tested).toBe(1);
  });

  it('disables both while the draft has unsaved changes', async () => {
    asStaff(undefined, read, manage);
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${balanceRuleId}`);
    const run = await screen.findByRole('button', { name: 'Run now' });
    expect(run).toBeEnabled();
    await user.type(screen.getByLabelText('Name'), '!');
    expect(run).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a test to me' })).toBeDisabled();
    expect(run.closest('span')).toHaveAttribute('title', expect.stringContaining('Save your changes first'));
  });

  it('hides both without the manage permission', async () => {
    asStaff(undefined, read);
    renderRoute(<App />, `/settings/notifications/rules/${balanceRuleId}`);
    await screen.findByText('View only');
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a test to me' })).not.toBeInTheDocument();
  });
});

describe('save warnings', () => {
  it('keeps a rule open after saving when the server has warnings', async () => {
    let current: NotificationRule = balanceRule;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([read, manage]))),
      http.get('*/api/v1/notification-rules/catalog', () => HttpResponse.json(catalogFixture)),
      http.get('*/api/v1/notification-rules', () => HttpResponse.json({ items: [current] })),
      http.get('*/api/v1/notification-rules/:ruleId', () => HttpResponse.json(current)),
      http.get('*/api/v1/notification-categories', () => HttpResponse.json({ items: categoriesFixture })),
      http.put('*/api/v1/notification-rules/:ruleId', () => {
        current = { ...current, version: 2, warnings: ['Unknown placeholder {persn} in the e-mail title'] };
        return HttpResponse.json(current);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${balanceRuleId}`);
    await user.type(await screen.findByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Check this rule')).toBeInTheDocument();
    expect(screen.getByText('Unknown placeholder {persn} in the e-mail title')).toBeInTheDocument();
    expect(screen.queryByText('Notification rules')).not.toBeInTheDocument();
  });
});

describe('rules list statistics', () => {
  it('draws the last 14 days and the count of the last 30', async () => {
    const withStats: NotificationRule = {
      ...printerRule,
      stats: {
        fired30: 12,
        lastFiredAt: printerRule.lastFiredAt,
        sparkline: [0, 0, 1, 2, 0, 0, 0, 3, 0, 0, 1, 0, 2, 3],
      },
    };
    asStaff([withStats, balanceRule], read, manage);
    renderRoute(<App />, '/settings/notifications');
    expect(await screen.findByText('12 in 30 d')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '12 times in the last 14 days' })).toBeInTheDocument();
  });
});
