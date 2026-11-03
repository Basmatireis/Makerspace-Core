/** Route builders for the Workshop area (jobs, machines, inventory) and Statistics, so links never hard-code path strings. */
const root = '/workshop';
const withQuery = (path: string, query?: Record<string, string | undefined>) => {
  const search = new URLSearchParams(
    Object.entries(query ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  return search ? `${path}?${search}` : path;
};
const segment = (id: string) => encodeURIComponent(id);

export type InventoryTab = 'articles' | 'spools' | 'types';
export type MachineTab = 'printer';

export const machineLogbookPaths = {
  /** Where the Workshop breadcrumb leads: the area has no page of its own, Jobs is its first page. */
  home: () => `${root}/jobs`,
  jobs: (query?: Record<string, string | undefined>) => withQuery(`${root}/jobs`, query),
  job: (id: string) => `${root}/jobs/${segment(id)}`,
  run: (id: string) => `${root}/jobs/runs/${segment(id)}`,
  recycleBin: () => withQuery(`${root}/jobs`, { tab: 'bin' }),
  machines: () => `${root}/machines`,
  machine: (id: string, tab?: MachineTab) => withQuery(`${root}/machines/${segment(id)}`, { tab }),
  inventory: (tab?: InventoryTab) => withQuery(`${root}/inventory`, { tab }),
  material: (id: string) => `${root}/inventory/materials/${segment(id)}`,
  spool: (id: string) => `${root}/inventory/spools/${segment(id)}`,
  /** Statistics sits under Administration, outside the Workshop area. */
  statistics: () => '/statistics',
  /** Printer connectors live under Settings, Local services. */
  connectors: () => '/settings/local-services?tab=connectors',
};

/** Tabs of the Inventory page including the inventory recycle bin (`?tab=bin`). */
export type InventorySection = InventoryTab | 'bin';
export const inventorySectionPath = (section: InventorySection) => `${root}/inventory?tab=${section}`;
/** The printer setup page of an FDM printer. */
export const machinePrinterSetupPath = (id: string) =>
  `${machineLogbookPaths.machines()}/${encodeURIComponent(id)}/printer`;
