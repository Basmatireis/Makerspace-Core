import { http, HttpResponse } from 'msw';
import { PermissionId, type ExternalInvoiceRequest, type Order, type OrderPayment } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { server } from '../../test/server';

export const at = '2026-10-06T10:00:00Z';
export const ids = {
  order: '01995ea6-6d00-7000-8000-000000000101', other: '01995ea6-6d00-7000-8000-000000000102', item: '01995ea6-6d00-7000-8000-000000000103',
  request: '01995ea6-6d00-7000-8000-000000000104', customer: '01995ea6-6d00-7000-8000-000000000105', payment: '01995ea6-6d00-7000-8000-000000000106',
};
export const everything = [
  PermissionId.ordersread, PermissionId.orderswrite, PermissionId.ordersfinalize, PermissionId.ordersreverse, PermissionId.paymentsread, PermissionId.paymentsrecord, PermissionId.paymentsreverse,
  PermissionId.external_invoice_requestsread, PermissionId.external_invoice_requestsmanage, PermissionId.cash_movementsread, PermissionId.cash_movementsrecord, PermissionId.machine_jobsread,
];

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ids.order, createdBy: { id: ids.customer, displayName: 'Sara Kofler' }, reference: 'O-2026-000001', status: 'draft', currency: 'EUR', customerKind: 'organization',
    customer: { kind: 'organization', id: ids.customer }, customerName: 'Example institute', fulfillmentMode: 'immediate', totalAmount: '10.00', netCharge: '10.00', settledAmount: '0.00', outstandingAmount: '10.00',
    settlementState: 'unpaid', replacesOrderId: null, replacesOrderReference: null, replacedByOrderId: null, replacedByOrderReference: null, activeExternalRequestId: null, activeExternalRequestReference: null,
    activeExternalRequestState: null,
    items: [{ id: ids.item, position: 1, kind: 'manual', description: 'Machine service', quantity: '1', unit: 'service', unitPrice: '10', amount: '10.00', sourceChanged: false, createdAt: at }],
    allocations: [], adjustments: [], version: 2, createdAt: at, updatedAt: at, ...overrides,
  };
}

export const finalized = (overrides: Partial<Order> = {}) => order({ status: 'finalized', ...overrides });
export const paid = (overrides: Partial<Order> = {}) => order({ status: 'finalized', settlementState: 'paid', settledAmount: '10.00', outstandingAmount: '0.00', ...overrides });

export function invoiceRequest(overrides: Partial<ExternalInvoiceRequest> = {}): ExternalInvoiceRequest {
  return {
    id: ids.request, reference: 'W-2026-000001', orderId: ids.order, orderReference: 'O-2026-000001', provider: 'wiref', state: 'submitted', currency: 'EUR', requestedAmount: '10.00', alreadyPaid: '0.00',
    details: { recipientName: 'Example institute', addressLine1: 'Street 1', postalCode: '1010', locality: 'Wien', countryCode: 'AT', contactName: 'Ada', serviceStartsOn: '2026-10-01', serviceEndsOn: '2026-10-05', serviceDescription: 'Machine services' },
    requirePurchaseOrderReference: false, requirementsVersion: 1, itemSummary: [], events: [], supersedesRequestId: null, version: 3, createdAt: at, ...overrides,
  };
}

export function receipt(overrides: Partial<OrderPayment> = {}): OrderPayment {
  return {
    id: ids.payment, reference: 'P-2026-000001', entryKind: 'receipt', method: 'cash', amount: '10.00', occurredAt: new Date().toISOString(), recordedAt: at, reversesPaymentId: null, reversedPaymentReference: null,
    reasonKind: null, reason: '', externalSource: '', externalReference: '', allocations: [], recordedBy: { id: ids.customer, displayName: 'Sara Kofler' }, ...overrides,
  };
}

export const as = (permissions: PermissionId[]) => server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))));
export const orderList = (items: Order[]) => server.use(http.get('*/api/v1/orders', () => HttpResponse.json({ items, page: 1, pageSize: 100, total: items.length })));
