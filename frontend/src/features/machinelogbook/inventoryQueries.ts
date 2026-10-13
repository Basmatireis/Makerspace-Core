import { queryOptions } from '@tanstack/react-query';
import { listFilamentProducts } from '../../api/generated/filament-products/filament-products';
import { listFilamentSpools } from '../../api/generated/filament-spools/filament-spools';
import { listMaterials, listMaterialTransactions } from '../../api/generated/inventory/inventory';
import { machineLogbookKeys } from './queries';

const PAGE_SIZE = 100;

/** Loads every page of a paged list. The inventory tables sort, filter and page on the client, as in the prototype. */
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

/** Every material, active and inactive. */
export const allMaterialsQuery = () => queryOptions({
  queryKey: key('materials', 'all'),
  queryFn: () => fetchAll((page) => listMaterials({ page, pageSize: PAGE_SIZE })),
});

/** Every filament product, active and inactive. */
export const allProductsQuery = () => queryOptions({
  queryKey: key('products', 'all'),
  queryFn: () => fetchAll((page) => listFilamentProducts({ includeInactive: true, page, pageSize: PAGE_SIZE })),
});

/** The whole ledger of one material, newest handling happens in the table. */
export const allTransactionsQuery = (materialId: string) => queryOptions({
  queryKey: key('transactions', materialId, 'all'),
  queryFn: () => fetchAll((page) => listMaterialTransactions(materialId, { page, pageSize: PAGE_SIZE })),
});

/** Loaded or active spools (not archived, not waiting for a refill) per material ID. */
export const activeSpoolCountsQuery = () => queryOptions({
  queryKey: key('spools', 'active-counts'),
  queryFn: async () => {
    const spools = await fetchAll((page) => listFilamentSpools({ status: ['loaded', 'active'], page, pageSize: PAGE_SIZE }));
    const counts: Record<string, number> = {};
    for (const spool of spools) if (spool.materialId) counts[spool.materialId] = (counts[spool.materialId] ?? 0) + 1;
    return counts;
  },
});
