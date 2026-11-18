import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PermissionId, PersonNotificationSettings } from '../../../api/generated/models';
import { App } from '../../../app/App';
import { currentUserFixture, otherPersonId, personFixture } from '../../../test/fixtures';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';

const serviceId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const newsId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const optionalRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';
const mandatoryRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';

function fixture(hasAccount = true): PersonNotificationSettings {
  return {
    personId: otherPersonId,
    hasAccount,
    settings: {
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
      rules: hasAccount
        ? [
            {
              ruleId: optionalRuleId,
              name: 'Monthly newsletter',
              description: '',
              categoryId: newsId,
              categoryName: 'News & events',
              mandatory: false,
              why: ['They are a member'],
              triggerSummary: 'Once a month',
              defaultChannels: ['email'],
              effectiveChannels: ['email'],
              blockedByConsent: false,
            },
            {
              ruleId: mandatoryRuleId,
              name: 'Printer error',
              description: '',
              categoryId: serviceId,
              categoryName: 'Service & safety',
              mandatory: true,
              why: ['They are a supervisor'],
              triggerSummary: 'When a printer reports an error',
              defaultChannels: ['in_app', 'email'],
              effectiveChannels: ['email'],
              blockedByConsent: false,
            },
          ]
        : [],
    },
  };
}

function setup(permissions: PermissionId[], data = fixture()) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(['people.read.all', ...permissions]))),
    http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture())),
    http.get(`*/api/v1/people/${otherPersonId}/notification-settings`, () => HttpResponse.json(data)),
  );
}

const tab = () => screen.findByRole('tab', { name: 'Notifications' }, { timeout: 5000 });

describe('Notifications on the person detail page', () => {
  it('has no tab without a notification settings permission', async () => {
    setup([]);
    renderRoute(<App />, `/people/${otherPersonId}`);
    await screen.findByRole('tablist', { name: 'Person detail sections' }, { timeout: 5000 });
    expect(screen.queryByRole('tab', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('shows everything read-only with the read permission', async () => {
    setup(['notification_settings.read.all']);
    renderRoute(<App />, `/people/${otherPersonId}?tab=notifications`);
    await tab();
    expect(await screen.findByText('Monthly newsletter')).toBeInTheDocument();
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.getByText(/Answered/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Allow News & events' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Monthly newsletter: in the app' })).toBeDisabled();
  });

  it('saves channel choices with the manage permission', async () => {
    setup(['notification_settings.manage.all']);
    const bodies: unknown[] = [];
    server.use(
      http.put(
        `*/api/v1/people/${otherPersonId}/notification-settings/rules/:ruleId/preference`,
        async ({ request, params }) => {
          bodies.push({ ruleId: params.ruleId, ...((await request.json()) as object) });
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=notifications`);
    await user.click(await screen.findByRole('switch', { name: 'Monthly newsletter: in the app' }));
    await waitFor(() => expect(bodies).toContainEqual({ ruleId: optionalRuleId, inApp: true, email: true }));
    // Consent answers stay the person's own.
    expect(screen.queryByRole('switch', { name: 'Allow News & events' })).not.toBeInTheDocument();
    // A required rule keeps its last channel.
    expect(screen.getByRole('switch', { name: 'Printer error: by e-mail' })).toBeDisabled();
  });

  it('shows the backend message when a required rule is refused', async () => {
    setup(['notification_settings.manage.all']);
    server.use(
      http.put(`*/api/v1/people/${otherPersonId}/notification-settings/rules/:ruleId/preference`, () =>
        HttpResponse.json(
          { code: 'mandatory_notification', message: 'This notification is required.' },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/people/${otherPersonId}?tab=notifications`);
    await user.click(await screen.findByRole('switch', { name: 'Monthly newsletter: by e-mail' }));
    expect(await screen.findByText('This notification is required.')).toBeInTheDocument();
  });

  it('explains that a person without an account has no channel choices', async () => {
    setup(['notification_settings.manage.all'], fixture(false));
    renderRoute(<App />, `/people/${otherPersonId}?tab=notifications`);
    expect(await screen.findByText('No account')).toBeInTheDocument();
    expect(screen.queryByText('Rules that reach this person')).not.toBeInTheDocument();
  });
});
