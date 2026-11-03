import { queryOptions } from '@tanstack/react-query';
import { listMaterials, listMaterialTypes } from '../../api/generated/inventory/inventory';
import { listPrinterErrorCodes } from '../../api/generated/printing/printing';
import type { ListPrinterErrorCodesParams, PrinterErrorCode } from '../../api/generated/models';
import { machineLogbookKeys } from './queries';

// Queries of the Machines pages that the shared query module does not have.

const PAGE_SIZE = 100;
// A bound on paging through a list in the browser, far above what one makerspace has.
const MAX_PAGES = 50;

async function allPages<T>(load: (page: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await load(page);
    items.push(...result.items);
    if (result.items.length === 0 || items.length >= result.total) break;
  }
  return items;
}

export const machinesQueryKeys = {
  allErrorCodes: (params: Omit<ListPrinterErrorCodesParams, 'page' | 'pageSize'>) =>
    [...machineLogbookKeys.all, 'printer-error-codes', 'all', params] as const,
  materialTypes: () => [...machineLogbookKeys.all, 'machines', 'material-types'] as const,
  filamentArticles: () => [...machineLogbookKeys.all, 'machines', 'filament-articles'] as const,
};

/**
 * Every catalog entry matching search, family and source. The component of a code is read from the code itself, which
 * the server cannot filter by, so the catalog filtered by component is loaded whole and paged in the browser.
 */
export const allPrinterErrorCodesQuery = (params: Omit<ListPrinterErrorCodesParams, 'page' | 'pageSize'>) =>
  queryOptions({
    queryKey: machinesQueryKeys.allErrorCodes(params),
    queryFn: ({ signal }): Promise<PrinterErrorCode[]> =>
      allPages((page) => listPrinterErrorCodes({ ...params, page, pageSize: PAGE_SIZE }, { signal })),
  });

/** Material types, for the material categories a machine's process can consume. */
export const machineMaterialTypesQuery = () =>
  queryOptions({
    queryKey: machinesQueryKeys.materialTypes(),
    queryFn: ({ signal }) => listMaterialTypes({ signal }),
  });

/** Active filament articles, for registering a spool the printer reports. */
export const filamentArticlesQuery = () =>
  queryOptions({
    queryKey: machinesQueryKeys.filamentArticles(),
    queryFn: async ({ signal }) =>
      (await allPages((page) => listMaterials({ kind: 'filament', page, pageSize: PAGE_SIZE }, { signal }))).filter(
        (material) => material.active,
      ),
  });
