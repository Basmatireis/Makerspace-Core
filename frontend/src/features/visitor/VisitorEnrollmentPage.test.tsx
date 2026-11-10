import { http, HttpResponse } from 'msw';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisitorEnrollmentSubmission } from '../../api/generated/models';
import { Route, Routes } from 'react-router-dom';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { VisitorEnrollmentPage } from './VisitorEnrollmentPage';

vi.mock('../../app/pdf/renderPdf', () => ({
  renderPdf: async (url: string, container: HTMLElement, _signal: AbortSignal, onFirstPage: () => void) => {
    container.textContent = `Mock PDF viewer ${url}`;
    onFirstPage();
  },
}));

// jsdom has no canvas; the crop geometry is tested on its own.
vi.mock('../users/profilePhotoCrop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users/profilePhotoCrop')>()),
  renderCrop: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
}));

const versionId = '0192f6f8-743e-7c77-a349-cd07c3e8ab01';
const newsId = '0192f6f8-743e-7c77-a349-cd07c3e8ab21';
const surveysId = '0192f6f8-743e-7c77-a349-cd07c3e8ab22';
const consentCategories = [
  { id: newsId, name: 'News & events', description: 'Workshops and events.', basis: 'consent' },
  { id: surveysId, name: 'Surveys & feedback', description: 'Surveys about your visit.', basis: 'consent' },
];

function enrollmentState(overrides: Record<string, unknown> = {}) {
  return {
    email: null,
    emailVerified: false,
    capabilities: ['camera', 'file_upload'],
    labRulesRequired: true,
    currentLabRules: { id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' },
    consentCategories: [],
    expiresAt: '2026-09-20T12:15:00Z',
    ...overrides,
  };
}

const created = {
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02',
  accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03',
  accountStatus: 'enabled',
  admission: 'admitted',
  attendance: 'checked_in',
};

const baseUrl = '*/api/v1/visitor-enrollment';

// Context and state for every test; individual tests add the email and submission handlers.
function serveState(overrides: Record<string, unknown> = {}) {
  server.use(
    http.post(`${baseUrl}/context`, () => new HttpResponse(null, { status: 204 })),
    http.get(`${baseUrl}/state`, () => HttpResponse.json(enrollmentState(overrides))),
  );
}

// Email handlers that accept code 123456, recording what was sent.
function serveEmailVerification() {
  const sent: string[] = [];
  const confirmed: string[] = [];
  server.use(
    http.post(`${baseUrl}/email-verification`, async ({ request }) => {
      sent.push(((await request.json()) as { email: string }).email);
      return new HttpResponse(null, { status: 202 });
    }),
    http.post(`${baseUrl}/email-verification/confirm`, async ({ request }) => {
      const { code } = (await request.json()) as { code: string };
      confirmed.push(code);
      return code === '123456'
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ code: 'challenge_invalid', message: 'The code is invalid or expired' }, { status: 422 });
    }),
  );
  return { sent, confirmed };
}

