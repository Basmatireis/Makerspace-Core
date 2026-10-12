// Pure planning of the ledger entries a refill or a finished spool writes. The store applies the plan and the
// dialogs preview it, so both always agree.
import type { InventoryTransactionKind, LeftoverOutcome, Spool } from './types';

export type LeftoverBasis = 'system' | 'weighed' | 'none';
export type LeftoverChoice = {
  basis: LeftoverBasis;
  /** Filament left on the spool after the fill, in g. */
  leftoverG: number;
  /** What happens to a leftover above zero. */
  outcome: Exclude<LeftoverOutcome, 'used_up'>;
};

export type PlannedEntry = { kind: InventoryTransactionKind; quantity: number; note: string };

const g = (value: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(Math.abs(value))} g`;

/** Entries that bring the spool to zero: a correction for the difference, then the leftover leaves the spool. */
export function planClose(spool: Spool, choice: LeftoverChoice): PlannedEntry[] {
  const expected = spool.remainingQuantity;
  const leftover = Math.max(0, choice.leftoverG);
  const entries: PlannedEntry[] = [];
  const difference = Math.round((leftover - expected) * 1000) / 1000;
  if (difference !== 0) {
    entries.push({
      kind: 'correction', quantity: difference,
      note: choice.basis === 'weighed' ? `Weighed leftover ${g(leftover)}, system expected ${g(expected)}` : `Fill ${spool.fillNumber} used up, ${g(expected)} written off`,
    });
  }
  if (leftover > 0) {
    entries.push(choice.outcome === 'returned_to_stock'
      ? { kind: 'transfer', quantity: -leftover, note: `Fill ${spool.fillNumber} leftover returned to loose stock` }
      : { kind: 'disposal', quantity: -leftover, note: `Fill ${spool.fillNumber} leftover disposed` });
  }
  return entries;
}

export const leftoverOutcome = (choice: LeftoverChoice): LeftoverOutcome => choice.leftoverG > 0 ? choice.outcome : 'used_up';

/** Change of the material total caused by closing the fill (transfers only move attribution). */
export const closeMaterialDelta = (spool: Spool, choice: LeftoverChoice) => planClose(spool, choice)
  .reduce((sum, entry) => (entry.kind === 'transfer' ? sum : sum + entry.quantity), 0);
