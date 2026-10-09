import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SubmitSurveyResponse } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const visitId = '0192f6f8-743e-7c77-a349-cd07c3e8a941';

describe('public terminal and survey pages', () => {
  it('keeps the visitor terminal public and performs privacy-conscious tap checkout', async () => {
    let authRequests = 0;
    let checkedOut = false;
    server.use(
      http.get('*/api/v1/auth/me', () => {
        authRequests += 1;
        return HttpResponse.json({ code: 'unauthenticated', message: 'Authentication required' }, { status: 401 });
      }),
      http.get('*/api/v1/terminal/context', () => HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        checkoutMode: 'public_tap',
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['password', 'pin'],
        capabilities: ['nfc'],
        staffDestination: 'login',
      })),
      http.get('*/api/v1/terminal/presence', () => HttpResponse.json({
        items: [{ visitId, displayName: 'Ada L.', checkedInAt: '2026-10-09T12:00:00Z' }],
        count: 1,
      })),
      http.post('*/api/v1/terminal/presence/:visitId/check-out', ({ params }) => {
        checkedOut = params.visitId === visitId;
        return HttpResponse.json({
          id: visitId,
          personId: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
          displayName: 'Ada Lovelace',
          checkedInAt: '2026-10-09T12:00:00Z',
          checkedOutAt: '2026-10-09T13:00:00Z',
          status: 'checked_out',
          checkInMethod: 'pin',
          checkOutMethod: 'public_tap',
          admissionDecision: 'admitted',
          correctionReason: null,
          version: 2,
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/terminal');

    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    const publicName = await screen.findByText('Ada L.');
    expect(publicName).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register as a new visitor' })).toHaveAttribute('href', '/visitor-enrollment');
    expect(screen.getByRole('link', { name: 'Staff sign in' })).toHaveAttribute('href', '/login');
    expect(authRequests).toBe(0);

    await user.click(within(publicName.closest('.cds--tile') as HTMLElement).getByRole('button', { name: 'Check out' }));
    await waitFor(() => expect(checkedOut).toBe(true));
    expect(await screen.findByText('Ada Lovelace is checked out.')).toBeInTheDocument();
  });

  it('renders every supported survey question type and submits typed answers', async () => {
    const token = 'a'.repeat(43);
    let submitted: SubmitSurveyResponse | undefined;
    const questions = [
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a951', kind: 'single_choice', prompt: 'Purpose', required: false, position: 1, ratingMin: null, ratingMax: null, options: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a961', label: 'Making', position: 1 }] },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a952', kind: 'multiple_choice', prompt: 'Areas', required: false, position: 2, ratingMin: null, ratingMax: null, options: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a962', label: 'Wood', position: 1 }] },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a953', kind: 'free_text', prompt: 'Comments', required: false, position: 3, ratingMin: null, ratingMax: null, options: [] },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a954', kind: 'rating', prompt: 'Rating', required: false, position: 4, ratingMin: 1, ratingMax: 5, options: [] },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a955', kind: 'yes_no', prompt: 'Return', required: false, position: 5, ratingMin: null, ratingMax: null, options: [] },
    ];
    server.use(
      http.get('*/api/v1/public/surveys/:token', () => HttpResponse.json({
        title: 'Visit feedback', introduction: 'Tell us about the visit.', anonymous: true,
        questions, expiresAt: '2026-10-20T00:00:00Z',
      })),
      http.post('*/api/v1/public/surveys/:token', async ({ request }) => {
        submitted = await request.json() as SubmitSurveyResponse;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/survey/${token}`);

    expect(await screen.findByRole('heading', { name: 'Visit feedback' })).toBeInTheDocument();
    for (const prompt of ['Purpose', 'Areas', 'Comments', 'Rating', 'Return']) {
      expect(screen.getByText(prompt)).toBeInTheDocument();
    }
    expect(screen.getByText('Your response is stored without a person identifier.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your answer'), 'Helpful team');
    await user.click(screen.getByLabelText('Yes'));
    await user.click(screen.getByRole('button', { name: 'Submit response' }));

    await waitFor(() => expect(submitted?.answers).toEqual([
      { questionId: questions[2].id, optionIds: [], textValue: 'Helpful team' },
      { questionId: questions[4].id, optionIds: [], booleanValue: true },
    ]));
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
  });
});
