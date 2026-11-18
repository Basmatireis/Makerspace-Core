import type { Page } from '@playwright/test';
import { expect, test } from './machines-jobs-test';
import { customer, ids, staffPermissions } from './machines-jobs-api';

const jobPath = `/workshop/jobs/${ids.jobSuccess}`;

const draft = {
  id: '01900000-0000-7000-8000-0000000000d1',
  reference: 'O-2026-000042',
  status: 'draft',
  currency: 'EUR',
  customerKind: customer.kind,
  customer: { kind: customer.kind, id: customer.id },
  customerName: null,
  totalAmount: '8.00',
  netCharge: '8.00',
  settledAmount: '0.00',
  outstandingAmount: '8.00',
  settlementState: 'unpaid',
  replacesOrderId: null,
  replacesOrderReference: null,
  replacedByOrderId: null,
  replacedByOrderReference: null,
  activeExternalRequestId: null,
  activeExternalRequestReference: null,
  activeExternalRequestState: null,
  latestExternalRequestId: null,
  latestExternalRequestReference: null,
  latestExternalRequestState: null,
  items: [],
  allocations: [],
  adjustments: [],
  attention: [],
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  createdBy: null,
};

/** Answers the draft-order lookup of the Add to order dialog and records which customer it asked for. */
async function mockDrafts(page: Page, drafts: unknown[]) {
  const asked: URLSearchParams[] = [];
  await page.route('**/api/v1/orders?*', (route) => {
    const url = new URL(route.request().url());
    asked.push(url.searchParams);
    const items = drafts.filter((order) => url.searchParams.get('customerId') === (order as typeof draft).customer.id);
    return route.fulfill({ json: { items, page: 1, pageSize: 100, total: items.length } });
  });
  return asked;
}

test.describe('billing a job', () => {
  test.use({ userPermissions: [...staffPermissions, 'orders.write'] });

  test('Add to order offers the recipient’s draft order', async ({ page }) => {
    const asked = await mockDrafts(page, [draft]);
    await page.goto(jobPath);
    await page.getByRole('button', { name: 'Add to order' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Add to order' }) });
    await expect(dialog.getByRole('radio', { name: `Draft order of ${customer.displayName}` })).toBeChecked();
    await expect(dialog.getByText(`1 draft order of ${customer.displayName}.`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add to order' })).toBeEnabled();
    expect(asked.at(-1)?.get('customerId')).toBe(customer.id);
    expect(asked.at(-1)?.get('status')).toBe('draft');
    expect(asked.at(-1)?.has('search')).toBe(false);
  });

  test('Add to order explains when the recipient has no draft order', async ({ page }) => {
    await mockDrafts(page, []);
    await page.goto(jobPath);
    await page.getByRole('button', { name: 'Add to order' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Add to order' }) });
    await expect(dialog.getByRole('radio', { name: 'New order' })).toBeChecked();
    await expect(
      dialog.getByText(`${customer.displayName} has no draft order. A new draft order will be created.`),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create order' })).toBeEnabled();
  });

  test('a job with nothing to bill is not offered for an order', async ({ page, world }) => {
    const job = world.jobs.find((entry) => entry.id === ids.jobSuccess)!;
    Object.assign(job, { effectivePrice: '0.00', nothingToBill: true });
    await page.goto(jobPath);
    await expect(page.getByText('Nothing to bill').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to order' })).toHaveCount(0);
  });
});
