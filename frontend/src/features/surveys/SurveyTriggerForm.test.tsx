import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import type { Survey } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { describeTrigger, formatDelay } from './triggerFormat';

const surveyId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';

function surveyFixture(overrides: Partial<Survey> = {}): Survey {
  return {
    id: surveyId,
    name: 'Visit feedback',
    description: null,
    status: 'published',
    anonymous: true,
    title: 'How was your visit?',
    introduction: null,
    revision: 1,
    questions: [],
    trigger: {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8b002',
      kind: 'visit_checked_out',
      enabled: true,
      delaySeconds: 1800,
      cooldownDays: 30,
      version: 3,
    },
    responseCount: 0,
    linkCount: 0,
    version: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockPage(survey: Survey, permissions = [PermissionId.surveysread, PermissionId.surveysmanage]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/surveys', () => HttpResponse.json({ items: [survey], total: 1 })),
    http.get('*/api/v1/surveys/:id', () => HttpResponse.json(survey)),
  );
}

describe('survey trigger formatting', () => {
  it('describes delay and cooldown', () => {
    expect(formatDelay(0)).toBe('immediately after check-out');
    expect(formatDelay(5400)).toBe('1 h 30 min after check-out');
    expect(describeTrigger(surveyFixture().trigger)).toBe('Sent 30 min after check-out · cooldown 30 days');
    expect(describeTrigger(null)).toBe('No post-visit trigger configured.');
  });
});

describe('survey trigger form', () => {
  it('shows current values and saves the delay in seconds with the trigger version', async () => {
    let body: unknown;
    mockPage(surveyFixture());
    server.use(
      http.put('*/api/v1/surveys/:id/trigger', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...surveyFixture().trigger, version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/surveys/${surveyId}?tab=delivery`);

    expect(await screen.findByText('Sent 30 min after check-out · cooldown 30 days')).toBeInTheDocument();
    const delay = await screen.findByLabelText('Delay after check-out (minutes)');
    const cooldown = screen.getByLabelText('Cooldown (days)');
    expect(delay).toHaveValue(30);
    expect(screen.getByText('How long after check-out the invitation is sent')).toBeInTheDocument();
    expect(screen.getByText('No new invitation to the same person within this many days')).toBeInTheDocument();

    await user.clear(delay);
    await user.type(delay, '90');
    await user.clear(cooldown);
    await user.type(cooldown, '14');
    await user.click(screen.getByRole('button', { name: 'Save trigger' }));

    await waitFor(() =>
      expect(body).toEqual({ enabled: true, delaySeconds: 5400, cooldownDays: 14, expectedVersion: 3 }),
    );
  });

  it('rejects out-of-range values without calling the API', async () => {
    let called = false;
    mockPage(surveyFixture());
    server.use(
      http.put('*/api/v1/surveys/:id/trigger', () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/surveys/${surveyId}?tab=delivery`);

    const delay = await screen.findByLabelText('Delay after check-out (minutes)');
    await user.clear(delay);
    await user.type(delay, '10081');
    await user.click(screen.getByRole('button', { name: 'Save trigger' }));

    expect(await screen.findByText('Delay must be between 0 and 10080.')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('keeps the trigger disabled on drafts and saves settings with enabled false', async () => {
    let body: unknown;
    mockPage(surveyFixture({ status: 'draft', trigger: null }));
    server.use(
      http.put('*/api/v1/surveys/:id/trigger', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/surveys/${surveyId}?tab=delivery`);

    expect(await screen.findByText('Publish the survey to enable the trigger.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Send after check-out' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Cooldown (days)'));
    await user.type(screen.getByLabelText('Cooldown (days)'), '7');
    await user.click(screen.getByRole('button', { name: 'Save trigger' }));

    await waitFor(() =>
      expect(body).toEqual({ enabled: false, delaySeconds: 1800, cooldownDays: 7, expectedVersion: 0 }),
    );
  });

  it('hides the form without the manage permission', async () => {
    mockPage(surveyFixture(), [PermissionId.surveysread]);
    renderRoute(<App />, `/settings/surveys/${surveyId}?tab=delivery`);

    expect(await screen.findByText('Sent 30 min after check-out · cooldown 30 days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save trigger' })).not.toBeInTheDocument();
  });
});
