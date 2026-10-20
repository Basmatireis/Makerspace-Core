import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getExternalInvoiceRequest,
  listExternalInvoiceRequests,
} from '../../api/generated/external-invoicing/external-invoicing';
import { listMachineLogbookWorkItems } from '../../api/generated/machine-logbook/machine-logbook';
import { getOrder, listOrders } from '../../api/generated/orders/orders';
import {
  getCashRegister,
  getOrderPayment,
  listCashMovements,
  listOrderPayments,
} from '../../api/generated/payments/payments';
import { listRolePricingGroups } from '../../api/generated/pricing/pricing';
import type { WorkItem } from '../../api/generated/models';
import { machineLogbookKeys } from '../machinelogbook/queries';
import { financeKeys } from './operations';

const PAGE = 100;

/** Loads every page of a paged endpoint. A single makerspace has few enough orders and payments for the client to filter and sort them. */
export async function fetchAllPages<T>(load: (page: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
  const first = await load(1);
  const items = [...first.items];
  for (let page = 2; items.length < first.total && page <= Math.ceil(first.total / PAGE); page += 1)
    items.push(...(await load(page)).items);
  return items;
}

export const allOrdersQuery = () =>
  queryOptions({
    queryKey: [...financeKeys, 'all'],
    queryFn: () => fetchAllPages((page) => listOrders({ page, pageSize: PAGE })),
  });
export const orderQuery = (id: string) =>
  queryOptions({ queryKey: [...financeKeys, 'detail', id], queryFn: () => getOrder(id) });
export const paymentQuery = (id: string) =>
  queryOptions({ queryKey: [...financeKeys, 'payment', id], queryFn: () => getOrderPayment(id) });
export const requestQuery = (id: string) =>
  queryOptions({ queryKey: [...financeKeys, 'request', id], queryFn: () => getExternalInvoiceRequest(id) });
/** Every invoice request of an order, latest first, cancelled ones included. */
export const orderRequestsQuery = (orderId: string) =>
  queryOptions({
    queryKey: [...financeKeys, 'requests-of', orderId],
    queryFn: () => fetchAllPages((page) => listExternalInvoiceRequests({ orderId, page, pageSize: PAGE })),
  });

/** Payments that occurred in [from, to). */
export const periodPaymentsQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: [...financeKeys, 'period-payments', from, to],
    queryFn: () => fetchAllPages((page) => listOrderPayments({ from, to, page, pageSize: PAGE })),
  });
/** Payments from an instant on, newest data included: used to find the reversal of a receipt. */
export const paymentsSinceQuery = (from: string) =>
  queryOptions({
    queryKey: [...financeKeys, 'payments-since', from],
    queryFn: () => fetchAllPages((page) => listOrderPayments({ from, page, pageSize: PAGE })),
  });
export const periodMovementsQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: [...financeKeys, 'period-movements', from, to],
    queryFn: () => fetchAllPages((page) => listCashMovements({ from, to, page, pageSize: PAGE })),
  });
/** Expected cash up to (excluding) `to`; without it up to now. */
export const cashRegisterQuery = (to?: string) =>
  queryOptions({
    queryKey: [...financeKeys, 'cash-register', to ?? 'now'],
    queryFn: () => getCashRegister(to ? { to } : undefined),
  });

export const rolePricingQuery = () =>
  queryOptions({ queryKey: [...machineLogbookKeys.pricing(), 'role-groups'], queryFn: () => listRolePricingGroups() });

/** Finished jobs that are on no order (billing state "not on order"). Jobs only; runs are not billable on their own. */
export const readyToBillQuery = () =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'ready-to-bill'],
    queryFn: async (): Promise<WorkItem[]> =>
      (
        await fetchAllPages((page) => listMachineLogbookWorkItems({ billing: ['not_on_order'], page, pageSize: PAGE }))
      ).filter((item) => item.kind === 'job'),
  });

/** A mutation of the finance area: afterwards every order, payment and job list is refreshed. */
export function useFinanceMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  onSuccess?: (result: TResult, variables: TVariables) => void | Promise<void>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: financeKeys }),
        client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
      ]);
      await onSuccess?.(result, variables);
    },
  });
}
