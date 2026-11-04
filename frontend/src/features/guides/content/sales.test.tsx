import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionId } from '../../../api/generated/models';
import { App } from '../../../app/App';
import { queryClient } from '../../../api/query-client';
import { renderRoute } from '../../../test/render';
import { currentUserFixture } from '../../../test/fixtures';
import { enterDemoMode, exitDemoMode } from '../../demo/demoMode';
import { demoPermissions, demoTestUser } from '../../demo/demoTestUser';
import { DEMO_IDS } from '../../demo/fake/ids';
import { salesGuides } from './sales';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

afterEach(async () => {
  await exitDemoMode();
  queryClient.clear();
});

const everything = [...demoPermissions, 'payments.reverse', 'cash_movements.read'] as PermissionId[];
const found = (selector: string) => document.querySelector(selector);
const target = async (selector: string) => {
  await waitFor(() => expect(found(selector), selector).not.toBeNull(), { timeout: 4000 });
  return found(selector) as HTMLElement;
};
const stepTarget = (guideId: string, stepId: string) =>
  salesGuides.find((guide) => guide.id === guideId)!.steps.find((step) => step.id === stepId)!.target!;

async function start(route: string) {
  await enterDemoMode(demoTestUser(everything));
  renderRoute(<App />, route);
}

describe('sales guides', () => {
  it('have unique ids and are hidden from people without sales permissions', () => {
    const ids = salesGuides.map((guide) => guide.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nobody = currentUserFixture([]);
    for (const guide of salesGuides) {
      expect(guide.demo).toBe(true);
      expect(guide.area).toBe('sales');
      expect(guide.requires(nobody)).toBe(false);
      expect(guide.requires(currentUserFixture(everything))).toBe(true);
      expect(guide.steps.length).toBeGreaterThanOrEqual(5);
      expect(guide.steps.length).toBeLessThanOrEqual(10);
    }
    expect(salesGuides[2].requires(currentUserFixture(['payments.read', 'orders.read']))).toBe(false);
    expect(salesGuides[1].requires(currentUserFixture(['orders.read']))).toBe(false);
  });

  it('tour: every target exists on its page', async () => {
    await start('/orders');
    for (const id of ['orders-tabs', 'orders-review', 'orders-new']) {
      await target(`[data-guide="${id}"]`);
    }
    expect(stepTarget('sales-tour', 'orders-tabs')).toBe('[data-guide="orders-tabs"]');
  });

  it('tour: order detail targets exist', async () => {
    await start(`/orders/${DEMO_IDS.order}`);
    await target(stepTarget('sales-tour', 'order-facts'));
    await target(stepTarget('sales-tour', 'order-primary'));
  });

  it('tour: payments and pricing targets exist', async () => {
    await start('/payments');
    await target(stepTarget('sales-tour', 'payments'));
  });

  it('tour: pricing targets exist', async () => {
    await start('/pricing');
    await target(stepTarget('sales-tour', 'pricing-tabs'));
    await target(stepTarget('sales-tour', 'pricing-lookup'));
  });

  it('order payment: every step can be followed to a paid order', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('sales-order-payment', id);
    await start('/orders');
    await user.click(await target(step('review')));
    await user.click((await target(step('select'))).querySelector('input, label')!);
    const create = await target(step('create'));
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await user.click(await target(step('finalize')));
    await target(step('method'));
    await target(step('amount'));
    await target(step('covered'));
    await user.click(await target(step('submit')));
    await target(step('paid'));
    await target(step('receipt'));
  });

  it('reverse payment: every step can be followed to a reversed payment', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('sales-reverse-payment', id);
    await start('/payments?tab=cashbook');
    await target(step('cashbook'));
    const line = await target(step('open'));
    await user.click(line.querySelector('a')!);
    await target(step('history'));
    await user.click(await target(step('reverse')));
    await target(step('kind'));
    const reason = await target(step('reason'));
    await user.type(reason.querySelector('textarea')!, 'Customer returned it');
    const submit = await target(step('submit'));
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('This payment was reversed')).toBeInTheDocument();
    await target(step('reversed'));
  });
});
