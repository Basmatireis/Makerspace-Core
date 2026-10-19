import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId, type PricingGroup } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const now = '2026-09-15T11:26:00Z';
const group: PricingGroup = { id: 'group-1', name: 'Partners', description: null, active: true, isDefault: false, version: 2, createdAt: now, updatedAt: now,
  rules: [{ id: 'rule-1', pricingGroupId: 'group-1', kind: 'machine_runtime', machineTypeId: 'type-1', materialTypeId: null, materialTypeName: null, materialUnit: null, rate: '0.50', active: true, version: 3 }] };

function configure(permissions: PermissionId[]) {
  const reads = { pricing: 0, machines: 0 };
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/pricing-groups', () => { reads.pricing++; return HttpResponse.json({ items: [group] }); }),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ id: 'type-pla', name: 'PLA', unit: 'g', active: true, materialCount: 1, pricingRuleCount: 0, version: 1, createdAt: now, updatedAt: now }] })),
    http.get('*/api/v1/machine-types', () => { reads.machines++; return HttpResponse.json({ items: [] }); }),
  );
  return reads;
}

describe('independent machine configuration access', () => {
  it('opens pricing configuration with pricing read alone, without foreign lookups', async () => {
    const reads = configure([PermissionId.pricingread]);
    renderRoute(<App />, '/settings/machine-logbook');
    await screen.findByRole('heading', { name: 'Pricing groups' });
    expect(reads.machines).toBe(0);
    expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('no longer opens pricing configuration with organization access alone and keeps a link to organizations', async () => {
    const reads = configure([PermissionId.organizationsread]);
    const { router } = renderRoute(<App />, '/settings/machine-logbook');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(reads).toEqual({ pricing: 0, machines: 0 });
  });

  it('links to the organizations page from pricing configuration', async () => {
    configure([PermissionId.pricingread, PermissionId.organizationsread]);
    renderRoute(<App />, '/settings/machine-logbook');
    expect(await screen.findByRole('link', { name: /Directory › Organizations/ })).toHaveAttribute('href', '/organizations');
  });

  it('does not allow machine read permission alone into configuration', async () => {
    const reads = configure([PermissionId.machinesread]);
    const { router } = renderRoute(<App />, '/settings/machine-logbook');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(reads).toEqual({ pricing: 0, machines: 0 });
  });

  it('preserves an existing machine selector while editing its rate without machine read', async () => {
    const reads = configure([PermissionId.pricingread, PermissionId.pricingmanage]);
    let submitted: Record<string, unknown> | undefined;
    server.use(http.patch('*/api/v1/pricing-rules/rule-1', async ({ request }) => {
      submitted = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...group.rules[0], ...submitted, version: 4 });
    }));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    await user.click(await screen.findByRole('button', { name: 'Edit rule for Partners' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Machine type')).toHaveValue('type-1');
    expect(within(dialog).getByLabelText('Machine type')).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Rate (€ per hour)'));
    await user.type(within(dialog).getByLabelText('Rate (€ per hour)'), '1.25');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(submitted).toMatchObject({ machineTypeId: 'type-1', rate: '1.25', expectedVersion: 3 }));
    expect(reads.machines).toBe(0);
  });

  it('allows material pricing without machine lookup access', async () => {
    const reads = configure([PermissionId.pricingread, PermissionId.pricingmanage, PermissionId.inventoryread]);
    let submitted: Record<string, unknown> | undefined;
    server.use(http.post('*/api/v1/pricing-groups/group-1/rules', async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...group.rules[0], ...submitted }); }));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Rule kind')).toHaveValue('material');
    await user.selectOptions(within(dialog).getByLabelText('Pricing group'), 'group-1');
    await user.selectOptions(within(dialog).getByLabelText('Material type'), 'type-pla');
    await user.type(within(dialog).getByLabelText('Rate (€ per unit)'), '0.03');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(submitted).toMatchObject({ kind: 'material', machineTypeId: null, materialTypeId: 'type-pla', rate: '0.03' }));
    expect(reads.machines).toBe(0);
  });
});
