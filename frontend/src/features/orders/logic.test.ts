import { describe, expect, it } from 'vitest';
import type { ExternalInvoiceRequest, Order } from '../../api/generated/models';
import { fromCents, parseMoneyInput, toCents } from './money';
import {
  acceptsCashAndCard,
  invoiceKey,
  invoiceRequestBlocker,
  latestReturn,
  periodRange,
  periodText,
  readyToBillGroups,
  requestProgress,
  requestReadiness,
  reversalOptions,
  sectionOf,
  takings,
  wiRefCopyText,
} from './logic';

const request = (state: ExternalInvoiceRequest['state'], events: Array<{ kind: string; reason?: string }> = []) =>
  ({
    state,
    events: events.map((event, index) => ({
      id: String(index),
      kind: event.kind,
      reason: event.reason ?? '',
      externalReference: '',
      reconciliationKind: '',
      effectiveAt: '',
      recordedAt: '2026-10-19T10:00:00Z',
      recordedBy: null,
    })),
  }) as unknown as ExternalInvoiceRequest;

describe('money', () => {
  it('works in exact cents', () => {
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('-0.05')).toBe(-5);
    expect(fromCents(-5)).toBe('-0.05');
    expect(parseMoneyInput('12,5')).toBe(1250);
    expect(parseMoneyInput('1.234,50')).toBeNull();
    expect(parseMoneyInput('12.3456')).toBeNull();
  });
});

describe('order sections', () => {
  it('puts paid, closed and everything else in their sections', () => {
    expect(sectionOf({ status: 'finalized', settlementState: 'paid' })).toBe('paid');
    expect(sectionOf({ status: 'finalized', settlementState: 'no_payment_due' })).toBe('paid');
    expect(sectionOf({ status: 'reversed', settlementState: 'no_payment_due' })).toBe('cancelled');
    expect(sectionOf({ status: 'cancelled', settlementState: 'unpaid' })).toBe('cancelled');
    expect(sectionOf({ status: 'draft', settlementState: 'unpaid' })).toBe('open');
    expect(sectionOf({ status: 'finalized', settlementState: 'partially_paid' })).toBe('open');
  });
  it('maps the active request to the invoice filter and the accepted payment methods', () => {
    expect(invoiceKey({ activeExternalRequestState: null, latestExternalRequestState: null })).toBe('none');
    expect(
      invoiceKey({
        activeExternalRequestState: 'cancellation_requested',
        latestExternalRequestState: 'cancellation_requested',
      }),
    ).toBe('issued');
    expect(invoiceKey({ activeExternalRequestState: null, latestExternalRequestState: 'cancelled' })).toBe('cancelled');
    expect(invoiceKey({ activeExternalRequestState: 'draft', latestExternalRequestState: 'draft' })).toBe('draft');
    expect(acceptsCashAndCard({ activeExternalRequestState: 'draft' })).toBe(true);
    expect(acceptsCashAndCard({ activeExternalRequestState: 'submitted' })).toBe(false);
    expect(acceptsCashAndCard({ activeExternalRequestState: null })).toBe(true);
  });
  it('explains why no invoice can be requested', () => {
    const order = {
      status: 'finalized',
      customerKind: 'person',
      totalAmount: '10.00',
      activeExternalRequestId: null,
      activeExternalRequestReference: null,
    } as const;
    expect(invoiceRequestBlocker(order)).toBeNull();
    expect(invoiceRequestBlocker({ ...order, totalAmount: '0.00' })).toMatch(/nothing is charged/i);
    expect(invoiceRequestBlocker({ ...order, status: 'draft' })).toMatch(/not finalized/i);
    expect(
      invoiceRequestBlocker({ ...order, activeExternalRequestId: 'x', activeExternalRequestReference: 'W-1' }),
    ).toMatch(/already active/);
  });
});

describe('period', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  it('computes today, yesterday, the week and the month in Vienna time', () => {
    const today = periodRange('today', '', '', now);
    expect(new Date(today.to).getTime() - new Date(today.from).getTime()).toBe(86_400_000);
    expect(periodText('today', today, '', '')).toBe('Today · 19.10.2026');
    expect(periodRange('yesterday', '', '', now).to).toBe(today.from);
    const week = periodRange('week', '', '', now);
    expect(new Date(week.from).toISOString()).toBe('2026-10-18T22:00:00.000Z');
    const month = periodRange('month', '', '', now);
    expect(new Date(month.from).toISOString()).toBe('2026-09-30T22:00:00.000Z');
  });
  it('treats a custom range as inclusive days and needs both dates', () => {
    const range = periodRange('custom', '2026-10-01', '2026-10-05');
    expect(range.valid).toBe(true);
    expect(new Date(range.to).getTime() - new Date(range.from).getTime()).toBe(5 * 86_400_000);
    expect(periodRange('custom', '2026-10-05', '').valid).toBe(false);
    expect(periodRange('custom', '2026-10-06', '2026-10-05').valid).toBe(false);
  });
  it('nets takings per method', () => {
    const result = takings([
      { entryKind: 'receipt', method: 'cash', amount: '10.00' },
      { entryKind: 'reversal', method: 'cash', amount: '4.00' },
      { entryKind: 'receipt', method: 'card', amount: '2.50' },
      { entryKind: 'receipt', method: 'external', amount: '5.00' },
    ]);
    expect(result).toEqual({ cash: 600, card: 250, external: 500, total: 1350 });
  });
});

