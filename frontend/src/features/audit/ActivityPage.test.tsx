import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const baseEvent: AuditEvent = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
  actorType: 'user',
  actorAccountId: '0192f6f8-743e-7c77-a349-cd07c3e8a922',
  actorDisplayName: 'Ada Lovelace',
  action: 'person.updated',
  resourceType: 'person',
  resourceId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
  resourceDisplayName: 'Grace Hopper',
  occurredAt: '2026-09-23T08:00:00Z',
  requestId: null,
  changedFields: ['firstName'],
  metadata: {},
  resolvedMetadata: {},
  source: 'http',
};

function authorizeActivity() {
  server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.auditread]))));
}

describe('Activity log', () => {
  it('shows the Settings tile and guards the route with audit.read', async () => {
    authorizeActivity();
    server.use(http.get('*/api/v1/audit-events', () => HttpResponse.json({ items: [] })));
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Activity log' })).toBeInTheDocument();

    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())));
    renderRoute(<App />, '/settings/activity');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders readable activity and loads the next cursor page', async () => {
    authorizeActivity();
    server.use(http.get('*/api/v1/audit-events', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (cursor) {
        return HttpResponse.json({ items: [{ ...baseEvent, id: '0192f6f8-743e-7c77-a349-cd07c3e8a924', actorType: 'system', actorAccountId: null, actorDisplayName: null, action: 'managed_device.revoked', resourceType: 'managed_device', resourceDisplayName: 'Front desk' }], nextCursor: null });
      }
      return HttpResponse.json({ items: [baseEvent], nextCursor: 'next-page' });
    }));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/activity');

    const table = await screen.findByRole('table', { name: 'Activity log' });
    expect(within(table).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(table).getByText('Updated person')).toBeInTheDocument();
    expect(within(table).getByText('Grace Hopper')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more activity' }));
    expect(await within(table).findByText('Revoked managed device')).toBeInTheDocument();
    expect(within(table).getByText('System')).toBeInTheDocument();
  });

  it('synchronizes filters to the URL and resets cursor pagination', async () => {
    authorizeActivity();
    const requests: URL[] = [];
    server.use(http.get('*/api/v1/audit-events', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({ items: [], nextCursor: null });
    }));
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/settings/activity');
    await screen.findByText('No activity found');

    await user.selectOptions(screen.getByLabelText('Actor type'), 'system');
    await user.selectOptions(screen.getByLabelText('Action'), 'person.updated');
    await user.selectOptions(screen.getByLabelText('Target type'), 'person');
    await user.type(screen.getByRole('searchbox', { name: 'Search current actor name' }), 'Ada');

    await waitFor(() => {
      const latest = requests.at(-1)!;
      expect(latest.searchParams.get('actorType')).toBe('system');
      expect(latest.searchParams.get('action')).toBe('person.updated');
      expect(latest.searchParams.get('resourceType')).toBe('person');
      expect(latest.searchParams.get('actorSearch')).toBe('Ada');
      expect(latest.searchParams.has('cursor')).toBe(false);
    });
    expect(router.state.location.search).toContain('actorType=system');
  });

  it('shows empty and error states', async () => {
    authorizeActivity();
    server.use(http.get('*/api/v1/audit-events', () => HttpResponse.json({ items: [] })));
    const first = renderRoute(<App />, '/settings/activity');
    expect(await screen.findByText('No activity found')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('*/api/v1/audit-events', () => HttpResponse.json({ code: 'failed', message: 'failed', requestId: 'request' }, { status: 500 })));
    renderRoute(<App />, '/settings/activity');
    expect(await screen.findByText('Unable to load activity')).toBeInTheDocument();
  });
});
