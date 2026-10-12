/* eslint-disable react-refresh/only-export-components -- tags and the inventory derivations they render form one module */
import { Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, WarningAltFilled } from '@carbon/icons-react';
import { EmptyState } from '../../../app/PageState';
import { formatMoney } from '../derived';
import type { FilamentPackaging, FilamentProduct, IdentifierKind, InventoryTransactionKind, Material, MaterialUnit, PrinterProfile, Machine, Spool, SpoolKind, SpoolLifecycle, LeftoverOutcome } from '../types';

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

export const unitLabel = (unit: MaterialUnit) => (unit === 'm2' ? 'm²' : unit);
export const formatQuantity = (value: number, unit: MaterialUnit) => `${number.format(value)} ${unitLabel(unit)}`;
export const formatSigned = (value: number, unit: MaterialUnit) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number.format(Math.abs(value))} ${unitLabel(unit)}`;
export const formatSignedMoney = (value: number | null) => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value))}`;

/** Cost per stock unit; grams and millilitres read better per kilogram and litre. */
export function formatUnitCost(cost: number | null, unit: MaterialUnit) {
  if (cost == null) return '—';
  if (unit === 'g') return `${formatMoney(cost * 1000)} / kg`;
  if (unit === 'ml') return `${formatMoney(cost * 1000)} / l`;
  return `${formatMoney(cost)} / ${unitLabel(unit)}`;
}

export type StockState = 'in_stock' | 'low' | 'empty';
export const stockState = (material: Material): StockState => material.quantity <= 0
  ? 'empty'
  : material.lowStockThreshold != null && material.quantity <= material.lowStockThreshold ? 'low' : 'in_stock';
export const stockStateOptions: { id: StockState; label: string }[] = [{ id: 'in_stock', label: 'In stock' }, { id: 'low', label: 'Low' }, { id: 'empty', label: 'Empty' }];

const stockMeta = {
  in_stock: { label: 'In stock', type: 'green', icon: CheckmarkFilled },
  low: { label: 'Low', type: 'warm-gray', icon: WarningAltFilled },
  empty: { label: 'Empty', type: 'red', icon: ErrorFilled },
} as const;

