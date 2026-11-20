import { queryOptions } from '@tanstack/react-query';
import type {
  GetWorkingGroupBudgetParams,
  ListWorkingGroupBookingsParams,
  ListWorkingGroupPurchasesParams,
} from '../../api/generated/models';
import {
  getWorkingGroupBudget,
  getWorkingGroupFinanceRules,
  listWorkingGroupBookings,
  listWorkingGroupBudgetPeriods,
  listWorkingGroupPurchaseOrders,
  listWorkingGroupPurchases,
} from '../../api/generated/working-groups/working-groups';
import { workingGroupKeys } from './queries';

// All of these sit under the working-group key, so every working-group mutation reads them again.
const base = [...workingGroupKeys.all, 'finance'] as const;

export const budgetPeriodsOptions = queryOptions({
  queryKey: [...base, 'periods'] as const,
  queryFn: ({ signal }) => listWorkingGroupBudgetPeriods({ signal }),
});

export const budgetOptions = (params: GetWorkingGroupBudgetParams) =>
  queryOptions({
    queryKey: [...base, 'budget', params.periodId ?? 'current'] as const,
    queryFn: ({ signal }) => getWorkingGroupBudget(params, { signal }),
  });

export const purchasesOptions = (params: ListWorkingGroupPurchasesParams) =>
  queryOptions({
    queryKey: [
      ...base,
      'purchases',
      params.groupId ?? 'all',
      params.periodId ?? 'current',
      params.status ?? 'any',
    ] as const,
    queryFn: ({ signal }) => listWorkingGroupPurchases(params, { signal }),
  });

export const bookingsOptions = (params: ListWorkingGroupBookingsParams) =>
  queryOptions({
    queryKey: [...base, 'bookings', params.groupId ?? 'all', params.periodId ?? 'current'] as const,
    queryFn: ({ signal }) => listWorkingGroupBookings(params, { signal }),
  });

export const purchaseOrdersOptions = queryOptions({
  queryKey: [...base, 'orders'] as const,
  queryFn: ({ signal }) => listWorkingGroupPurchaseOrders({ signal }),
});

export const financeRulesOptions = queryOptions({
  queryKey: [...base, 'rules'] as const,
  queryFn: ({ signal }) => getWorkingGroupFinanceRules({ signal }),
});
