import { queryOptions } from '@tanstack/react-query';
import type { WorkingGroupIncome } from '../../api/generated/models';
import { listWorkingGroupIncome } from '../../api/generated/working-groups/working-groups';
import { toCents } from './money';
import { financeKeys } from './operations';

/** The income of the current budget period (finance managers only). Cash entries are the ones booked ahead. */
export const budgetIncomeQuery = () =>
  queryOptions({
    queryKey: [...financeKeys, 'budget-income'],
    queryFn: ({ signal }) => listWorkingGroupIncome(undefined, { signal }),
  });

/** What is booked ahead to the budget and still in the register, oldest first. */
export const bookedAheadEntries = (items: readonly WorkingGroupIncome[] | undefined): WorkingGroupIncome[] =>
  (items ?? []).filter((entry) => entry.where === 'cash').sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const sumCents = (entries: readonly WorkingGroupIncome[]) =>
  entries.reduce((sum, entry) => sum + toCents(entry.amount), 0);
