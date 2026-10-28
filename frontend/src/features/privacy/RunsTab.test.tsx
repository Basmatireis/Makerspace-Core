import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { RunsTab } from './RunsTab';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions }),
}));

const runId = '0198a000-0000-7000-8000-000000000004';

const item = {
  categoryId: 'audit_events',
  policyId: null,
  action: 'delete',
  cutoff: '2025-10-01T00:00:00Z',
  affectedCount: 42,
  status: 'skipped_hold',
  errorCode: null,
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    mode: 'dry_run',
    trigger: 'manual',
    actorAccountId: null,
    startedAt: '2026-10-01T10:00:00Z',
    finishedAt: '2026-10-01T10:00:01Z',
    status: 'completed',
    errorCode: null,
    items: [],
    ...overrides,
  };
}

describe('execution history tab', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.retention.execute'];
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            {
              id: 'audit_events',
              name: 'Audit events',
              description: 'Who did what when',
              contains: 'Who did what, when',
              erasure: 'none',
              coverage: { policyStatus: 'none', policy: null, hold: null, lastRun: null, processingActivities: [] },
              ownerModuleId: 'platform',
              ownerModuleEnabled: true,
              orphaned: false,
              subject: 'person',
              fields: [],
              triggers: ['created_at'],
              actions: ['delete'],
              legacyDefault: null,
              retentionNote: '',
              firstSeenAt: '2026-10-01T00:00:00Z',
              lastSeenAt: '2026-10-01T00:00:00Z',
            },
          ],
        }),
      ),
      http.get('*/api/v1/privacy/retention/runs', () => HttpResponse.json({ runs: [run()] })),
      http.get(`*/api/v1/privacy/retention/runs/${runId}`, () => HttpResponse.json(run({ items: [item] }))),
      http.get('*/api/v1/privacy/overview', () =>
        HttpResponse.json({
          categories: 1,
          orphanedCategories: 0,
          automaticRunsEnabled: false,
          policiesActive: 4,
          policiesPending: 5,
          withoutPolicy: 20,
          openCategoryHolds: 1,
          openPersonHolds: 0,
          lastRun: null,
        }),
      ),
    );
  });

  it('shows the items of a dry run inline', async () => {
    const user = userEvent.setup();
    let mode: unknown;
    server.use(
      http.post('*/api/v1/privacy/retention/runs', async ({ request }) => {
        mode = ((await request.json()) as { mode: string }).mode;
        return HttpResponse.json(run({ items: [item] }));
      }),
    );
    renderRoute(<RunsTab />);
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('Dry run finished')).toBeInTheDocument();
    expect(
      screen.getByText(/0 categories would change 0 rows\. 1 skipped: on hold\. Nothing was changed\./),
    ).toBeInTheDocument();
    expect(mode).toBe('dry_run');
  });

  it('says so when nothing was planned', async () => {
    const user = userEvent.setup();
    server.use(http.post('*/api/v1/privacy/retention/runs', () => HttpResponse.json(run({ id: null }))));
    renderRoute(<RunsTab />);
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('Nothing to do: no active policy or legacy routine applied.')).toBeInTheDocument();
  });

  it('asks for confirmation before executing', async () => {
    const user = userEvent.setup();
    let mode: unknown;
    server.use(
      http.post('*/api/v1/privacy/retention/runs', async ({ request }) => {
        mode = ((await request.json()) as { mode: string }).mode;
        return HttpResponse.json(run({ mode: 'execute', items: [{ ...item, status: 'applied' }] }));
      }),
    );
    renderRoute(<RunsTab />);
    await user.click(await screen.findByRole('button', { name: 'Execute now' }));
    expect(mode).toBeUndefined();
    expect(await screen.findByText(/This removes data according to the active policies/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Execute' }));
    expect(await screen.findByText('Run finished')).toBeInTheDocument();
    expect(screen.getByText(/1 category changed 42 rows\./)).toBeInTheDocument();
    expect(mode).toBe('execute');
  });

  it('loads the items when a past run is expanded', async () => {
    const user = userEvent.setup();
    renderRoute(<RunsTab />);
    await user.click(await screen.findByRole('button', { name: 'Expand current row' }));
    expect(await screen.findByText('skipped: on hold')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'why?' })).toHaveAttribute('href', '/?tab=holds');
    expect(screen.getByRole('link', { name: 'Audit events' })).toHaveAttribute('href', '/?tab=categories');
    expect(screen.getByText('Who did what when')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute this now' })).toBeInTheDocument();
  });

  it('summarises the result of every run in the table', async () => {
    server.use(
      http.get(`*/api/v1/privacy/retention/runs/${runId}`, () =>
        HttpResponse.json(
          run({
            items: [
              { ...item, status: 'applied', affectedCount: 42 },
              { ...item, categoryId: 'sessions', status: 'skipped_hold' },
              { ...item, categoryId: 'other', status: 'skipped_no_handler', affectedCount: 0 },
            ],
          }),
        ),
      ),
    );
    renderRoute(<RunsTab />);
    expect(await screen.findByText('Would change 42 rows in 1 category')).toBeInTheDocument();
    expect(screen.getByText('1 skipped: on hold · 1 skipped: no policy')).toBeInTheDocument();
    expect(screen.getByText('1 s')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 runs')).toBeInTheDocument();
  });

  it('names the rule of a policy and folds categories without one into a line', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            {
              id: 'audit_events',
              name: 'Audit events',
              description: 'Who did what when',
              contains: '',
              erasure: 'none',
              coverage: {
                policyStatus: 'active',
                policy: { periodDays: 365, trigger: 'created_at', action: 'delete' },
                hold: null,
                lastRun: null,
                processingActivities: [],
              },
              ownerModuleId: 'platform',
              ownerModuleEnabled: true,
              orphaned: false,
              subject: 'person',
              fields: [],
              triggers: ['created_at'],
              actions: ['delete'],
              legacyDefault: null,
              retentionNote: '',
              firstSeenAt: '2026-10-01T00:00:00Z',
              lastSeenAt: '2026-10-01T00:00:00Z',
            },
          ],
        }),
      ),
      http.get(`*/api/v1/privacy/retention/runs/${runId}`, () =>
        HttpResponse.json(
          run({
            items: [
              { ...item, status: 'applied' },
              ...['a', 'b', 'c', 'd'].map((id) => ({ ...item, categoryId: id, status: 'skipped_no_handler' })),
            ],
          }),
        ),
      ),
    );
    renderRoute(<RunsTab />);
    await user.click(await screen.findByRole('button', { name: 'Expand current row' }));
    expect(await screen.findByText('Delete, 365 days after created_at')).toBeInTheDocument();
    expect(screen.getByText('4 categories without a policy')).toBeInTheDocument();
    expect(screen.getByText('Nothing, until a policy is active')).toBeInTheDocument();
  });

  it('describes the automatic runs and the policies', async () => {
    renderRoute(<RunsTab />);
    expect(await screen.findByText(/admin cleanup runs from the server's scheduler/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change in Settings' })).toHaveAttribute('href', '/?tab=settings');
    expect(screen.getByRole('link', { name: 'Retention policies' })).toHaveAttribute('href', '/?tab=policies');
    expect(screen.getByText(/4 active policies, 5 drafts not in force/)).toBeInTheDocument();
  });

  it('filters runs by mode', async () => {
    const user = userEvent.setup();
    renderRoute(<RunsTab />);
    await screen.findByText('Dry run', { selector: '.cds--tag *' });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByLabelText('Executed'));
    expect(await screen.findByText('No runs match the search or filter.')).toBeInTheDocument();
  });

  it('hides the run buttons without the execute permission', async () => {
    auth.permissions = ['privacy.read'];
    renderRoute(<RunsTab />);
    await screen.findByText('Showing 1 of 1 runs');
    expect(screen.queryByRole('button', { name: 'Dry run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute now' })).not.toBeInTheDocument();
  });
});
