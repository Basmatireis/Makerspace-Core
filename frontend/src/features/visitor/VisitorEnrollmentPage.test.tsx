import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { VisitorEnrollmentSubmission } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { VisitorEnrollmentPage } from './VisitorEnrollmentPage';

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
    let contexts = 0;
    server.use(
      http.post('*/api/v1/visitor-enrollment/context', () => {
        contexts += 1;
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
        submission = await request.json() as VisitorEnrollmentSubmission & { roleId?: string };
        return HttpResponse.json({
          personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02',
          accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03',
          accountStatus: 'enabled',
          invitationDelivery: null,
          labRulesRequestId: '0192f6f8-743e-7c77-a349-cd07c3e8ab04',
          admission: 'blocked',
        }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderRoute(<VisitorEnrollmentPage />, '/visitor-enrollment');

    expect(await screen.findByRole('heading', { name: 'Visitor enrollment' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View current Lab Rules PDF' })).toHaveAttribute('href', '/api/v1/visitor-enrollment/lab-rules.pdf');
    expect(screen.queryByText(/password invitation/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Visitor');
    await user.type(screen.getByLabelText('Email'), 'new.visitor@example.test');
    await user.click(screen.getByLabelText('Username and PIN'));
    await user.type(screen.getByLabelText('PIN login username'), 'Visitor.One');
    await user.type(screen.getByLabelText('PIN (6–12 digits)'), '654321');
    const upload = screen.getByLabelText('or upload a profile photo');
    await user.upload(upload, new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'visitor.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByLabelText('I am ready to sign the physical Lab Rules document and request supervisor confirmation'));
    await user.click(screen.getByRole('button', { name: 'Submit enrollment and request confirmation' }));

    expect(await screen.findByRole('heading', { name: 'Enrollment submitted' })).toBeInTheDocument();
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
    expect(queryClient.getMutationCache().getAll().every((mutation) => mutation.state.variables === undefined)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Next visitor' }));
    expect(await screen.findByRole('heading', { name: 'Visitor enrollment' })).toBeInTheDocument();
    expect(contexts).toBe(2);
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.queryByAltText('Selected profile')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Username and PIN')).not.toBeChecked();
  });
});
