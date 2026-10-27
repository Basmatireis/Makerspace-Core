import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const policyId = '0192f6f8-743e-7c77-a349-cd07c3e8a940';
const policy = {
  id: policyId,
  name: 'Entrance terminal',
  idleTimeoutSeconds: 600,
  absoluteLifetimeSeconds: 43200,
  postSessionDestination: 'visitor_terminal' as const,
  isDefault: false,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('Session policies', () => {
  it('lists policies with the number of devices using them and edits one in a modal', async () => {
    let saved: unknown;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.session_policiesmanage, PermissionId.managed_devicesread])),
      ),
      http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [policy] })),
      http.get('*/api/v1/managed-devices', () =>
        HttpResponse.json({
          items: [
            { sessionPolicyId: policyId, id: 'a' },
            { sessionPolicyId: policyId, id: 'b' },
            { sessionPolicyId: null, id: 'c' },
          ].map((item) => ({
            ...item,
            name: item.id,
            deviceTypeId: item.id,
            deviceTypeName: 'Kiosk',
            status: 'active',
            expiresAt: null,
            revokedAt: null,
            lastSeenAt: null,
            terminalEnabled: false,
            allowedApplicationModes: ['staff_ui'],
            checkInAssurance: 'low',
            checkOutAssurance: 'low',
            checkoutMode: 'verified',
            capabilities: [],
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          })),
          nextCursor: null,
        }),
      ),
      http.put('*/api/v1/session-policies/:id', async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ ...policy, version: 2 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/session-policies');
    const row = (await screen.findByRole('button', { name: 'Entrance terminal' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('10m')).toBeInTheDocument();
    expect(within(row).getByText('12h')).toBeInTheDocument();
    expect(await within(row).findByText('2')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Entrance terminal' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Policy saved')).toBeInTheDocument();
    expect(saved).toMatchObject({ name: 'Entrance terminal', expectedVersion: 1 });
  });
});
