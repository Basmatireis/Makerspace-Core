import { queryOptions } from '@tanstack/react-query';
import { getJobOrderAssociation } from '../../../api/generated/orders/orders';
import { ApiError } from '../../../api/http-client';
import type {
  BillingParty,
  FilamentOwnership,
  ListMachineRunsParams,
  MachineJobUsage,
  MachineJobUsageInput,
  MaterialUnit,
  Operator,
  QuantityBasis,
} from '../../../api/generated/models';
import { decimalText, parseDecimalText } from '../../../app/decimalInput';
import { resolveQuantityText } from '../../../app/quantityExpression';
import { machineLogbookKeys } from '../queries';

export type UsageRow = {
  /** Makerspace stock (an article, optionally a spool) or material the recipient brought. Set by the material picker. */
  ownership: FilamentOwnership;
  materialId: string;
  spoolId: string;
  /** Short label of the recipient's own material, e.g. "PLA, Prusament Galaxy Black". */
  externalName: string;
  /** Material type of the recipient's own material; decides its unit. */
  materialTypeId: string;
  /** Raw text as typed; see decimalInput. */
  quantity: string;
  quantityBasis: QuantityBasis;
  /** Names shown while the catalog is unavailable or no longer lists the material or spool (never an ID). */
  materialLabel?: string;
  materialTypeLabel?: string;
  spoolLabel?: string;
  unit?: MaterialUnit;
};
export type UsagesValues = { usages: UsageRow[]; measures?: Record<string, string> };
export type PartyValues = { customer: BillingParty | null; operator: Operator | null; notes: string };

export const blankUsage = (): UsageRow => ({
  ownership: 'makerspace',
  materialId: '',
  spoolId: '',
  externalName: '',
  materialTypeId: '',
  quantity: '',
  quantityBasis: 'actual',
});

export const usageRowsFromUsages = (usages: MachineJobUsage[]): UsageRow[] =>
  usages.map((usage) => ({
    ownership: usage.ownership,
    materialId: usage.materialId ?? '',
    spoolId: usage.spoolId ?? '',
    externalName: usage.ownership === 'external' ? (usage.label ?? usage.materialName) : '',
    materialTypeId: usage.ownership === 'external' ? (usage.materialTypeId ?? '') : '',
    quantity: decimalText(usage.quantity),
    quantityBasis: usage.quantityBasis,
    materialLabel: usage.materialName,
    materialTypeLabel: usage.materialTypeName,
    spoolLabel: usage.spoolDisplayId ?? undefined,
    unit: usage.unit,
  }));

/** Whether the row names a material: an article of the stock, or the recipient's own material by label or type. */
export const hasMaterial = (row: UsageRow) =>
  row.ownership === 'external' ? Boolean(row.externalName.trim() || row.materialTypeId) : Boolean(row.materialId);

/** A row with no material and no quantity records nothing: it is neither validated nor submitted. */
export const isBlankUsage = (row: UsageRow | undefined): boolean => !row || (!hasMaterial(row) && !row.quantity.trim());

/** The API takes quantities as decimal strings. */
export const toUsageInputs = (rows: UsageRow[]): MachineJobUsageInput[] =>
  rows
    .filter((row) => !isBlankUsage(row))
    .map((row) =>
      row.ownership === 'external'
        ? {
            ownership: 'external',
            materialId: null,
            spoolId: null,
            materialTypeId: row.materialTypeId || null,
            label: row.externalName.trim() || null,
            quantity: parseDecimalText(resolveQuantityText(row.quantity)) ?? row.quantity,
            quantityBasis: row.quantityBasis,
          }
        : {
            ownership: 'makerspace',
            materialId: row.materialId,
            spoolId: row.spoolId || null,
            quantity: parseDecimalText(resolveQuantityText(row.quantity)) ?? row.quantity,
            quantityBasis: row.quantityBasis,
          },
    );

export const matchesName = <T extends { displayName: string }>({
  item,
  inputValue,
}: {
  item: T | null;
  inputValue: string | null;
}) => !inputValue || !item || item.displayName.toLowerCase().includes(inputValue.toLowerCase());

export type JobInitialValues = {
  machineId?: string;
  title?: string | null;
  customer?: BillingParty | null;
  operator?: Operator | null;
  notes?: string | null;
};

/** Unassigned recorded runs on one machine (running ones included), the candidates for attaching to a job. */
export const unassignedRunsParams = (machineId: string): ListMachineRunsParams => ({
  machineId,
  assigned: false,
  source: 'recorded',
  pageSize: 100,
});

export type SaveError = { message: string; field?: 'customer' | 'outcome' | 'machine' };

/** Translates API failures of job mutations into text for the person using the form. */
export function saveError(error: unknown, fallback = 'The job could not be saved.'): SaveError {
  if (!(error instanceof ApiError)) return { message: fallback };
  switch (error.data?.code) {
    case 'outcome_before_run_end':
      return { message: 'The outcome can only be recorded once the run has ended.', field: 'outcome' };
    case 'customer_required':
      return { message: 'Choose a recipient before this job can be saved.', field: 'customer' };
    case 'outcome_required':
      return { message: 'Choose how the run ended before this job can be saved.', field: 'outcome' };
    case 'job_needs_run':
      return { message: 'A job needs at least one run. Add another run before removing this one.' };
    case 'machine_change_not_allowed':
      return { message: 'The machine cannot change while the job has a recorded run.', field: 'machine' };
    case 'run_machine_mismatch':
      return { message: 'The run was recorded on another machine than the job.' };
    case 'run_already_assigned':
      return { message: 'The run already belongs to a job. Reload the page.' };
    case 'stale_write':
      return { message: 'Someone else changed this. Reload the page and try again.' };
    default:
      return { message: [400, 409, 422].includes(error.status) && error.data?.message ? error.data.message : fallback };
  }
}

/** The order a job is charged on, if any. Lives under the logbook key so every mutation refreshes it. */
export const jobOrderQuery = (jobId: string) =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'job-order', jobId],
    queryFn: ({ signal }) => getJobOrderAssociation(jobId, { signal }),
  });

/** The signed-in person as the operator a new job starts with; staff can still choose someone else. */
export const signedInOperator = (person: { id: string; firstName: string; lastName: string }): Operator => ({
  personId: person.id,
  displayName: `${person.firstName} ${person.lastName}`.trim(),
});
