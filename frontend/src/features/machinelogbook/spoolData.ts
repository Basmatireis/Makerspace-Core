import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/http-client';
import { listFilamentSpoolTransactions, listFilamentSpools } from '../../api/generated/filament-spools/filament-spools';
import { listMaterials } from '../../api/generated/inventory/inventory';
import type { FilamentSpool, ListFilamentSpoolsParams, UpdateFilamentSpoolRequest } from '../../api/generated/models';
import { isFilament } from './components/inventoryShared';
import { machineLogbookKeys } from './queries';

const PAGE_SIZE = 100;

/** Loads every page of a list endpoint; spool and ledger lists are small enough to sort and filter in the table. */
export async function fetchAllPages<T>(load: (page: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await load(page);
    items.push(...result.items);
    if (result.items.length === 0 || items.length >= result.total) return items;
  }
}

export type SpoolListFilter = Omit<ListFilamentSpoolsParams, 'page' | 'pageSize'>;

/** All spools matching the server-side filters (the table filters the rest). */
export const allSpoolsQuery = (filter: SpoolListFilter) =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'spools-all', filter] as const,
    queryFn: ({ signal }) =>
      fetchAllPages((page) => listFilamentSpools({ ...filter, page, pageSize: PAGE_SIZE }, { signal })),
  });

/** The complete ledger of one spool. */
export const allSpoolTransactionsQuery = (spoolId: string) =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'spool-transactions-all', spoolId] as const,
    queryFn: ({ signal }) =>
      fetchAllPages((page) => listFilamentSpoolTransactions(spoolId, { page, pageSize: PAGE_SIZE }, { signal })),
  });

/** Filament materials with their stock split (quantity, assigned to spools, loose) and inventory version. */
export const filamentMaterialsQuery = () =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'filament-materials'] as const,
    queryFn: async ({ signal }) =>
      (
        await fetchAllPages((page) => listMaterials({ kind: 'filament', page, pageSize: PAGE_SIZE }, { signal }))
      ).filter(isFilament),
  });

/**
 * Body for updateFilamentSpool. The backend takes the whole descriptive record (an omitted or null field is cleared),
 * so a change starts from the spool as loaded and overrides only what it changes.
 */
export const spoolUpdateBody = (
  spool: FilamentSpool,
  changes: Partial<UpdateFilamentSpoolRequest> = {},
): UpdateFilamentSpoolRequest => ({
  tareWeightG: spool.tareWeightG ?? null,
  acquiredOn: spool.acquiredOn ?? null,
  acquisitionReference: spool.acquisitionReference ?? null,
  storageLocation: spool.storageLocation ?? null,
  notes: spool.notes ?? null,
  expectedVersion: spool.version,
  ...changes,
});

/** Refreshes every Machines & Jobs query after a mutation: spools, materials, ledger and counts depend on each other. */
export function useRefreshInventory() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
}

// Errors ------------------------------------------------------------------------

const messages: Record<string, string> = {
  insufficient_loose_stock: 'There is not enough loose stock for this. Check the available amount and try again.',
  insufficient_unassigned_stock: 'There is not enough loose stock for this. Check the available amount and try again.',
  material_name_conflict: 'An article with this name already exists.',
  material_not_filament: 'Only filament articles can be put on spools.',
  material_in_bin: 'This article is in the recycle bin. Restore it first.',
  insufficient_stock: 'There is not enough stock for this.',
  identifier_in_use: 'One of these identifiers is already assigned to a spool.',
  spool_archived: 'This spool is retired. Restore it from the recycle bin first.',
  spool_not_consumable: 'This spool is retired and cannot be booked on.',
  insufficient_spool_stock: 'The spool does not hold that much filament.',
  slot_occupied: 'Another spool is mounted in this slot. Unmount it first.',
  stale_write: 'Someone changed this in the meantime. The latest data was reloaded; check it and try again.',
};

export const errorCode = (error: unknown) =>
  error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;

/** Plain-language text for a failed spool request, keyed by the backend error code. */
export function spoolErrorMessage(error: unknown, fallback = 'The change could not be saved. Try again.') {
  const code = errorCode(error);
  if (code && messages[code]) return messages[code];
  if (error instanceof ApiError && error.status === 403) return 'Your role does not allow this change.';
  if (error instanceof ApiError && error.status === 422 && error.message) return error.message;
  return fallback;
}
