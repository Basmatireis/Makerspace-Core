import { queryOptions } from '@tanstack/react-query';
import { listFilamentSpools } from '../../api/generated/filament-spools/filament-spools';
import {
  listInventorySuggestions,
  listMaterials,
  listMaterialTransactions,
  listMaterialTypes,
} from '../../api/generated/inventory/inventory';
import { machineLogbookKeys } from './queries';

const PAGE_SIZE = 100;

/** Loads every page of a paged list. The inventory tables sort, filter and page on the client. */
async function fetchAll<T>(load: (page: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await load(page);
    items.push(...result.items);
    if (result.items.length === 0 || items.length >= result.total) return items;
  }
}

// All keys live under `machineLogbookKeys.all`, so every inventory mutation invalidates them together.
const key = (...parts: (string | number)[]) => [...machineLogbookKeys.all, ...parts] as const;

/** Every material type, active ones first. */
export const materialTypesQuery = () =>
  queryOptions({
    queryKey: key('material-types'),
    queryFn: ({ signal }) => listMaterialTypes({ signal }),
    select: (data) => data.items,
  });

/** Every article, active and inactive, with the total inventory value of the whole inventory. */
export const allMaterialsQuery = () =>
  queryOptions({
    queryKey: key('materials', 'all'),
    queryFn: async () => {
      let totalInventoryValue = '0';
      const items = await fetchAll(async (page) => {
        const result = await listMaterials({ page, pageSize: PAGE_SIZE });
        totalInventoryValue = result.totalInventoryValue;
        return result;
      });
      return { items, totalInventoryValue };
    },
  });

/** Suggestions for variants (of one type), manufacturers, suppliers and storage locations from earlier entries. */
export const suggestionsQuery = (materialTypeId?: string) =>
  queryOptions({
    queryKey: key('suggestions', materialTypeId ?? 'all'),
    queryFn: ({ signal }) => listInventorySuggestions(materialTypeId ? { materialTypeId } : undefined, { signal }),
    staleTime: 60_000,
  });

/** The whole ledger of one material, newest handling happens in the table. */
export const allTransactionsQuery = (materialId: string) =>
  queryOptions({
    queryKey: key('transactions', materialId, 'all'),
    queryFn: () => fetchAll((page) => listMaterialTransactions(materialId, { page, pageSize: PAGE_SIZE })),
  });

/** Loaded or active spools (not archived, not waiting for a refill) per material ID. */
export const activeSpoolCountsQuery = () =>
  queryOptions({
    queryKey: key('spools', 'active-counts'),
    queryFn: async () => {
      const spools = await fetchAll((page) =>
        listFilamentSpools({ status: ['loaded', 'active'], page, pageSize: PAGE_SIZE }),
      );
      const counts: Record<string, number> = {};
      for (const spool of spools) if (spool.materialId) counts[spool.materialId] = (counts[spool.materialId] ?? 0) + 1;
      return counts;
    },
  });
