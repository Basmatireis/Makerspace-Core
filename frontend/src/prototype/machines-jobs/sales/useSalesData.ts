import { useMemo } from 'react';
import { useSimulatedQuery } from '../store';
import type { Job, Machine, Print } from '../types';
import { buildOrderViews, type OrderView } from './logic';
import type { Allocation, CashMovement, InvoiceRequest, Order, OrderAdjustment, Payment } from './types';

type SalesData = { orders: Order[]; payments: Payment[]; allocations: Allocation[]; adjustments: OrderAdjustment[]; requests: InvoiceRequest[]; cashMovements: CashMovement[]; jobs: Job[]; prints: Print[]; machines: Machine[] };
const EMPTY: SalesData = { orders: [], payments: [], allocations: [], adjustments: [], requests: [], cashMovements: [], jobs: [], prints: [], machines: [] };

/** One simulated read of everything the sales screens derive from, plus the order views (totals, status inputs). Honors the loading/error/empty scenarios. */
export function useSalesData() {
  const query = useSimulatedQuery<SalesData>((d) => ({ orders: d.orders, payments: d.payments, allocations: d.allocations, adjustments: d.adjustments, requests: d.requests, cashMovements: d.cashMovements, jobs: d.jobs, prints: d.prints, machines: d.machines }), EMPTY);
  const { orders, allocations, adjustments, requests } = query.data;
  const views: OrderView[] = useMemo(() => buildOrderViews({ orders, allocations, adjustments, requests }), [orders, allocations, adjustments, requests]);
  return { query, data: query.data, views };
}
