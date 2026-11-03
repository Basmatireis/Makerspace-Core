import type { MachineJobUsage, MachineRun, MachineRunReportedUsageItem } from '../../../api/generated/models';
import { unresolvedReportedUsageItems } from '../shared/status';

/** Grams a report line names: the connector's estimate, else the slicer's plan. */
export const reportedLineQuantity = (item: MachineRunReportedUsageItem) =>
  item.estimatedQuantityGrams ?? item.plannedQuantityGrams ?? null;

/** "AMS 1 · Slot 2" when the connector knows the slot, else the slicer filament or the line number. */
export function reportedLineName(item: MachineRunReportedUsageItem) {
  if (item.inputUnitExternalId && item.slotExternalId) {
    if (item.inputUnitExternalId === item.slotExternalId && ['254', '255'].includes(item.slotExternalId))
      return `External spool ${item.slotExternalId}`;
    return `Unit ${item.inputUnitExternalId} · Slot ${item.slotExternalId}`;
  }
  if (item.slicerFilamentId) return `Filament ${item.slicerFilamentId}`;
  return `Line ${item.lineNumber + 1}`;
}

/** Recipient's own material recorded by staff with exactly the quantity of a report line resolves that line. */
function ownMaterialMatches(items: MachineRunReportedUsageItem[], usages: MachineJobUsage[]) {
  const matches = new Map<number, MachineJobUsage>();
  const claimed = new Set<string>();
  for (const item of items) {
    const quantity = reportedLineQuantity(item);
    if (quantity == null) continue;
    const usage = usages.find(
      (candidate) =>
        candidate.ownership === 'external' &&
        !claimed.has(candidate.id) &&
        Number(candidate.quantity) === Number(quantity),
    );
    if (usage) {
      matches.set(item.lineNumber, usage);
      claimed.add(usage.id);
    }
  }
  return matches;
}

/** Report lines no spool and no recipient material accounts for yet. */
export function openReportedLines(run: Pick<MachineRun, 'reportedUsageItems' | 'usages'>) {
  const unresolved = unresolvedReportedUsageItems(run);
  const own = ownMaterialMatches(unresolved, run.usages);
  return unresolved.filter((item) => !own.has(item.lineNumber));
}

/** How a report line is booked: on a spool, as the recipient's material, or not at all. */
export function reportedLineState(
  run: Pick<MachineRun, 'reportedUsageItems' | 'usages'>,
  item: MachineRunReportedUsageItem,
): 'booked' | 'recipient' | 'open' | 'none' {
  if (reportedLineQuantity(item) == null || Number(reportedLineQuantity(item)) <= 0) return 'none';
  const unresolved = unresolvedReportedUsageItems(run);
  if (!unresolved.some((line) => line.lineNumber === item.lineNumber)) return 'booked';
  return ownMaterialMatches(unresolved, run.usages).has(item.lineNumber) ? 'recipient' : 'open';
}
