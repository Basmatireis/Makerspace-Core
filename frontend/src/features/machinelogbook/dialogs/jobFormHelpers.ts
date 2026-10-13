import { queryOptions } from '@tanstack/react-query';
import { getJobOrderAssociation } from '../../../api/generated/orders/orders';
import { ApiError } from '../../../api/http-client';
import type {
  BillingParty, FilamentOwnership, ListPrintsParams, MachineJobOutcome, MachineJobUsage, MachineJobUsageInput, Operator, Print, PrintReportedUsage, QuantityBasis,
} from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';

export type UsageRow = {
  ownership: FilamentOwnership;
  materialId: string;
  spoolId: string;
  externalName: string;
  quantity: number | '';
  quantityBasis: QuantityBasis;
  /** Names shown while the catalog is unavailable or no longer lists the material or spool (never an ID). */
  materialLabel?: string;
  spoolLabel?: string;
};
export type UsagesValues = { usages: UsageRow[] };
export type PartyValues = { customer: BillingParty | null; operator: Operator | null; outcome: MachineJobOutcome | ''; notes: string };

export const blankUsage = (): UsageRow => ({ ownership: 'makerspace', materialId: '', spoolId: '', externalName: '', quantity: '', quantityBasis: 'actual' });

export const usageRowsFromJob = (usages: MachineJobUsage[]): UsageRow[] => usages.map((usage) => ({
  ownership: usage.ownership,
  materialId: usage.materialId ?? '',
  spoolId: usage.spoolId ?? '',
  externalName: usage.ownership === 'external' ? usage.materialName : '',
  quantity: Number(usage.quantity),
  quantityBasis: usage.quantityBasis,
  materialLabel: usage.materialName,
  spoolLabel: usage.spoolDisplayId ?? undefined,
}));

/** The API takes quantities as decimal strings. */
export const toUsageInputs = (rows: UsageRow[]): MachineJobUsageInput[] => rows.map((row) => ({
  ownership: row.ownership,
  materialId: row.ownership === 'makerspace' ? row.materialId : null,
  spoolId: row.ownership === 'makerspace' ? row.spoolId || null : null,
  externalMaterialName: row.ownership === 'external' ? row.externalName.trim() : null,
  quantity: String(row.quantity),
  quantityBasis: row.quantityBasis,
}));

export const matchesName = <T extends { displayName: string }>({ item, inputValue }: { item: T | null; inputValue: string | null }) =>
  !inputValue || !item || item.displayName.toLowerCase().includes(inputValue.toLowerCase());

/** Prefilled material row for a job created from a print: what the printer reported. */
export const usageRowFromPrint = (usage: NonNullable<PrintReportedUsage>): UsageRow => ({
  ownership: usage.materialId ? 'makerspace' : 'external',
  materialId: usage.materialId ?? '',
  spoolId: usage.spoolId ?? '',
  externalName: usage.materialId ? '' : usage.materialName ?? '',
  quantity: Number(usage.quantity),
  quantityBasis: 'actual',
  materialLabel: usage.materialName ?? undefined,
  spoolLabel: usage.spoolDisplayId ?? undefined,
});

export type JobInitialValues = {
  machineId?: string;
  startsAt?: string;
  endsAt?: string;
  title?: string | null;
  outcome?: MachineJobOutcome;
  customer?: BillingParty | null;
  operator?: Operator | null;
  notes?: string | null;
  /** Prefilled material rows (for a print: what the printer reported). */
  usages?: UsageRow[];
  /** File name of the print the job is created from; the form offers it as the job's name. */
  printFileName?: string;
};

/** Unlinked prints on one machine, the candidates for linking to a job. */
export const unlinkedPrintsParams = (machineId: string): ListPrintsParams => ({ machineId, linked: false, pageSize: 100 });
/** Only ended prints can be linked. */
export const linkablePrints = (prints: Print[] | undefined) => (prints ?? []).filter((print) => print.state !== 'printing');

export type SaveError = { message: string; field?: 'customer' | 'outcome' };

/** Translates API failures of job mutations into text for the person using the form. */
export function saveError(error: unknown, fallback = 'The job could not be saved.'): SaveError {
  if (!(error instanceof ApiError)) return { message: fallback };
  switch (error.data?.code) {
    case 'outcome_before_run_end': return { message: 'The outcome can only be recorded once the run has ended.', field: 'outcome' };
    case 'customer_required': return { message: 'Choose a customer before this job can be saved.', field: 'customer' };
    case 'outcome_required': return { message: 'Choose how the run ended before this job can be saved.', field: 'outcome' };
    case 'stale_write': return { message: 'Someone else changed this job. Reload the page and try again.' };
    default: return { message: [400, 409, 422].includes(error.status) && error.data?.message ? error.data.message : fallback };
  }
}

/** The order a job is charged on, if any. Lives under the logbook key so every mutation refreshes it. */
export const jobOrderQuery = (jobId: string) => queryOptions({
  queryKey: [...machineLogbookKeys.all, 'job-order', jobId],
  queryFn: ({ signal }) => getJobOrderAssociation(jobId, { signal }),
});
