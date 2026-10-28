import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { PoliciesTab } from './PoliciesTab';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions }),
}));

const policyId = '0198a000-0000-7000-8000-000000000001';

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: policyId,
    categoryId: 'audit_events',
    version: 1,
    trigger: 'created_at',
    periodDays: 365,
    action: 'delete',
    purpose: 'Accountability',
    legalBasis: 'Art. 6(1)(f)',
    reason: 'One year suffices',
    status: 'draft',
    sourceTemplate: 'legacy:AUDIT_RETENTION',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    approvedAt: null,
    activatedAt: null,
    retiredAt: null,
    createdBy: null,
    approvedBy: null,
    activatedBy: null,
    ...overrides,
  };
}

function categories() {
  return {
    categories: [
      {
        id: 'audit_events',
        name: 'Audit events',
        description: 'Who did what.',
        ownerModuleId: 'platform',
        ownerModuleEnabled: true,
        orphaned: false,
        subject: 'person',
        fields: [],
        triggers: ['created_at', 'ended_at'],
        actions: ['delete', 'anonymize'],
        legacyDefault: null,
        retentionNote: '',
        firstSeenAt: '2026-10-01T00:00:00Z',
        lastSeenAt: '2026-10-01T00:00:00Z',
      },
    ],
  };
}

function useServer(policies: unknown[]) {
  server.use(
    http.get('*/api/v1/privacy/categories', () => HttpResponse.json(categories())),
    http.get('*/api/v1/privacy/policies', () => HttpResponse.json({ policies })),
  );
}

describe('retention policies tab', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.policies.manage'];
  });

  it('lists policies with status and legacy source', async () => {
    useServer([policy()]);
    renderRoute(<PoliciesTab />);
    expect(await screen.findByText('365 days after created_at')).toBeInTheDocument();
    expect(screen.getByText('Seeded from legacy: AUDIT_RETENTION')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText(/Policies are aids, not legal advice/)).toBeInTheDocument();
  });

  it('creates a draft policy with the entered values', async () => {
    const user = userEvent.setup();
    useServer([]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/privacy/policies', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(policy({ sourceTemplate: null }), { status: 201 });
      }),
    );
    renderRoute(<PoliciesTab />);
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Retention starts at'), 'ended_at');
    await user.selectOptions(within(dialog).getByLabelText('Action after the period'), 'anonymize');
    await user.type(within(dialog).getByLabelText('Purpose'), 'Accountability');
    await user.type(within(dialog).getByLabelText('Legal basis'), 'Art. 6(1)(f)');
    await user.type(within(dialog).getByLabelText('Reason for this period'), 'Needed');
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      categoryId: 'audit_events',
      trigger: 'ended_at',
      periodDays: 365,
      action: 'anonymize',
      purpose: 'Accountability',
      legalBasis: 'Art. 6(1)(f)',
      reason: 'Needed',
    });
  });

  it('approves a draft and activates an approved policy after confirmation', async () => {
    const user = userEvent.setup();
    let current = policy();
    server.use(
      http.get('*/api/v1/privacy/categories', () => HttpResponse.json(categories())),
      http.get('*/api/v1/privacy/policies', () => HttpResponse.json({ policies: [current] })),
    );
    const transitions: unknown[] = [];
    server.use(
      http.post('*/api/v1/privacy/policies/:id/transition', async ({ request }) => {
        const next = (await request.json()) as { status: string };
        transitions.push(next.status);
        current = policy({ status: next.status });
        return HttpResponse.json(current);
      }),
    );
    renderRoute(<PoliciesTab />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(transitions).toEqual(['approved']));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/data older than 365 days will be removed on the next run/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Activate' }));
    await vi.waitFor(() => expect(transitions).toEqual(['approved', 'active']));
  });

  it('explains the four-eyes rule', async () => {
    const user = userEvent.setup();
    useServer([policy({ status: 'approved' })]);
    server.use(
      http.post('*/api/v1/privacy/policies/:id/transition', () =>
        HttpResponse.json({ code: 'policy_four_eyes', message: 'nope' }, { status: 409 }),
      ),
    );
    renderRoute(<PoliciesTab />);
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/cannot activate it/)).toBeInTheDocument();
  });

  it('hides editing without the manage permission', async () => {
    auth.permissions = ['privacy.read'];
    useServer([policy()]);
    renderRoute(<PoliciesTab />);
    await screen.findByText('365 days after created_at');
    expect(screen.queryByRole('button', { name: 'New policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
