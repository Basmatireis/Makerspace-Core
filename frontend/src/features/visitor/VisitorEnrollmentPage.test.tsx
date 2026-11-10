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
    allowedMethods: ['pin'],
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
  invitationDelivery: null,
  admission: 'admitted',
  attendance: 'checked_in',
};

describe('controlled visitor enrollment', () => {
  it('does not expose the enrollment form when backend device verification fails', async () => {
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () =>
        HttpResponse.json({ code: 'not_found', message: 'Resource not found' }, { status: 404 }),
      ),
    );

    renderRoute(<VisitorEnrollmentPage />, '/visitor-enrollment');

    expect(await screen.findByRole('heading', { name: 'Visitor enrollment unavailable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register and check in/i })).not.toBeInTheDocument();
  });

  it('asks the consent question and submits the answers, the method and the Lab Rules, never a Role ID', async () => {
    let submission: (VisitorEnrollmentSubmission & { roleId?: string }) | undefined;
    const suggestionRequests: unknown[] = [];
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () => HttpResponse.json(enrollmentState({ consentCategories }))),
      http.post('*/api/v1/visitor-enrollment/login-name-suggestions', async ({ request }) => {
        suggestionRequests.push(await request.json());
        return HttpResponse.json({ loginName: 'new.visitor2' });
      }),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission & { roleId?: string };
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderKioskAware();

    // Step 1: name, email and photo are required; there is no phone field.
    expect(await screen.findByRole('heading', { name: 'About you' })).toHaveFocus();
    expect(screen.getByText('Visitor enrollment · Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Legal information' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    await user.type(screen.getByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Visitor');
    await choosePhoto(user);
    expect(await screen.findByAltText('Selected profile')).toBeInTheDocument();
    expect(next).toBeDisabled();
    await user.type(screen.getByLabelText('Email'), 'new.visitor@example.test');
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    // Step 2: only the configured method is offered, with a login name suggested from the name.
    expect(await screen.findByRole('heading', { name: 'Sign-in method' })).toHaveFocus();
    expect(screen.queryByRole('tab', { name: 'Email and password' })).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue('new.visitor2')).toBeInTheDocument();
    expect(suggestionRequests).toEqual([{ firstName: 'New', lastName: 'Visitor' }]);
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '65432');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '1');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'About you' })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('New');
    expect(screen.getByAltText('Selected profile')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Login name')).toHaveValue('new.visitor2');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3: nothing is preselected and every switch may stay off.
    expect(await screen.findByRole('heading', { name: 'Messages' })).toHaveFocus();
    expect(screen.getByText(/Which messages may we send to new.visitor@example.test\?/)).toBeInTheDocument();
    const news = screen.getByRole('switch', { name: 'News & events' });
    expect(news).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Surveys & feedback' })).not.toBeChecked();
    expect(screen.getAllByText('No')).toHaveLength(2);
    await user.click(news);
    expect(news).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 4
    expect(await screen.findByRole('heading', { name: 'Lab Rules' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'View current Lab Rules PDF' }));
    expect(await screen.findByText(/Mock PDF viewer/)).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).getByRole('button', {
        name: 'Close',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Mock PDF viewer/)).not.toBeInTheDocument());
    const submit = screen.getByRole('button', { name: 'Register and check in' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('I have read and accept the Lab Rules'));
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: 'New, your account is ready.' })).toBeInTheDocument();
    expect(screen.getByText('new.visitor2')).toBeInTheDocument();
    await waitFor(() => expect(submission).toBeDefined());
    expect(submission).toMatchObject({
      firstName: 'New',
      lastName: 'Visitor',
      email: 'new.visitor@example.test',
      authMethods: ['pin'],
      pinLoginName: 'new.visitor2',
      pin: '654321',
      profileImageFilename: 'profile-photo.jpg',
      labRulesAccepted: true,
      consents: [
        { categoryId: newsId, granted: true },
        { categoryId: surveysId, granted: false },
      ],
    });
    expect(submission?.profileImageBase64).toBe('/9j/2Q==');
    expect(submission).not.toHaveProperty('roleId');
    expect(submission).not.toHaveProperty('phone');
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.variables === undefined),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: /^Done/ }));
    expect(await screen.findByText('Kiosk screen')).toBeInTheDocument();
  });

  it('leaves out the Messages and Lab Rules steps when nothing needs consent and the role asks for no Lab Rules', async () => {
    let submission: VisitorEnrollmentSubmission | undefined;
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json(enrollmentState({ capabilities: [], labRulesRequired: false })),
      ),
      http.post('*/api/v1/visitor-enrollment/login-name-suggestions', () =>
        HttpResponse.json({ code: 'validation_failed', message: 'Invalid' }, { status: 422 }),
      ),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();

    expect(await screen.findByText('Visitor enrollment · Step 1 of 2')).toBeInTheDocument();
    await user.type(screen.getByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Visitor');
    await user.type(screen.getByLabelText('Email'), 'new.visitor@example.test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Sign-in method' })).toBeInTheDocument();
    // Without a suggestion the visitor types a login name of their own.
    await user.type(screen.getByLabelText('Login name'), 'Visitor.One');
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '654321');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));

    expect(await screen.findByRole('heading', { name: 'New, your account is ready.' })).toBeInTheDocument();
    expect(screen.queryByText(/Lab Rules/)).not.toBeInTheDocument();
    expect(submission).toMatchObject({ labRulesAccepted: false, pinLoginName: 'Visitor.One', consents: [] });
  });

  it('preselects the email invitation with the address from the first step and goes back to the kiosk', async () => {
    let submission: VisitorEnrollmentSubmission | undefined;
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json(
          enrollmentState({ allowedMethods: ['password', 'pin'], capabilities: [], labRulesRequired: false }),
        ),
      ),
      http.post('*/api/v1/visitor-enrollment/login-name-suggestions', () =>
        HttpResponse.json({ loginName: 'pia.mail' }),
      ),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission;
        return HttpResponse.json({ ...created, invitationDelivery: 'sent' }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Pia');
    await user.type(screen.getByLabelText('Last name'), 'Mail');
    await user.type(screen.getByLabelText('Email'), 'pia@example.test');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('tab', { name: 'Email and password' })).toHaveAttribute('aria-selected', 'true');
    const address = screen.getByLabelText('Email');
    expect(address).toHaveValue('pia@example.test');
    await user.click(screen.getByRole('tab', { name: 'Login name and PIN' }));
    expect(await screen.findByDisplayValue('pia.mail')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Email and password' }));
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'pia.mail@example.test');
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));

    expect(await screen.findByText('pia.mail@example.test')).toBeInTheDocument();
    expect(submission).toMatchObject({
      email: 'pia.mail@example.test',
      authMethods: ['password'],
      pinLoginName: null,
      pin: null,
    });
    await user.click(screen.getByRole('button', { name: /^Done/ }));
    expect(await screen.findByText('Kiosk screen')).toBeInTheDocument();
  });

  it('skips the photo and does not require it on a kiosk that can neither take nor upload one', async () => {
    let submission: VisitorEnrollmentSubmission | undefined;
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json(enrollmentState({ capabilities: ['nfc'] })),
      ),
      http.post('*/api/v1/visitor-enrollment/login-name-suggestions', () =>
        HttpResponse.json({ loginName: 'nora.nophoto' }),
      ),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Nora');
    await user.type(screen.getByLabelText('Last name'), 'Nophoto');
    await user.type(screen.getByLabelText('Email'), 'nora@example.test');
    expect(screen.queryByText('Profile photo')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start camera' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByDisplayValue('nora.nophoto')).toBeInTheDocument();
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '654321');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByLabelText('I have read and accept the Lab Rules'));
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));
    await waitFor(() => expect(submission).toBeDefined());
    expect(submission?.profileImageBase64).toBeNull();
    expect(submission?.profileImageFilename).toBeNull();
  });

  it('reloads the Lab Rules and asks again when a newer revision became effective during enrollment', async () => {
    const newVersionId = '0192f6f8-743e-7c77-a349-cd07c3e8ab09';
    let revision = { id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' };
    const submissions: VisitorEnrollmentSubmission[] = [];
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json(enrollmentState({ capabilities: ['nfc'], currentLabRules: revision, consentCategories })),
      ),
      http.post('*/api/v1/visitor-enrollment/login-name-suggestions', () =>
        HttpResponse.json({ loginName: 'nora.nophoto' }),
      ),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submissions.push((await request.json()) as VisitorEnrollmentSubmission);
        if (submissions.length === 1) {
          revision = { id: newVersionId, humanRevision: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' };
          return HttpResponse.json({ code: 'lab_rules_changed', message: 'The Lab Rules changed' }, { status: 409 });
        }
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderKioskAware();
    await user.type(await screen.findByLabelText('First name'), 'Nora');
    await user.type(screen.getByLabelText('Last name'), 'Nophoto');
    await user.type(screen.getByLabelText('Email'), 'nora@example.test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByDisplayValue('nora.nophoto')).toBeInTheDocument();
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '654321');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByLabelText('I have read and accept the Lab Rules'));
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));

    expect(await screen.findByText('The Lab Rules changed')).toBeInTheDocument();
    expect(await screen.findByText(/Read the current Lab Rules \(revision 2026-10\)/)).toBeInTheDocument();
    expect(screen.queryByText('Enrollment not completed')).not.toBeInTheDocument();
    expect(screen.getByLabelText('I have read and accept the Lab Rules')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Register and check in' })).toBeDisabled();

    await user.click(screen.getByLabelText('I have read and accept the Lab Rules'));
    await user.click(screen.getByRole('button', { name: 'Register and check in' }));
    expect(await screen.findByRole('heading', { name: 'Nora, your account is ready.' })).toBeInTheDocument();
    expect(submissions).toHaveLength(2);
  });

  describe('inactivity', () => {
    afterEach(() => vi.useRealTimers());

    it('asks whether the visitor is still there and discards everything when nobody answers', async () => {
      server.use(
        http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
        http.get('*/api/v1/visitor-enrollment/state', () =>
          HttpResponse.json(enrollmentState({ currentLabRules: null })),
        ),
      );
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