describe('invoice workflow helpers', () => {
  it('requires purchase order and contact for organizations only', () => {
    const complete = {
      recipientName: 'X',
      addressLine1: 'Street 1',
      postalCode: '1010',
      locality: 'Wien',
      countryCode: 'AT',
      serviceStartsOn: '2026-10-01',
      serviceEndsOn: '2026-10-02',
      serviceDescription: 'Service',
    };
    expect(requestReadiness(complete, 'person', false).every((item) => item.ok)).toBe(true);
    const organization = requestReadiness(complete, 'organization', true)
      .filter((item) => !item.ok)
      .map((item) => item.key);
    expect(organization).toEqual(['contact', 'po']);
    expect(
      requestReadiness({ ...complete, serviceEndsOn: '2026-09-01' }, 'person', false).find(
        (item) => item.key === 'period',
      )?.ok,
    ).toBe(false);
  });
  it('shows the progress and the return comment until it is submitted again', () => {
    expect(requestProgress(request('draft'))).toEqual({ index: 0, invalid: false });
    expect(requestProgress(request('submitted'))).toEqual({ index: 1, invalid: false });
    expect(requestProgress(request('issued')).index).toBe(3);
    expect(requestProgress(request('cancelled', [{ kind: 'submitted' }, { kind: 'issued' }]))).toEqual({
      index: 2,
      invalid: true,
    });
    expect(
      latestReturn(request('draft', [{ kind: 'submitted' }, { kind: 'returned', reason: 'Fix the address' }]))?.reason,
    ).toBe('Fix the address');
    expect(latestReturn(request('draft', [{ kind: 'returned', reason: 'old' }, { kind: 'submitted' }]))).toBeNull();
    expect(latestReturn(request('submitted', [{ kind: 'returned', reason: 'old' }]))).toBeNull();
  });
  it('formats the wiRef copy text with what is still to pay', () => {
    const text = wiRefCopyText({
      reference: 'W-2026-000001',
      orderReference: 'O-2026-000001',
      requestedAmount: '100.00',
      alreadyPaid: '30.00',
      details: {
        recipientName: 'Institute',
        addressLine1: 'Street 1',
        postalCode: '1010',
        locality: 'Wien',
        countryCode: 'at',
        serviceStartsOn: '2026-10-01',
        serviceEndsOn: '2026-10-02',
        serviceDescription: 'Machines',
      },
      itemSummary: [{ description: 'Laser', quantity: '1', unit: 'job', unitPrice: '100.00', amount: '100.00' }],
    } as unknown as ExternalInvoiceRequest);
    expect(text).toContain('Recipient: Institute');
    expect(text).toContain('Country: AT');
    expect(text).toContain('Still to pay (by bank transfer to HTU): €70.00');
    expect(text).toContain('1. Laser');
  });
});

describe('refund options', () => {
  const order = {
    id: 'o',
    reference: 'O-1',
    status: 'finalized',
    customerKind: 'person',
    activeExternalRequestState: null,
    activeExternalRequestReference: null,
  } as unknown as Order;
  const receipt = (method: string) =>
    ({ entryKind: 'receipt', method, allocations: [{ orderId: 'o', amount: '10.00' }] }) as never;
  it('offers refund and correction for cash, and only the external correction for invoice payments', () => {
    expect(reversalOptions(receipt('cash'), undefined, order).kinds).toEqual(['refund', 'recording_error']);
    expect(reversalOptions(receipt('external'), undefined, order).kinds).toEqual(['external_correction']);
  });
  it('blocks what the backend would refuse', () => {
    expect(
      reversalOptions(receipt('cash'), undefined, {
        ...order,
        activeExternalRequestState: 'submitted',
        activeExternalRequestReference: 'W-1',
      } as Order).prerequisite,
    ).toMatch(/cancelled first/);
    expect(reversalOptions(receipt('cash'), { reference: 'P-2' } as never, order).blocker).toMatch(/already reversed/);
    expect(reversalOptions(receipt('cash'), undefined, { ...order, status: 'reversed' } as Order).blocker).toMatch(
      /reversed/,
    );
    expect(reversalOptions({ entryKind: 'reversal' } as never, undefined, order).blocker).toMatch(/itself a reversal/);
  });
});

describe('ready to bill', () => {
  const job = (id: string, customer: string | null, price: string | null) =>
    ({
      id,
      displayId: id,
      kind: 'job',
      version: 1,
      startedAt: '2026-10-01T10:00:00Z',
      endsAt: '2026-10-01T11:00:00Z',
      effectivePrice: price,
      customer: customer ? { kind: 'person', id: customer, displayName: customer } : null,
    }) as never;
  it('groups jobs per customer and keeps unbillable ones visible with a reason', () => {
    const groups = readyToBillGroups([
      job('J1', 'ada', '10.00'),
      job('J2', 'ada', '5.50'),
      job('J3', 'bob', null),
      job('J4', null, '1.00'),
    ]);
    const ada = groups.find((group) => group.key === 'ada')!;
    expect(ada.ready).toHaveLength(2);
    expect(ada.total).toBe(1550);
    expect(groups.find((group) => group.key === 'bob')!.rows[0].reason).toMatch(/price/);
    expect(groups.find((group) => group.key === 'none')!.ready).toHaveLength(0);
  });
});
