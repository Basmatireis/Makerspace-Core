/** Route builders for the Machines & Jobs area, so links never hard-code path strings. */
const root = '/machine-logbook';
const withQuery = (path: string, query?: Record<string, string | undefined>) => {
  const search = new URLSearchParams(Object.entries(query ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return search ? `${path}?${search}` : path;
};
const segment = (id: string) => encodeURIComponent(id);

export type InventoryTab = 'filament' | 'consumables' | 'parts' | 'spools';
export type MachineTab = 'printer';

/** The Inventory tab that lists articles of a kind. */
export const inventoryTabForKind = (kind: 'filament' | 'consumable' | 'part'): InventoryTab => (kind === 'filament' ? 'filament' : kind === 'consumable' ? 'consumables' : 'parts');

export const machineLogbookPaths = {
  overview: () => root,
  jobs: (query?: Record<string, string | undefined>) => withQuery(`${root}/jobs`, query),
  job: (id: string) => `${root}/jobs/${segment(id)}`,
  run: (id: string) => `${root}/jobs/runs/${segment(id)}`,
  machines: () => `${root}/machines`,
  machine: (id: string, tab?: MachineTab) => withQuery(`${root}/machines/${segment(id)}`, { tab }),
  inventory: (tab?: InventoryTab) => withQuery(`${root}/inventory`, { tab }),
  material: (id: string) => `${root}/inventory/materials/${segment(id)}`,
  spool: (id: string) => `${root}/inventory/spools/${segment(id)}`,
  statistics: () => `${root}/statistics`,
};
