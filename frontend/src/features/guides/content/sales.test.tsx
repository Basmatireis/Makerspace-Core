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
      expect(guide.steps.length).toBeLessThanOrEqual(14);
    }
    expect(salesGuides[2].requires(currentUserFixture(['payments.read', 'orders.read']))).toBe(false);
    expect(salesGuides[1].requires(currentUserFixture(['orders.read']))).toBe(false);
  });

  it('tour: only the first step jumps to a route and permissions skip unreachable pages', () => {
    const steps = salesGuides[0].steps;
    expect(steps[0].route).toBe('/orders');
    expect(steps.slice(1).filter((step) => step.route)).toEqual([]);
    const ids = (permissions: PermissionId[]) =>
      steps.filter((step) => step.requires?.(currentUserFixture(permissions)) ?? true).map((step) => step.id);
    expect(ids(['payments.read'])).toEqual(['nav-payments', 'payments']);
    expect(ids(['pricing.read'])).toEqual(['nav-pricing', 'pricing-tabs', 'pricing-lookup']);
    expect(ids(['orders.read'])).not.toContain('nav-payments');
  });

  it('tour: follows the pages through orders, payments and pricing', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('sales-tour', id);
    const click = async (id: string) => user.click(await target(step(id)));
    await start('/orders');
    for (const id of ['orders-tabs', 'orders-review', 'orders-new']) await target(step(id));
    await click('order-row');
    // A wide screen opens a panel with the link; a narrow one has already gone to the order.
    await waitFor(() => expect(found(step('order-open')) ?? found(step('order-facts'))).not.toBeNull());
    if (found(step('order-open'))) await click('order-open');
    await target(step('order-facts'));
    await target(step('order-primary'));
    await click('nav-payments');
    await target(step('payments'));
    await click('nav-pricing');
    await target(step('pricing-tabs'));
    await target(step('pricing-lookup'));
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
    const reasonStep = salesGuides[2].steps.find((item) => item.id === 'reason')!.advance;
    if (reasonStep?.kind !== 'when') throw new Error('The reason step advances by a check');
    expect(reasonStep.check()).toBe(false);
    await user.type(reason.querySelector('textarea')!, 'Customer returned it');
    expect(reasonStep.check()).toBe(true);
    const submit = await target(step('submit'));
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('This payment was reversed')).toBeInTheDocument();
    await target(step('reversed'));
  });
});
