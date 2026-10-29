import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { CategoryRetentionPage } from './CategoryRetentionPage';

const auth = { permissions: ['privacy.read', 'privacy.policies.manage', 'privacy.retention.execute'] as string[] };

vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions, authentication: { reauthenticationRequired: [] } }),
}));

const category = {
  id: 'attendance.visits',
  name: 'Visits and holds',
  description: 'Who was in the lab when.',
  contains: 'Check-in and check-out times, corrections, admission holds',
  erasure: 'erased',
  ownerModuleId: 'attendance',
  orphaned: false,
  subject: 'person',
  fields: ['visits.*', 'attendance_holds.*'],
  triggers: ['completed_at', 'created_at'],
  actions: ['anonymize', 'delete'],
  legacyDefault: {
    trigger: 'completed_at',
    periodDays: 90,
    action: 'anonymize',
    source: 'admin cleanup (code)',
    zeroDisables: false,
  },
  retentionNote: '',
  firstSeenAt: '2026-10-01T00:00:00Z',
  lastSeenAt: '2026-10-28T00:00:00Z',
  coverage: { policyStatus: 'none', policy: null, hold: null, lastRun: null, processingActivities: [] },
};

function policy(overrides: Record<string, unknown>) {
  return {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a001',
    categoryId: 'attendance.visits',
    version: 1,
    trigger: 'completed_at',
    periodDays: 90,
    action: 'anonymize',
    purpose: '',
    legalBasis: '',
    reason: 'Seeded.',
    status: 'draft',
    sourceTemplate: 'legacy:admin cleanup (code)',
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
    approvedAt: null,
    activatedAt: null,
    retiredAt: null,
    createdBy: null,
    approvedBy: null,
    activatedBy: null,
    ...overrides,
  };
}

function useServer(policies: unknown[], categoryOverrides: Record<string, unknown> = {}) {
  server.use(
    http.get('*/api/v1/privacy/categories', () =>
      HttpResponse.json({ categories: [{ ...category, ...categoryOverrides }] }),
    ),
    http.get('*/api/v1/privacy/policies', () => HttpResponse.json({ policies })),
  );
}

describe('category retention page', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.policies.manage', 'privacy.retention.execute'];
  });

  it('starts a category without any decision from the previous behaviour and saves it as a draft', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    useServer([]);
    server.use(
      http.post('*/api/v1/privacy/policies', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(policy({ purpose: 'Statistics' }), { status: 201 });
      }),
    );
    renderRoute(<CategoryRetentionPage />, '/settings/privacy/categories/attendance.visits');
    expect(await screen.findByRole('heading', { name: 'Visits and holds' })).toBeInTheDocument();
    expect(screen.getByText('No decision yet')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /It is completed/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Anonymise/ })).toBeChecked();
    expect(screen.getByText('Visits and holds are anonymised 90 days after it is completed.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Purpose'), 'Statistics');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      categoryId: 'attendance.visits',
      trigger: 'completed_at',
      periodDays: 90,
      action: 'anonymize',
      purpose: 'Statistics',
    });
  });

  it('edits the existing draft next to the decision in force and approves it', async () => {
    const user = userEvent.setup();
    const transitions: string[] = [];
    const active = policy({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a002',
      version: 2,
      status: 'active',
      purpose: 'Statistics',
      legalBasis: 'Art. 6(1)(f) GDPR',
      reason: 'Three months.',
      activatedAt: '2026-10-14T00:00:00Z',
    });
    const draft = policy({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a003',
      version: 3,
      periodDays: 120,
      purpose: 'Statistics and supervision',
      legalBasis: 'Art. 6(1)(f) GDPR',
      reason: 'Four months.',
    });
    useServer([draft, active], { coverage: { ...category.coverage, policyStatus: 'active', policy: active } });
    server.use(
      http.post('*/api/v1/privacy/policies/:id/transition', async ({ params, request }) => {
        const body = (await request.json()) as { status: string };
        transitions.push(`${String(params.id)}:${body.status}`);
        return HttpResponse.json({ ...draft, status: body.status });
      }),
    );
    renderRoute(<CategoryRetentionPage />, '/settings/privacy/categories/attendance.visits');
    expect(await screen.findByText('You are editing a new version (v3)')).toBeInTheDocument();
    expect(screen.getByLabelText('Keep for (days)')).toHaveValue(120);
    expect(screen.getByText(/In force today/)).toBeInTheDocument();
    expect(screen.getByText('in force')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dry run the decision in force' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Approve v3' }));
    await waitFor(() => expect(transitions).toEqual(['0192f6f8-743e-7c77-a349-cd07c3e8a003:approved']));
  });

  it('is read-only without the policies permission', async () => {
    auth.permissions = ['privacy.read'];
    const active = policy({ version: 2, status: 'active', purpose: 'Statistics' });
    useServer([], { coverage: { ...category.coverage, policyStatus: 'active', policy: active } });
    renderRoute(<CategoryRetentionPage />, '/settings/privacy/categories/attendance.visits');
    expect(await screen.findByRole('heading', { name: 'Visits and holds' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Getting it into force')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Purpose')).toHaveValue('Statistics');
  });

  it('sends an unknown category back to the categories', async () => {
    useServer([]);
    const { router } = renderRoute(<CategoryRetentionPage />, '/settings/privacy/categories/nope.nothing');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/privacy'));
  });
});
