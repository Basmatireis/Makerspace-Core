import { http, HttpResponse } from 'msw';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ConsentScreen } from './components/ConsentScreen';
import { SurveyOfferScreen } from './components/SurveyOfferScreen';

const visit = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
  displayName: 'Grace Hopper',
  checkedInAt: '2026-10-09T12:00:00Z',
  checkedOutAt: null,
  status: 'checked_in',
  checkInMethod: 'pin',
  checkOutMethod: null,
  admissionDecision: 'admitted',
  correctionReason: null,
  version: 1,
};
const token = 'T'.repeat(43);
const newsId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const surveysId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const ratingId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
const choiceId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';
const textId = '0192f6f8-743e-7c77-a349-cd07c3e8d003';
const optionLaser = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const optionPrint = '0192f6f8-743e-7c77-a349-cd07c3e8e002';

const offer = {
  offerToken: token,
  surveyName: 'Visit feedback',
  questionCount: 3,
  anonymous: true,
  canAnswerNow: true,
  canSendByEmail: true,
  expiresAt: '2026-10-09T12:15:00Z',
};
const survey = {
  title: 'How was your visit?',
  introduction: null,
  anonymous: true,
  expiresAt: null,
  questions: [
    {
      id: ratingId,
      position: 1,
      kind: 'rating',
      prompt: 'How was your visit today?',
      required: true,
      options: [],
      ratingMin: 1,
      ratingMax: 5,
      condition: null,
    },
    {
      id: choiceId,
      position: 2,
      kind: 'single_choice',
      prompt: 'What did you mainly do?',
      required: true,
      options: [
        { id: optionLaser, label: 'Laser cutting', position: 1 },
        { id: optionPrint, label: '3D printing', position: 2 },
      ],
      condition: null,
    },
    {
      id: textId,
      position: 3,
      kind: 'free_text',
      prompt: 'Anything we should change?',
      required: false,
      options: [],
      condition: null,
    },
  ],
};

function mockKiosk(extra: Record<string, unknown> = {}) {
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        allowTapCheckout: false,
        offerSurveysAtCheckout: true,
        kioskResetSeconds: 60,
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['pin'],
        capabilities: ['nfc'],
        staffDestination: 'login',
        ...extra,
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
  );
}

async function signIn(user: ReturnType<typeof userEvent.setup>, action: 'Check in' | 'Check out') {
  await user.click(await screen.findByRole('button', { name: action }));
  await user.type(await screen.findByLabelText('Login name'), 'grace');
  for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
  await user.click(screen.getAllByRole('button', { name: action }).at(-1) as HTMLElement);
}

function mockCheckOut(surveyOffer: unknown = offer) {
  server.use(
    http.post('*/api/v1/terminal/check-out/pin', () =>
      HttpResponse.json({ ...visit, status: 'checked_out', checkedOutAt: '2026-10-09T14:00:00Z', surveyOffer }),
    ),
  );
}

describe('kiosk consent after check-in', () => {
  it('asks before the welcome, preselects nothing, posts the answers and then shows the result', async () => {
    let body: unknown;
    mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', () =>
        HttpResponse.json(
          {
            ...visit,
            consentRequired: true,
            consentCategories: [
              { id: newsId, name: 'News & events', description: 'Workshops and news.', basis: 'consent' },
              { id: surveysId, name: 'Surveys & feedback', description: 'Surveys by e-mail.', basis: 'consent' },
            ],
          },
          { status: 201 },
        ),
      ),
      http.post('*/api/v1/terminal/consents', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check in');

    expect(await screen.findByRole('heading', { name: 'One question before you go in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome, Grace!' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'News & events' })).not.toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Surveys & feedback' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(body).toEqual({
      visitId: visit.id,
      answers: [
        { categoryId: newsId, granted: false },
        { categoryId: surveysId, granted: true },
      ],
    });
  });

  it('lets Continue work with everything off', async () => {
    let body: { answers: { granted: boolean }[] } | undefined;
    mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', () =>
        HttpResponse.json(
          {
            ...visit,
            consentRequired: true,
            consentCategories: [{ id: newsId, name: 'News & events', description: 'News.', basis: 'consent' }],
          },
          { status: 201 },
        ),
      ),
      http.post('*/api/v1/terminal/consents', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check in');
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(body?.answers).toEqual([{ categoryId: newsId, granted: false }]);
  });
});

