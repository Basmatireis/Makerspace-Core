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
  rules: [{ id: 'rule-1', pricingGroupId: 'group-1', kind: 'machine_measure', machineTypeId: 'type-emb', materialTypeId: null, materialTypeName: null, materialUnit: null, measure: 'stitches', blockSize: 1000, rate: '0.500000', active: true, version: 3 }] };
const machineType = (id: string, name: string, process: 'embroidery' | 'laser_cutting') => ({ id, name, active: true, process, version: 1, createdAt: now, updatedAt: now });

describe('pricing rules for run measures', () => {
  it('shows the rate per 1000 stitches and creates a measure rule for embroidery machine types only', async () => {
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.pricingread, PermissionId.pricingmanage, PermissionId.machinesread]))),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group] })),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [machineType('type-emb', 'Embroidery machine', 'embroidery'), machineType('type-laser', 'Laser cutter', 'laser_cutting')] })),
      http.post('*/api/v1/pricing-groups/group-1/rules', async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...group.rules[0], id: 'rule-2' }, { status: 201 }); }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('machine measure')).toBeInTheDocument();
    expect(within(table).getByText('€ 0.500000 per 1000 stitches')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Pricing group'), 'group-1');
    await user.selectOptions(within(dialog).getByLabelText('Rule kind'), 'machine_measure');
    const types = within(dialog).getByLabelText('Machine type');
    await waitFor(() => expect(within(types).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a type', 'Embroidery machine']));
    await user.selectOptions(types, 'type-emb');
    expect(within(dialog).getByLabelText('Measure')).toHaveValue('stitches');
    await user.type(within(dialog).getByLabelText('Rate (€ per 1000 stitches)'), '0.35');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(submitted).toEqual({ kind: 'machine_measure', machineTypeId: 'type-emb', materialTypeId: null, measure: 'stitches', rate: '0.35' }));
  });
});
