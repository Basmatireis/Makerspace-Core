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
const group: PricingGroup = {
  id: 'group-1',
  name: 'Partners',
  description: null,
  active: true,
  isDefault: true,
  version: 2,
  createdAt: now,
  updatedAt: now,
  rules: [
    {
      id: 'rule-1',
      pricingGroupId: 'group-1',
      kind: 'machine_runtime',
      machineTypeId: 'type-1',
      materialTypeId: null,
      materialTypeName: null,
      materialUnit: null,
      rate: '0.500000',
      active: true,
      version: 3,
    },
    {
      id: 'rule-2',
      pricingGroupId: 'group-1',
      kind: 'machine_measure',
      machineTypeId: 'type-emb',
      materialTypeId: null,
      materialTypeName: null,
      materialUnit: null,
      measure: 'stitches',
      blockSize: 1000,
      rate: '0.350000',
      active: true,
      version: 1,
    },
  ],
};
const machineType = (id: string, name: string, process: string) => ({
  id,
  name,
  active: true,
  process,
  version: 1,
  createdAt: now,
  updatedAt: now,
});

function configure(permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group] })),
    http.get('*/api/v1/machine-types', () =>
      HttpResponse.json({
        items: [machineType('type-1', 'Laser', 'laser_cutting'), machineType('type-emb', 'Embroidery', 'embroidery')],
      }),
    ),
    http.get('*/api/v1/material-types', () =>
      HttpResponse.json({
        items: [
          {
            id: 'mat-pla',
            name: 'PLA',
            unit: 'g',
            processes: ['fdm_printing'],
            active: true,
            materialCount: 1,
            pricingRuleCount: 0,
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    ),
    http.get('*/api/v1/pricing-role-groups', () =>
      HttpResponse.json({
        items: [
          {
            roleId: 'role-a',
            roleName: 'Student',
            pricingGroupId: 'group-1',
            pricingGroupName: 'Partners',
            priority: 2,
          },
        ],
      }),
    ),
    http.get('*/api/v1/roles', () =>
      HttpResponse.json({
        items: [
          { id: 'role-a', name: 'Student' },
          { id: 'role-b', name: 'Staff' },
        ],
        nextCursor: null,
      }),
    ),
    http.get('*/api/v1/organizations', () =>
      HttpResponse.json({
        items: [
          {
            id: 'org-1',
            name: 'Institute',
            kind: 'institute',
            active: true,
            pricingGroup: { id: 'group-1', name: 'Partners' },
            memberCount: 0,
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      }),
    ),
  );
}

describe('pricing page', () => {
  it('shows the rates matrix per pricing group with measure rates and missing rates', async () => {
    configure([PermissionId.pricingread, PermissionId.machinesread, PermissionId.inventoryread]);
    renderRoute(<App />, '/pricing');
    const table = await screen.findByRole('table', { name: 'Rates' });
    expect(within(table).getByText('Laser runtime')).toBeInTheDocument();
    expect(within(table).getByText('Embroidery · Stitches')).toBeInTheDocument();
    expect(within(table).getByText('0,35')).toBeInTheDocument();
    expect(within(table).getAllByText('Missing')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Set rate/ })).not.toBeInTheDocument();
  });

  it('edits an existing rate with its version and creates a missing one', async () => {
    configure([
      PermissionId.pricingread,
      PermissionId.pricingmanage,
      PermissionId.machinesread,
      PermissionId.inventoryread,
    ]);
    let update: Record<string, unknown> | undefined;
    let create: Record<string, unknown> | undefined;
    server.use(
      http.patch('*/api/v1/pricing-rules/rule-1', async ({ request }) => {
        update = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...group.rules[0], ...update });
      }),
      http.post('*/api/v1/pricing-groups/group-1/rules', async ({ request }) => {
        create = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(group.rules[0], { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/pricing');
    await screen.findByRole('table', { name: 'Rates' });
    await user.click(await screen.findByLabelText('Edit Laser runtime for Partners'));
    const input = screen.getByLabelText('Rate for Laser runtime in Partners');
    await user.clear(input);
    await user.type(input, '0,75');
    await user.click(screen.getByLabelText('Save rate'));
    await waitFor(() =>
      expect(update).toMatchObject({
        expectedVersion: 3,
        kind: 'machine_runtime',
        machineTypeId: 'type-1',
        rate: '0.75',
        active: true,
      }),
    );
    await user.click(screen.getAllByRole('button', { name: 'Set rate' }).at(-1)!);
    await user.type(screen.getByLabelText(/^Rate for PLA in Partners/), '0.03');
    await user.click(screen.getByLabelText('Save rate'));
    await waitFor(() =>
      expect(create).toEqual({
        kind: 'material',
        machineTypeId: null,
        materialTypeId: 'mat-pla',
        measure: null,
        rate: '0.03',
      }),
    );
  });

  it('saves the role mapping with priorities and links organizations', async () => {
    configure([
      PermissionId.pricingread,
      PermissionId.pricingmanage,
      PermissionId.rolesread,
      PermissionId.organizationsread,
    ]);
    let saved: Record<string, unknown> | undefined;
    server.use(
      http.put('*/api/v1/pricing-role-groups', async ({ request }) => {
        saved = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ items: [] });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/pricing?tab=roles');
    await user.selectOptions(await screen.findByLabelText('Pricing group of the role Staff'), 'group-1');
    await user.click(screen.getByRole('button', { name: 'Save role mapping' }));
    await waitFor(() =>
      expect(saved).toEqual({
        items: [
          { roleId: 'role-a', pricingGroupId: 'group-1', priority: 2 },
          { roleId: 'role-b', pricingGroupId: 'group-1', priority: 1 },
        ],
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Organizations' }));
    expect(await screen.findByRole('link', { name: 'Institute' })).toHaveAttribute('href', '/organizations/org-1');
  });

  it('keeps the old settings route as a redirect', async () => {
    configure([PermissionId.pricingread]);
    const { router } = renderRoute(<App />, '/settings/machine-logbook');
    await waitFor(() => expect(router.state.location.pathname).toBe('/pricing'));
  });
});