export function StockTag({ state, size = 'md' }: { state: StockState; size?: 'sm' | 'md' }) {
  const meta = stockMeta[state];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

/** Reusable spools are Loaded / Needs refill / Archived, single-use spools Active / Archived. */
export const lifecycleLabel = (kind: SpoolKind, lifecycle: SpoolLifecycle) => lifecycle === 'archived'
  ? 'Archived'
  : kind === 'reusable' ? (lifecycle === 'active' ? 'Loaded' : 'Needs refill') : lifecycle === 'active' ? 'Active' : 'Empty';
export const lifecycleOptions: { id: SpoolLifecycle; label: string }[] = [{ id: 'active', label: 'Active or loaded' }, { id: 'empty', label: 'Needs refill' }];
const lifecycleType = { active: 'green', empty: 'warm-gray', archived: 'gray' } as const;
export function LifecycleTag({ spool, size = 'md' }: { spool: Pick<Spool, 'kind' | 'lifecycle'>; size?: 'sm' | 'md' }) {
  return <Tag type={lifecycleType[spool.lifecycle]} size={size}>{lifecycleLabel(spool.kind, spool.lifecycle)}</Tag>;
}
export const kindOptions: { id: SpoolKind; label: string }[] = [{ id: 'reusable', label: 'Reusable' }, { id: 'single_use', label: 'Single-use' }];
export const kindLabel = (kind: SpoolKind) => kindOptions.find((item) => item.id === kind)?.label ?? kind;
export function KindTag({ kind, size = 'md' }: { kind: SpoolKind; size?: 'sm' | 'md' }) {
  return <Tag type={kind === 'reusable' ? 'blue' : 'cool-gray'} size={size}>{kindLabel(kind)}</Tag>;
}
export const outcomeLabel: Record<LeftoverOutcome, string> = { used_up: 'Used up', returned_to_stock: 'Returned to stock', disposed: 'Disposed' };
const outcomeType = { used_up: 'green', returned_to_stock: 'teal', disposed: 'red' } as const;
export function OutcomeTag({ outcome }: { outcome: LeftoverOutcome }) {
  return <Tag type={outcomeType[outcome]} size="sm">{outcomeLabel[outcome]}</Tag>;
}

export const packagingOptions: { id: FilamentPackaging; label: string }[] = [{ id: 'refill', label: 'Refill' }, { id: 'spool', label: 'Spool' }];
export const packagingLabel = (packaging: FilamentPackaging) => packagingOptions.find((item) => item.id === packaging)?.label ?? packaging;
export function PackagingTag({ packaging, size = 'sm' }: { packaging: FilamentPackaging; size?: 'sm' | 'md' }) {
  return <Tag type={packaging === 'refill' ? 'teal' : 'cool-gray'} size={size}>{packagingLabel(packaging)}</Tag>;
}
/** "Bambu Lab · PLA Basic Black · 1,000 g", the text of a product in pickers. */
export const productLabel = (product: FilamentProduct) => `${product.manufacturer} · ${product.name} · ${formatGrams(product.netWeightG)}`;
/** Spools of this product that are not archived and currently filled with it. */
export const productInUse = (productId: string, spools: Spool[]) => spools.filter((spool) => spool.productId === productId && spool.lifecycle !== 'archived' && Boolean(spool.filledAt)).length;

/** A reusable spool without a current fill. */
export const needsRefill = (spool: Pick<Spool, 'kind' | 'lifecycle'>) => spool.kind === 'reusable' && spool.lifecycle === 'empty';
/** Spools that can be mounted or booked against: loaded or active, with filament left. */
export const isConsumable = (spool: Pick<Spool, 'lifecycle' | 'remainingQuantity'>) => spool.lifecycle === 'active' && spool.remainingQuantity > 0;
export const spoolNameText = (spool: Pick<Spool, 'displayId' | 'label'>) => spool.label ? `${spool.displayId} · ${spool.label}` : spool.displayId;

/** Archived spools that cleanup would delete: single-use only, archived before the cutoff. */
export const monthsAgoIso = (months: number, from = new Date()) => { const date = new Date(from); date.setMonth(date.getMonth() - months); return date.toISOString(); };
export const cleanupCandidates = (spools: Spool[], months: number) => {
  const cutoff = monthsAgoIso(months);
  return spools.filter((spool) => spool.kind === 'single_use' && spool.lifecycle === 'archived' && spool.archivedAt != null && spool.archivedAt < cutoff);
};

export const transactionKindOptions: { id: InventoryTransactionKind; label: string }[] = [
  { id: 'purchase', label: 'Purchase' }, { id: 'consumption', label: 'Consumption' }, { id: 'correction', label: 'Correction' },
  { id: 'disposal', label: 'Disposal' }, { id: 'transfer', label: 'Transfer' },
];
const kindType = { purchase: 'green', consumption: 'blue', correction: 'purple', disposal: 'red', transfer: 'teal' } as const;
export function TransactionKindTag({ kind, size = 'sm' }: { kind: InventoryTransactionKind; size?: 'sm' | 'md' }) {
  return <Tag type={kindType[kind]} size={size}>{transactionKindOptions.find((item) => item.id === kind)?.label}</Tag>;
}

/** Share of the initial net weight that is left, 0-100. */
export const spoolPercent = (spool: Spool) => spool.initialNetWeightG > 0 ? Math.max(0, Math.min(100, Math.round((spool.remainingQuantity / spool.initialNetWeightG) * 100))) : 0;
export const spoolIsLow = (spool: Spool) => spool.lifecycle === 'active' && spool.initialNetWeightG > 0 && spoolPercent(spool) < 15;
export const formatGrams = (value: number) => `${number.format(value)} g`;
export const spoolRemainingText = (spool: Spool) => needsRefill(spool) ? 'Needs refill' : `${formatGrams(spool.remainingQuantity)} of ${formatGrams(spool.initialNetWeightG)}`;

/** Filament of this material held on non-archived spools (current fills only). */
export const onSpoolsStock = (material: Material, spools: Spool[]) => spools
  .filter((spool) => spool.materialId === material.id && spool.lifecycle !== 'archived')
  .reduce((sum, spool) => sum + spool.remainingQuantity, 0);

/** Stock held in the material that is not on any non-archived spool (never negative). */
export const looseStock = (material: Material, spools: Spool[]) => Math.max(0, material.quantity - onSpoolsStock(material, spools));

export type MountedOn = { machineId: string; machineName: string; slotName: string };
export function mountedOn(spoolId: string, profiles: PrinterProfile[], machines: Machine[]): MountedOn | null {
  for (const profile of profiles) {
    const slot = profile.slots.find((item) => item.spoolId === spoolId);
    if (slot) return { machineId: profile.machineId, machineName: machines.find((machine) => machine.id === profile.machineId)?.name ?? 'Unknown machine', slotName: slot.name };
  }
  return null;
}

export const spoolTitle = (spool: Spool) => [spool.manufacturer, spool.productName].filter(Boolean).join(' ');

export function NoInventoryAccess() {
  return <EmptyState title="No access to inventory" description="Your role does not include viewing inventory. Ask a workshop supervisor for access." />;
}

/** Filament is the only material that is tracked per spool. */
export const isFilament = (material: Pick<Material, 'category'>) => material.category.trim().toLowerCase() === 'filament';

/** Parses a typed decimal ("1,5" or "1.5"); null when empty or not a number. */
export function parseDecimal(value: string): number | null {
  const text = value.trim().replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export const identifierKinds: { id: IdentifierKind; label: string }[] = [
  { id: 'nfc', label: 'NFC tag' }, { id: 'barcode', label: 'Barcode' }, { id: 'qr', label: 'QR code' }, { id: 'other', label: 'Other' },
];
export const identifierLabel = (kind: IdentifierKind) => identifierKinds.find((item) => item.id === kind)?.label ?? kind;

