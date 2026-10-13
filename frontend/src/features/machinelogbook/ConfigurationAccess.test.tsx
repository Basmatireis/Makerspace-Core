import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId, type Organization, type PricingGroup } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const now = '2026-09-15T11:26:00Z';
const organization: Organization = { id: 'org-1', name: 'Workshop partners', kind: 'association', active: true, pricingGroupAssignmentVersion: 1, version: 4, createdAt: now, updatedAt: now };
const group: PricingGroup = { id: 'group-1', name: 'Partners', description: null, active: true, isDefault: false, version: 2, createdAt: now, updatedAt: now,
  rules: [{ id: 'rule-1', pricingGroupId: 'group-1', kind: 'machine_runtime', machineTypeId: 'type-1', materialCategory: null, materialUnit: null, rate: '0.50', active: true, version: 3 }] };

function configure(permissions: PermissionId[]) {
  const reads = { organizations: 0, pricing: 0, machines: 0 };
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/organizations', () => { reads.organizations++; return HttpResponse.json({ items: [organization], page: 1, pageSize: 25, total: 1 }); }),
    http.get('*/api/v1/pricing-groups', () => { reads.pricing++; return HttpResponse.json({ items: [group] }); }),
    http.get('*/api/v1/machine-types', () => { reads.machines++; return HttpResponse.json({ items: [] }); }),
  );
  return reads;
}

describe('independent machine configuration access', () => {
  it.each([
    [PermissionId.organizationsread, 'Organizations', 'Pricing groups'],
    [PermissionId.pricingread, 'Pricing groups', 'Organizations'],
  ] as const)('opens %s independently without foreign lookups', async (permission, visible, hidden) => {
    const reads = configure([permission]);
    renderRoute(<App />, '/settings/machine-logbook');
    expect(await screen.findByRole('tab', { name: visible })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: hidden })).not.toBeInTheDocument();
    await screen.findByRole('heading', { name: visible });
    expect(reads.machines).toBe(0);
    expect(permission === PermissionId.organizationsread ? reads.pricing : reads.organizations).toBe(0);
    expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
  });

  it('does not allow machine read permission alone into configuration', async () => {
    const reads = configure([PermissionId.machinesread]);
    const { router } = renderRoute(<App />, '/settings/machine-logbook');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(reads).toEqual({ organizations: 0, pricing: 0, machines: 0 });
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
    const reads = configure([PermissionId.pricingread, PermissionId.pricingmanage]);
    let submitted: Record<string, unknown> | undefined;
    server.use(http.post('*/api/v1/pricing-groups/group-1/rules', async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...group.rules[0], ...submitted }); }));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Rule kind')).toHaveValue('material');
    await user.selectOptions(within(dialog).getByLabelText('Pricing group'), 'group-1');
    await user.type(within(dialog).getByLabelText('Normalized material category'), 'PLA');
    await user.type(within(dialog).getByLabelText('Rate (€ per unit)'), '0.03');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(submitted).toMatchObject({ kind: 'material', machineTypeId: null, materialCategory: 'pla', rate: '0.03' }));
    expect(reads.machines).toBe(0);
  });

  it('preserves organization edits after a failure, Escape and Keep editing', async () => {
    configure([PermissionId.organizationsread, PermissionId.organizationsmanage]);
    server.use(http.patch('*/api/v1/organizations/org-1', () => HttpResponse.json({ code: 'stale_write' }, { status: 409 })));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Retained draft');
    await user.click(screen.getByRole('button', { name: 'Save organization' }));
    await screen.findByText('Organization not saved');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog').closest('.cds--modal')).not.toHaveClass('is-visible');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Retained draft');
  });
});
