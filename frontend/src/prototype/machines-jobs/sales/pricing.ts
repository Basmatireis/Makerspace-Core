import type { PricingRule } from '../types';
import type { CatalogItem } from './types';
import { formatAmount, formatQuantity, round2 } from './format';

// Stand-in for the backend pricing service (groups, rules, party assignments). Part 2 builds the Pricing page on these rates.
export type PricingGroup = { name: string; isDefault: boolean; machineHour: number; gram: number; milliliter: number; squareMeter: number; piece: number };

export const pricingGroups: PricingGroup[] = [
  { name: 'External', isDefault: true, machineHour: 6, gram: 0.08, milliliter: 0.24, squareMeter: 12, piece: 1 },
  { name: 'Students', isDefault: false, machineHour: 2, gram: 0.04, milliliter: 0.12, squareMeter: 12, piece: 1 },
  { name: 'Staff', isDefault: false, machineHour: 2, gram: 0.04, milliliter: 0.12, squareMeter: 12, piece: 1 },
  { name: 'Student teams', isDefault: false, machineHour: 2, gram: 0.04, milliliter: 0.12, squareMeter: 12, piece: 1 },
  { name: 'Institutes', isDefault: false, machineHour: 2, gram: 0.04, milliliter: 0.12, squareMeter: 12, piece: 1 },
];
export const defaultPricingGroup = pricingGroups.find((group) => group.isDefault)!.name;
const groupByName = (name: string) => pricingGroups.find((group) => group.name === name) ?? pricingGroups[0];

const unitRate = (group: PricingGroup, unit: string) => unit === 'g' ? group.gram : unit === 'ml' ? group.milliliter : unit === 'm2' ? group.squareMeter : group.piece;
const unitLabel = (unit: string) => unit === 'm2' ? 'm²' : unit;

export type QuoteInput = { group: string; durationSeconds: number; usages: { materialName: string; unit: string; quantity: number; ownership: 'makerspace' | 'external' }[] };
export type QuoteLine = { key: string; label: string; detail: string; amount: number };

/** Machine time at the group's hourly rate plus makerspace-owned material. Customer-owned material is not charged. */
export function quoteJob({ group, durationSeconds, usages }: QuoteInput): { lines: QuoteLine[]; total: number; rules: PricingRule[] } {
  const rates = groupByName(group);
  const hours = durationSeconds / 3600;
  const lines: QuoteLine[] = [{ key: 'machine', label: 'Machine time', detail: `${formatQuantity(Math.round(hours * 100) / 100)} h × ${formatAmount(rates.machineHour)} €/h`, amount: round2(hours * rates.machineHour) }];
  usages.forEach((usage, index) => {
    if (usage.ownership === 'external') lines.push({ key: `u${index}`, label: usage.materialName || 'Customer material', detail: 'Customer’s own material, not charged', amount: 0 });
    else if (usage.quantity > 0) lines.push({ key: `u${index}`, label: usage.materialName, detail: `${formatQuantity(usage.quantity)} ${unitLabel(usage.unit)} × ${formatAmount(unitRate(rates, usage.unit))} €/${unitLabel(usage.unit)}`, amount: round2(usage.quantity * unitRate(rates, usage.unit)) });
  });
  return {
    lines, total: round2(lines.reduce((sum, line) => sum + line.amount, 0)),
    rules: [
      { label: 'Machine time', rate: rates.machineHour.toFixed(2), unit: 'h', missing: false },
      { label: 'Material', rate: rates.gram.toFixed(2), unit: 'g', missing: false },
    ],
  };
}

/** [proposed] Sale catalog. The real backend only has free-text manual items. */
export const catalogItems: CatalogItem[] = [
  { id: 'cat-pla-g', name: 'PLA filament sold loose', unit: 'g', unitPrice: 0.05, category: 'Filament' },
  { id: 'cat-petg-g', name: 'PETG filament sold loose', unit: 'g', unitPrice: 0.06, category: 'Filament' },
  { id: 'cat-spool-pla', name: 'PLA spool 1 kg, black', unit: 'piece', unitPrice: 19.9, category: 'Filament' },
  { id: 'cat-inserts', name: 'Brass heat-set inserts M3, pack of 20', unit: 'pack', unitPrice: 4.5, category: 'Small parts' },
  { id: 'cat-screws', name: 'Screw assortment M3', unit: 'pack', unitPrice: 3, category: 'Small parts' },
  { id: 'cat-glue', name: 'Bed adhesive stick', unit: 'piece', unitPrice: 5.5, category: 'Small parts' },
  { id: 'cat-nozzle', name: 'Nozzle 0.4 mm, hardened', unit: 'piece', unitPrice: 12, category: 'Spare parts' },
  { id: 'cat-offcut', name: 'Plywood offcut, A4 size', unit: 'piece', unitPrice: 1.5, category: 'Sheet material' },
];
