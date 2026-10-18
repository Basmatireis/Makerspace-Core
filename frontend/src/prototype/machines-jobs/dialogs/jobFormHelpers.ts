import type { BillingParty, JobOutcome, JobUsage, Operator, Ownership, PrintUsage, QuantityBasis, Spool } from '../types';
import type { JobFactsInput, UsageInput } from '../store';
import { lookups } from '../store';

export type UsageRow = { ownership: Ownership; materialId: string; spoolId: string; externalName: string; quantity: number | ''; quantityBasis: QuantityBasis };
export type UsagesValues = { usages: UsageRow[] };
/** The customer is empty only until one is chosen; the form requires it. */
export type PartyValues = { customer: BillingParty | null; operator: Operator | null; outcome: JobOutcome; notes: string };

export const blankUsage = (): UsageRow => ({ ownership: 'makerspace', materialId: '', spoolId: '', externalName: '', quantity: '', quantityBasis: 'actual' });

export const usageRowsFromJob = (usages: JobUsage[]): UsageRow[] => usages.map((usage) => ({
  ownership: usage.ownership, materialId: usage.materialId ?? '', spoolId: usage.spoolId ?? '',
  externalName: usage.ownership === 'external' ? usage.materialName : '', quantity: usage.quantity, quantityBasis: usage.quantityBasis,
}));

export const toUsageInputs = (rows: UsageRow[]): UsageInput[] => rows.map((row) => ({
  ownership: row.ownership,
  materialId: row.ownership === 'makerspace' ? row.materialId : null,
  spoolId: row.ownership === 'makerspace' ? row.spoolId || null : null,
  materialName: row.ownership === 'external' ? row.externalName.trim() : lookups.materials.find((item) => item.id === row.materialId)?.name ?? '',
  quantity: Number(row.quantity),
  quantityBasis: row.quantityBasis,
}));

export const matchesName = <T extends { displayName: string }>({ item, inputValue }: { item: T | null; inputValue: string | null }) =>
  !inputValue || !item || item.displayName.toLowerCase().includes(inputValue.toLowerCase());

/** Prefilled material row for a job created from a print: what the printer reported. */
export const usageRowFromPrint = (usage: PrintUsage, spools: Spool[]): UsageRow => ({
  ownership: usage.materialId ? 'makerspace' : 'external',
  materialId: usage.materialId ?? '',
  spoolId: spools.find((spool) => spool.displayId === usage.spoolDisplayId)?.id ?? '',
  externalName: usage.materialId ? '' : usage.materialName,
  quantity: usage.quantity,
  quantityBasis: 'actual',
});

export type JobInitialValues = Partial<JobFactsInput> & { usages?: UsageRow[]; /** File name of the print the job is created from. */ printFileName?: string };
