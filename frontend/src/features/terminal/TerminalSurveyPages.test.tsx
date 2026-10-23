import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SubmitSurveyResponse } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const visitId = '0192f6f8-743e-7c77-a349-cd07c3e8a941';

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a942';

function mockTerminal(checkoutMode: 'public_tap' | 'authenticated', presence: object) {
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        checkoutMode,
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['password', 'pin'],
        capabilities: ['nfc'],
        staffDestination: 'login',
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json(presence)),
  );
}

const adaPresence = {
  items: [{ visitId, displayName: 'Ada L.', checkedInAt: '2026-10-09T12:00:00Z' }],
  count: 1,
  waiting: [],
};

async function enterPin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Check in' }));
  await user.type(await screen.findByLabelText('Login name'), 'ada');
  for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
}

describe('public terminal and survey pages', () => {
  it('keeps the visitor terminal public and performs privacy-conscious tap checkout', async () => {
    let authRequests = 0;
    let checkedOut = false;
    server.use(
      http.get('*/api/v1/auth/me', () => {
        authRequests += 1;
        return HttpResponse.json({ code: 'unauthenticated', message: 'Authentication required' }, { status: 401 });
      }),
      http.post('*/api/v1/terminal/presence/:visitId/check-out', ({ params }) => {
        checkedOut = params.visitId === visitId;
        return HttpResponse.json({
          id: visitId,
          personId,
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
    mockTerminal('public_tap', adaPresence);
    const user = userEvent.setup();
    renderRoute(<App />, '/terminal');

    expect(await screen.findByRole('heading', { name: 'Welcome to the Makerspace' })).toBeInTheDocument();
    const publicName = await screen.findByText('Ada L.');
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Register as a visitor/ })).toHaveAttribute('href', '/visitor-enrollment');
    expect(screen.getByRole('link', { name: /Staff sign in/ })).toHaveAttribute('href', '/login');
    expect(authRequests).toBe(0);

    await user.click(publicName);
    await user.click(await screen.findByRole('button', { name: 'Check out Ada L.' }));
    await waitFor(() => expect(checkedOut).toBe(true));
    expect(await screen.findByRole('heading', { name: 'See you, Ada!' })).toBeInTheDocument();
  });

  it('shows the Lab Rules hold screen and lists waiting people', async () => {
    mockTerminal('public_tap', {
      items: [],
      count: 0,
      waiting: [{ holdId: visitId, displayName: 'Grace Hopper', requestedAt: '2026-10-09T12:00:00Z' }],
    });
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', () =>
        HttpResponse.json(
          {
            id: visitId,
            personId,
            displayName: 'Grace Hopper',
            requestedAt: '2026-10-09T12:00:00Z',
            expiresAt: '2026-10-09T18:00:00Z',
            checkInMethod: 'pin',
            laborordnungRequestId: null,
            requiredRevision: '3',
            previousRevision: null,
          },
          { status: 202 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/terminal');

    expect(await screen.findByText('Waiting for Lab Rules')).toBeInTheDocument();
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('not checked in')).toBeInTheDocument();

    await enterPin(user);
    await user.click(screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement);
    expect(await screen.findByText('Check-in on hold')).toBeInTheDocument();
    expect(screen.getByText('Grace, you are not checked in.')).toBeInTheDocument();
    expect(screen.getByText('You have not signed the Lab Rules yet. Ask a supervisor for help.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Understood/ })).toBeInTheDocument();
  });

  it('does not offer tap checkout when the terminal requires credentials', async () => {
    mockTerminal('authenticated', adaPresence);
    const user = userEvent.setup();
    renderRoute(<App />, '/terminal');

    await user.click(await screen.findByText('Ada L.'));
    expect(screen.queryByRole('button', { name: 'Check out Ada L.' })).not.toBeInTheDocument();
    expect(screen.queryByText('Leaving? Tap your name to check out.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check out' }));
    expect(await screen.findByLabelText('Login name')).toBeInTheDocument();
  });

  it('renders every supported survey question type and submits typed answers', async () => {
    const token = 'a'.repeat(43);
    let submitted: SubmitSurveyResponse | undefined;
    const questions = [
      {
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a951',
        kind: 'single_choice',
        prompt: 'Purpose',
        required: false,
        position: 1,
        ratingMin: null,
        ratingMax: null,
        options: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a961', label: 'Making', position: 1 }],
      },
      {
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a952',
        kind: 'multiple_choice',
        prompt: 'Areas',
        required: false,
        position: 2,
        ratingMin: null,
        ratingMax: null,
        options: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a962', label: 'Wood', position: 1 }],
      },
      {
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a953',
        kind: 'free_text',
        prompt: 'Comments',
        required: false,
        position: 3,
        ratingMin: null,
        ratingMax: null,
        options: [],
      },
      {
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a954',
        kind: 'rating',
        prompt: 'Rating',
        required: false,
        position: 4,
        ratingMin: 1,
        ratingMax: 5,
        options: [],
      },
      {
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a955',
        kind: 'yes_no',
        prompt: 'Return',
        required: false,
        position: 5,
        ratingMin: null,
        ratingMax: null,
        options: [],
      },
    ];
    server.use(
      http.get('*/api/v1/public/surveys/:token', () =>
        HttpResponse.json({
          title: 'Visit feedback',
          introduction: 'Tell us about the visit.',
          anonymous: true,
          questions,
          expiresAt: '2026-10-20T00:00:00Z',
        }),
      ),
      http.post('*/api/v1/public/surveys/:token', async ({ request }) => {
        submitted = (await request.json()) as SubmitSurveyResponse;
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

    await waitFor(() =>
      expect(submitted?.answers).toEqual([
        { questionId: questions[2].id, optionIds: [], textValue: 'Helpful team' },
        { questionId: questions[4].id, optionIds: [], booleanValue: true },
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
  });
});