describe('kiosk check-out survey offer', () => {
  it('shows the offer, asks one question per screen and posts the answers', async () => {
    let submitted: unknown;
    mockKiosk();
    mockCheckOut();
    server.use(
      http.post('*/api/v1/terminal/survey-offers/:token/answer-now', () => HttpResponse.json(survey)),
      http.post('*/api/v1/terminal/survey-offers/:token/responses', async ({ request, params }) => {
        submitted = { token: params.token, body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');

    expect(await screen.findByRole('heading', { name: 'Got a minute?' })).toBeInTheDocument();
    expect(screen.getByText(/Anonymous: your answers are not linked to you/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Answer now' }));

    expect(await screen.findByRole('heading', { name: 'How was your visit today?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '4 of 5' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: 'What did you mainly do?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Laser cutting' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: 'Anything we should change?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { name: 'Thank you, Grace!' })).toBeInTheDocument();
    expect(submitted).toEqual({
      token,
      body: {
        answers: [
          { questionId: ratingId, optionIds: [], numericValue: 4 },
          { questionId: choiceId, optionIds: [optionLaser] },
        ],
      },
    });
  });

  it('sends the survey by e-mail', async () => {
    let called = false;
    mockKiosk();
    mockCheckOut();
    server.use(
      http.post('*/api/v1/terminal/survey-offers/:token/send-email', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');
    await user.click(await screen.findByRole('button', { name: 'Send it by e-mail' }));

    expect(await screen.findByRole('heading', { name: "It's on its way" })).toBeInTheDocument();
    expect(called).toBe(true);
  });

  it('hides the e-mail choice without an address and explains a refused send', async () => {
    mockKiosk();
    mockCheckOut({ ...offer, canSendByEmail: false });
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');

    expect(await screen.findByRole('heading', { name: 'Got a minute?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send it by e-mail' })).not.toBeInTheDocument();
  });

  it('shows the 422 when the e-mail cannot be sent', async () => {
    mockKiosk();
    mockCheckOut();
    server.use(
      http.post('*/api/v1/terminal/survey-offers/:token/send-email', () =>
        HttpResponse.json({ code: 'no_email', message: 'No address' }, { status: 422 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');
    await user.click(await screen.findByRole('button', { name: 'Send it by e-mail' }));

    expect(await screen.findByText(/We have no e-mail address for you/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Got a minute?' })).toBeInTheDocument();
  });

  it('declines with No thanks and shows the check-out result', async () => {
    let called = false;
    mockKiosk();
    mockCheckOut();
    server.use(
      http.post('*/api/v1/terminal/survey-offers/:token/decline', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');
    await user.click(await screen.findByRole('button', { name: 'No thanks' }));

    expect(await screen.findByRole('heading', { name: 'See you, Grace!' })).toBeInTheDocument();
    expect(called).toBe(true);
  });

  it('remembers "Don\'t ask me at check-out again"', async () => {
    let called = false;
    mockKiosk();
    mockCheckOut();
    server.use(
      http.post('*/api/v1/terminal/survey-offers/:token/never', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');
    await user.click(await screen.findByRole('link', { name: "Don't ask me at check-out again" }));

    expect(await screen.findByRole('heading', { name: 'See you, Grace!' })).toBeInTheDocument();
    expect(called).toBe(true);
  });

  it('shows no offer when the check-out answer carries none', async () => {
    mockKiosk();
    mockCheckOut(null);
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await signIn(user, 'Check out');

    expect(await screen.findByRole('heading', { name: 'See you, Grace!' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Got a minute?' })).not.toBeInTheDocument());
  });
});

describe('idle reset', () => {
  afterEach(() => vi.useRealTimers());

  it('drops the offer and returns to the start after the reset time without a touch', () => {
    vi.useFakeTimers();
    const onHome = vi.fn();
    renderRoute(
      <SurveyOfferScreen
        offer={offer}
        displayName="Grace Hopper"
        resetSeconds={15}
        onDeclined={vi.fn()}
        onHome={onHome}
      />,
    );
    act(() => void vi.advanceTimersByTime(10_000));
    // A touch restarts the countdown.
    fireEvent.pointerDown(window);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onHome).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(6_000));
    expect(onHome).toHaveBeenCalled();
  });

  it('leaves the consent question after the reset time', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    renderRoute(
      <ConsentScreen
        visitId={visit.id}
        displayName="Grace Hopper"
        categories={[{ id: newsId, name: 'News & events', description: 'News.', basis: 'consent' }]}
        resetSeconds={20}
        onDone={vi.fn()}
        onIdle={onIdle}
      />,
    );
    act(() => void vi.advanceTimersByTime(21_000));
    expect(onIdle).toHaveBeenCalled();
  });
});