describe('controlled visitor enrollment', () => {
  it('does not expose the enrollment form when backend device verification fails', async () => {
    server.use(
      http.post(`${baseUrl}/context`, () =>
        HttpResponse.json({ code: 'not_found', message: 'Resource not found' }, { status: 404 }),
      ),
    );

    renderRoute(<VisitorEnrollmentPage />, '/visitor-enrollment');

    expect(await screen.findByRole('heading', { name: 'Visitor enrollment unavailable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register and check in/i })).not.toBeInTheDocument();
  });

  it('verifies the email with a mailed code, asks the consent question and submits without any credentials', async () => {
    let submission: (VisitorEnrollmentSubmission & Record<string, unknown>) | undefined;
    serveState({ consentCategories });
    const { sent, confirmed } = serveEmailVerification();
    server.use(
      http.post(`${baseUrl}/submissions`, async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission & Record<string, unknown>;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderKioskAware();

    // Step 1: name and photo are required; the email has its own step.
    expect(await screen.findByRole('heading', { name: 'About you' })).toHaveFocus();
    expect(screen.getByText('Visitor enrollment · Step 1 of 5')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Legal information' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    await user.type(screen.getByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Visitor');
    expect(next).toBeDisabled();
    await choosePhoto(user);
    expect(await screen.findByAltText('Selected profile')).toBeInTheDocument();
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    // Step 2: nothing is sent until the visitor asks for the code.
    expect(await screen.findByRole('heading', { name: 'Email' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    const sendCode = screen.getByRole('button', { name: 'Send code' });
    expect(sendCode).toBeDisabled();
    await user.type(screen.getByLabelText('Email'), 'new.visitor@example.test');
    await user.click(sendCode);

    // Step 3: a wrong code stays on the step with an inline message.
    expect(await screen.findByRole('heading', { name: 'Code' })).toBeInTheDocument();
    expect(sent).toEqual(['new.visitor@example.test']);
    expect(screen.getByText('new.visitor@example.test')).toBeInTheDocument();
    const codeField = screen.getByLabelText('Code');
    expect(codeField).toHaveFocus();
    expect(codeField).toHaveAttribute('inputmode', 'numeric');
    await user.type(codeField, '12a34');
    expect(codeField).toHaveValue('1234');
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeDisabled();
    await user.type(codeField, '99');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByText(/The code is not correct or has expired/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Code' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(confirmed).toEqual(['123499', '123456']);

    // Step 4: nothing is preselected and every switch may stay off.
    expect(await screen.findByRole('heading', { name: 'Messages' })).toHaveFocus();
    expect(screen.getByText(/Which messages may we send to new.visitor@example.test\?/)).toBeInTheDocument();
    const news = screen.getByRole('switch', { name: 'News & events' });
    expect(news).not.toBeChecked();
    await user.click(news);
    expect(news).toBeChecked();

    // Back skips the used-up code step.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('new.visitor@example.test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 5: the confirmation is locked until the Lab Rules were opened.
    expect(await screen.findByRole('heading', { name: 'Lab Rules' })).toHaveFocus();
    const accept = screen.getByLabelText('I have read and accept the Lab Rules');
    expect(accept).toBeDisabled();
    expect(screen.getByText('Open the Lab Rules to confirm')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Register and check in' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'View current Lab Rules PDF' }));
    expect(await screen.findByText(/Mock PDF viewer/)).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).getByRole('button', {
        name: 'Close',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Mock PDF viewer/)).not.toBeInTheDocument());
    expect(screen.queryByText('Open the Lab Rules to confirm')).not.toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('I have read and accept the Lab Rules'));
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: 'New, your account is ready.' })).toBeInTheDocument();
    expect(screen.getByText('new.visitor@example.test')).toBeInTheDocument();
    await waitFor(() => expect(submission).toBeDefined());
    expect(submission).toMatchObject({
      firstName: 'New',
      lastName: 'Visitor',
      profileImageFilename: 'profile-photo.jpg',
      labRulesAccepted: true,
      consents: [
        { categoryId: newsId, granted: true },
        { categoryId: surveysId, granted: false },
      ],
    });
    expect(submission?.profileImageBase64).toBe('/9j/2Q==');
    for (const field of ['roleId', 'phone', 'email', 'authMethods', 'pin', 'pinLoginName']) {
      expect(submission).not.toHaveProperty(field);
    }
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.variables === undefined),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: /^Done/ }));
    expect(await screen.findByText('Kiosk screen')).toBeInTheDocument();
  });

  it('keeps the visitor on the email step with a clear message when the address or the delivery is refused', async () => {
    serveState({ capabilities: [], labRulesRequired: false });
    const attempts: Array<{ status: number; code: string }> = [];
    server.use(
      http.post(`${baseUrl}/email-verification`, () => {
        const failure = attempts.shift()!;
        return HttpResponse.json({ code: failure.code, message: 'Refused' }, { status: failure.status });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Pia');
    await user.type(screen.getByLabelText('Last name'), 'Mail');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const email = await screen.findByLabelText('Email');

    // Checked in the browser first: nothing is sent for an obviously wrong address.
    await user.type(email, 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText("This doesn't look like a valid email address")).toBeInTheDocument();

    const cases: Array<[number, string, string | RegExp]> = [
      [422, 'email_invalid', "This doesn't look like a valid email address"],
      [422, 'email_delivery_failed', /We couldn't send a code to this address\. Check it or use another one\./],
      [503, 'mail_unavailable', /ask a supervisor/],
      [429, 'verification_rate_limited', /Too many codes were requested/],
    ];
    await user.clear(email);
    await user.type(email, 'pia@example.test');
    for (const [status, code, text] of cases) {
      attempts.push({ status, code });
      await user.click(screen.getByRole('button', { name: 'Send code' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      // Nothing moved on: still the email step, still no code field.
      expect(screen.getByRole('heading', { name: 'Email' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    }
  });

  it('points a visitor whose email already has an account to the check-in', async () => {
    serveState({ capabilities: [] });
    server.use(
      http.post(`${baseUrl}/email-verification`, () =>
        HttpResponse.json({ code: 'authentication_identifier_exists', message: 'Exists' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Pia');
    await user.type(screen.getByLabelText('Last name'), 'Mail');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Email'), 'pia@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(
      await screen.findByText('This email already has an account — go back and check in instead'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Go to check-in' }));
    expect(await screen.findByText('Kiosk screen')).toBeInTheDocument();
  });

  it('resends the code and goes back to change the address', async () => {
    serveState({ capabilities: [] });
    const { sent } = serveEmailVerification();
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Pia');
    await user.type(screen.getByLabelText('Last name'), 'Mail');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Email'), 'pia@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('heading', { name: 'Code' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(await screen.findByText('We sent you a new code.')).toBeInTheDocument();
    expect(sent).toEqual(['pia@example.test', 'pia@example.test']);

    await user.click(screen.getByRole('button', { name: 'Change email' }));
    const email = await screen.findByLabelText('Email');
    expect(email).toHaveValue('pia@example.test');
    await user.clear(email);
    await user.type(email, 'pia.other@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('heading', { name: 'Code' })).toBeInTheDocument();
    expect(sent).toEqual(['pia@example.test', 'pia@example.test', 'pia.other@example.test']);
  });

  it('registers right after the code when there is neither consent nor Lab Rules, and needs no photo without a camera', async () => {
    let submission: VisitorEnrollmentSubmission | undefined;
    serveState({ capabilities: ['nfc'], labRulesRequired: false, currentLabRules: null });
    serveEmailVerification();
    server.use(
      http.post(`${baseUrl}/submissions`, async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();

    expect(await screen.findByText('Visitor enrollment · Step 1 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start camera' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('First name'), 'Nora');
    await user.type(screen.getByLabelText('Last name'), 'Nophoto');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Email'), 'nora@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and register' }));

    expect(await screen.findByRole('heading', { name: 'Nora, your account is ready.' })).toBeInTheDocument();
    expect(screen.queryByText(/Lab Rules/)).not.toBeInTheDocument();
    expect(screen.getByText('nora@example.test')).toBeInTheDocument();
    expect(submission).toMatchObject({
      firstName: 'Nora',
      lastName: 'Nophoto',
      profileImageBase64: null,
      profileImageFilename: null,
      labRulesAccepted: false,
      consents: [],
    });
  });

  it('reloads the Lab Rules and asks again when a newer revision became effective during enrollment', async () => {
    const newVersionId = '0192f6f8-743e-7c77-a349-cd07c3e8ab09';
    let revision = { id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' };
    const submissions: VisitorEnrollmentSubmission[] = [];
    server.use(
      http.post(`${baseUrl}/context`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${baseUrl}/state`, () =>
        HttpResponse.json(enrollmentState({ capabilities: ['nfc'], currentLabRules: revision })),
      ),
      http.post(`${baseUrl}/submissions`, async ({ request }) => {
        submissions.push((await request.json()) as VisitorEnrollmentSubmission);
        if (submissions.length === 1) {
          revision = { id: newVersionId, humanRevision: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' };
          return HttpResponse.json({ code: 'lab_rules_changed', message: 'The Lab Rules changed' }, { status: 409 });
        }
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    serveEmailVerification();
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Nora');
    await user.type(screen.getByLabelText('Last name'), 'Nophoto');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Email'), 'nora@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    await openRulesAndAccept(user);
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));

    expect(await screen.findByText('The Lab Rules changed')).toBeInTheDocument();
    expect(await screen.findByText(/Read the current Lab Rules \(revision 2026-10\)/)).toBeInTheDocument();
    expect(screen.queryByText('Enrollment not completed')).not.toBeInTheDocument();
    // The new revision has to be opened again before it can be accepted.
    expect(screen.getByLabelText('I have read and accept the Lab Rules')).not.toBeChecked();
    expect(screen.getByLabelText('I have read and accept the Lab Rules')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Register and check in' })).toBeDisabled();

    await openRulesAndAccept(user);
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));
    expect(await screen.findByRole('heading', { name: 'Nora, your account is ready.' })).toBeInTheDocument();
    expect(submissions).toHaveLength(2);
  });

  it('asks for the email again when the server no longer has a verified address', async () => {
    serveState({ capabilities: [], labRulesRequired: false });
    serveEmailVerification();
    server.use(
      http.post(`${baseUrl}/submissions`, () =>
        HttpResponse.json({ code: 'email_verification_required', message: 'Verify' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Nora');
    await user.type(screen.getByLabelText('Last name'), 'Nophoto');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Email'), 'nora@example.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and register' }));

    expect(await screen.findByText('Please confirm your email address again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
  });

  describe('inactivity', () => {
    afterEach(() => vi.useRealTimers());

    it('asks whether the visitor is still there and discards everything when nobody answers', async () => {
      serveState({ currentLabRules: null });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderKioskAware();
      expect(await screen.findByLabelText('First name')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(30_000));
      expect(screen.getByText(/Returning to check-in in (29|30) s/)).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(10_000));
      expect(screen.getByText(/Returning to check-in in (19|20|21) s/)).toBeInTheDocument();
      // "Still here" restarts the idle period.
      act(() => screen.getByRole('button', { name: 'Still here' }).click());
      act(() => void vi.advanceTimersByTime(29_000));
      expect(screen.queryByText(/Returning to check-in/)).not.toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(61_000));
      expect(screen.getByText('Kiosk screen')).toBeInTheDocument();
    });
  });
});

async function openRulesAndAccept(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'View current Lab Rules PDF' }));
  expect(await screen.findByText(/Mock PDF viewer/)).toBeInTheDocument();
  await user.click(
    within(screen.getByRole('dialog', { name: /Lab Rules, revision/ })).getByRole('button', { name: 'Close' }),
  );
  await waitFor(() => expect(screen.queryByText(/Mock PDF viewer/)).not.toBeInTheDocument());
  await user.click(screen.getByLabelText('I have read and accept the Lab Rules'));
}

// Choosing a file opens the round-mask cropper; the photo only counts once it is confirmed.
async function choosePhoto(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(
    screen.getByLabelText('or upload a profile photo'),
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'visitor.jpg', { type: 'image/jpeg' }),
  );
  const image = (await screen.findByRole('group', { name: 'Photo position' })).querySelector('img')!;
  Object.defineProperty(image, 'naturalWidth', { value: 800 });
  Object.defineProperty(image, 'naturalHeight', { value: 600 });
  fireEvent.load(image);
  await user.click(screen.getByRole('button', { name: 'Use photo' }));
}

function renderKioskAware() {
  return renderRoute(
    <Routes>
      <Route path="/visitor-enrollment" element={<VisitorEnrollmentPage />} />
      <Route path="/kiosk" element={<p>Kiosk screen</p>} />
    </Routes>,
    '/visitor-enrollment',
  );
}
