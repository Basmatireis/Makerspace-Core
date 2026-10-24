import { http, HttpResponse } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisitorEnrollmentSubmission } from '../../api/generated/models';
import { Route, Routes } from 'react-router-dom';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { VisitorEnrollmentPage } from './VisitorEnrollmentPage';

vi.mock('./components/renderPdf', () => ({
  renderPdf: async (url: string, container: HTMLElement, _signal: AbortSignal, onFirstPage: () => void) => {
    container.textContent = `Mock PDF viewer ${url}`;
    onFirstPage();
  },
}));

const versionId = '0192f6f8-743e-7c77-a349-cd07c3e8ab01';

describe('controlled visitor enrollment', () => {
  it('does not expose the enrollment form when backend device verification fails', async () => {
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () =>
        HttpResponse.json({ code: 'not_found', message: 'Resource not found' }, { status: 404 }),
      ),
    );

    renderRoute(<VisitorEnrollmentPage />, '/visitor-enrollment');

    expect(await screen.findByRole('heading', { name: 'Visitor enrollment unavailable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit enrollment/i })).not.toBeInTheDocument();
  });

  it('submits only the configured method and explicit confirmation request, never a Role ID', async () => {
    let submission: (VisitorEnrollmentSubmission & { roleId?: string }) | undefined;
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json({
          allowedMethods: ['pin'],
          currentLabRules: {
            id: versionId,
            humanRevision: '2026-09',
            effectiveAt: '2026-09-01T00:00:00Z',
          },
          expiresAt: '2026-09-20T12:15:00Z',
        }),
      ),
      http.post('*/api/v1/visitor-enrollment/submissions', async ({ request }) => {
        submission = (await request.json()) as VisitorEnrollmentSubmission & { roleId?: string };
        return HttpResponse.json(
          {
            personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02',
            accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03',
            accountStatus: 'enabled',
            invitationDelivery: null,
            labRulesRequestId: '0192f6f8-743e-7c77-a349-cd07c3e8ab04',
            admission: 'blocked',
            attendance: 'awaiting_sign_off',
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderTerminalAware();

    // Step 1: required fields and the contact rule are visible, Next stays disabled until the step is valid.
    expect(await screen.findByRole('heading', { name: 'About you' })).toHaveFocus();
    expect(screen.getByText(/Email or phone, at least one/)).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.type(screen.getByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Visitor');
    await user.type(screen.getByLabelText('Email'), 'new.visitor@example.test');
    expect(next).toBeDisabled();
    await user.upload(
      screen.getByLabelText('or upload a profile photo'),
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'visitor.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByAltText('Selected profile')).toBeInTheDocument();
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    // Step 2: only the configured method is offered; entries survive going back.
    expect(await screen.findByRole('heading', { name: 'Sign-in method' })).toHaveFocus();
    expect(screen.queryByLabelText(/Email invitation/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Login name and PIN/)).toBeChecked();
    await user.type(screen.getByLabelText('PIN login username'), 'Visitor.One');
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '65432');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '1');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'About you' })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('New');
    expect(screen.getByAltText('Selected profile')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('PIN login username')).toHaveValue('Visitor.One');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3
    expect(await screen.findByRole('heading', { name: 'Lab Rules' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'View current Lab Rules PDF' }));
    expect(await screen.findByText(/Mock PDF viewer/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).getByRole('button', {
        name: 'Close',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Mock PDF viewer/)).not.toBeInTheDocument());
    const submit = screen.getByRole('button', { name: 'Submit enrollment' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText(/I am ready to sign the physical Lab Rules document/));
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: 'New, your account is ready.' })).toBeInTheDocument();
    expect(screen.getByText(/checked in automatically once a supervisor confirms/)).toBeInTheDocument();
    expect(screen.getByText(/Ask a supervisor for the paper Lab Rules/)).toBeInTheDocument();
    expect(screen.getByText('Visitor.One')).toBeInTheDocument();
    await waitFor(() => expect(submission).toBeDefined());
    expect(submission).toMatchObject({
      firstName: 'New',
      lastName: 'Visitor',
      email: 'new.visitor@example.test',
      authMethods: ['pin'],
      pinLoginName: 'Visitor.One',
      pin: '654321',
      profileImageFilename: 'visitor.jpg',
      requestConfirmation: true,
    });
    expect(submission?.profileImageBase64).toBe('/9j/2Q==');
    expect(submission).not.toHaveProperty('roleId');
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.variables === undefined),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: /^Done/ }));
    expect(await screen.findByText('Terminal screen')).toBeInTheDocument();
  });

  it('offers the email invitation only with an email address and goes back to the terminal', async () => {
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
      http.get('*/api/v1/visitor-enrollment/state', () =>
        HttpResponse.json({
          allowedMethods: ['password', 'pin'],
          currentLabRules: { id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' },
          expiresAt: '2026-09-20T12:15:00Z',
        }),
      ),
    );
    const user = userEvent.setup();
    renderTerminalAware();
    await user.type(await screen.findByLabelText('First name'), 'Pia');
    await user.type(screen.getByLabelText('Last name'), 'Phone');
    await user.type(screen.getByLabelText('Phone'), '+43 660 1234567');
    await user.upload(
      screen.getByLabelText('or upload a profile photo'),
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'visitor.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText(/Email invitation/)).toBeDisabled();
    expect(screen.getByText(/you did not enter an email address/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: 'Back to check-in' }));
    expect(await screen.findByText('Terminal screen')).toBeInTheDocument();
  });

  describe('inactivity', () => {
    afterEach(() => vi.useRealTimers());

    it('asks whether the visitor is still there and discards everything when nobody answers', async () => {
      server.use(
        http.post('*/api/v1/visitor-enrollment/context', () => new HttpResponse(null, { status: 204 })),
        http.get('*/api/v1/visitor-enrollment/state', () =>
          HttpResponse.json({
            allowedMethods: ['pin'],
            currentLabRules: null,
            expiresAt: '2026-09-20T12:15:00Z',
          }),
        ),
      );
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderTerminalAware();
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
      expect(screen.getByText('Terminal screen')).toBeInTheDocument();
    });
  });
});

function renderTerminalAware() {
  return renderRoute(
    <Routes>
      <Route path="/visitor-enrollment" element={<VisitorEnrollmentPage />} />
      <Route path="/terminal" element={<p>Terminal screen</p>} />
    </Routes>,
    '/visitor-enrollment',
  );
}
