// Preview of the ledger entries a refill or a finished spool writes. The backend computes the real entries with the
// same rules (correction for the difference, then the leftover leaves the spool); the dialogs only preview them, so
// the review step reads exactly like the saved ledger.
import type { InventoryTransactionKind, LeftoverOutcome } from '../../api/generated/models';

export type LeftoverBasis = 'system' | 'weighed' | 'none';
export type LeftoverChoice = {
  basis: LeftoverBasis;
  /** Filament left on the spool after the fill, in g. */
  leftoverG: number;
  /** What happens to a leftover above zero. */
  outcome: Exclude<LeftoverOutcome, 'used_up'>;
};

/** What the plan needs to know about the open fill. */
export type PlannedFill = { remainingQuantity: number; fillNumber: number };

export type PlannedEntry = { kind: Extract<InventoryTransactionKind, 'adjustment' | 'spool_transfer' | 'disposal'>; quantity: number; note: string };

const g = (value: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(Math.abs(value))} g`;

/** Entries that bring the spool to zero: a correction for the difference, then the leftover leaves the spool. */
export function planClose(fill: PlannedFill, choice: LeftoverChoice): PlannedEntry[] {
  const expected = fill.remainingQuantity;
  const leftover = Math.max(0, choice.leftoverG);
  const entries: PlannedEntry[] = [];
  const difference = Math.round((leftover - expected) * 1000) / 1000;
  if (difference !== 0) {
    entries.push({
      kind: 'adjustment', quantity: difference,
      note: choice.basis === 'weighed' ? `Weighed leftover ${g(leftover)}, system expected ${g(expected)}` : `Fill ${fill.fillNumber} used up, ${g(expected)} written off`,
    });
  }
  if (leftover > 0) {
    entries.push(choice.outcome === 'returned_to_stock'
      ? { kind: 'spool_transfer', quantity: -leftover, note: `Fill ${fill.fillNumber} leftover returned to loose stock` }
      : { kind: 'disposal', quantity: -leftover, note: `Fill ${fill.fillNumber} leftover disposed` });
  }
  return entries;
}

export const leftoverOutcome = (choice: LeftoverChoice): LeftoverOutcome => choice.leftoverG > 0 ? choice.outcome : 'used_up';

/** Change of the material total caused by closing the fill (transfers only move attribution). */
export const closeMaterialDelta = (fill: PlannedFill, choice: LeftoverChoice) => planClose(fill, choice)
  .reduce((sum, entry) => (entry.kind === 'spool_transfer' ? sum : sum + entry.quantity), 0);
