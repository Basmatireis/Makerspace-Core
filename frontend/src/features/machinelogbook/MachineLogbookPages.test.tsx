import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const machineTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8a910';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const organizationId = '0192f6f8-743e-7c77-a349-cd07c3e8a915';

const machine = {
  id: machineId,
  machineType: { id: machineTypeId, name: '3D printer', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  name: 'Bambu H2D #1',
  status: 'active' as const,
  externalIdentifier: 'BH2D-1',
  automaticCollectionEnabled: true,
  lastIngestedAt: '2026-09-15T11:26:00Z',
  jobCount: 42,
  runtimeSeconds: 84000,
  failureRate: '4.2',
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-15T11:26:00Z',
};

describe('Machine Logbook pages', () => {
  it('submits optimistic organization and pricing-rule edits', async () => {
    let organizationUpdate: Record<string, unknown> | undefined;
    let ruleUpdate: Record<string, unknown> | undefined;
    const organization = { id: organizationId, name: 'TU Berlin', kind: 'institute' as const, active: true, pricingGroup: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a930', name: 'Partner' }, pricingGroupAssignmentVersion: 1, version: 4, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    const rule = { id: '0192f6f8-743e-7c77-a349-cd07c3e8a931', pricingGroupId: organization.pricingGroup.id, kind: 'machine_runtime' as const, machineTypeId, materialCategory: null, materialUnit: null, rate: '0.5', active: true, version: 3 };
    const group = { id: organization.pricingGroup.id, name: 'Partner', description: null, active: true, isDefault: false, rules: [rule], version: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.organizationsread, PermissionId.organizationsmanage, PermissionId.pricingread, PermissionId.pricingmanage, PermissionId.machinesread]))),
      http.get('*/api/v1/organizations', () => HttpResponse.json({ items: [organization], page: 1, pageSize: 100, total: 1 })),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group] })),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [machine.machineType] })),
      http.patch(`*/api/v1/organizations/${organizationId}`, async ({ request }) => {
        organizationUpdate = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...organization, ...organizationUpdate, version: 5 });
      }),
      http.patch(`*/api/v1/pricing-rules/${rule.id}`, async ({ request }) => {
        ruleUpdate = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...rule, ...ruleUpdate, version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    const heading = await screen.findByRole('heading', { name: 'Machines configuration' });
    const shell = heading.closest('[data-page-shell]');
    expect(shell).toHaveAttribute('data-page-width', 'wide');
    expect(shell?.querySelector('.page-header__tabs')).toContainElement(
      screen.getByRole('tablist', { name: 'Configuration sections' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'TU Berlin Makerspace');
    await user.click(within(dialog).getByRole('button', { name: 'Save organization' }));
    await waitFor(() => expect(organizationUpdate).toMatchObject({ expectedVersion: 4, name: 'TU Berlin Makerspace', kind: 'institute', active: true }));

    await user.click(screen.getByRole('tab', { name: 'Pricing groups' }));
    await user.click(await screen.findByRole('button', { name: 'Edit rule for Partner' }));
    dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Rate (€ per hour)'));
    await user.type(within(dialog).getByLabelText('Rate (€ per hour)'), '0.75');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(ruleUpdate).toMatchObject({ expectedVersion: 3, kind: 'machine_runtime', machineTypeId, rate: '0.75', active: true }));
  });

  it('does not expose the overview to an inventory-only reader', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.inventoryread]))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0, totalInventoryValue: '0' })),
    );
    renderRoute(<App />, '/machine-logbook');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeInTheDocument();
  });
});
