/* eslint-disable react-refresh/only-export-components -- tags and the inventory derivations they render form one module */
import { Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, WarningAltFilled } from '@carbon/icons-react';
import { decimalNumber } from '../../../app/decimalInput';
import { EmptyState } from '../../../app/PageState';
import type {
  InventoryAdjustmentReason,
  InventoryTransactionKind,
  Material,
  MaterialKind,
  MaterialUnit,
  StockState,
} from '../../../api/generated/models';
import { formatMoney } from '../shared/format';

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

export type { StockState };

export const unitLabel = (unit: MaterialUnit) =>
  unit === 'm2' ? 'm²' : unit === 'cm2' ? 'cm²' : unit === 'piece' ? 'pcs' : unit;
/** "1,250 g". The API sends decimal strings. */
export const formatQuantity = (value: string | number, unit: MaterialUnit) =>
  `${number.format(Number(value))} ${unitLabel(unit)}`;
export const formatSigned = (value: string | number, unit: MaterialUnit) => {
  const n = Number(value);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${number.format(Math.abs(n))} ${unitLabel(unit)}`;
};
export const formatSignedMoney = (value: string | number | null | undefined) => {
  if (value == null) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatMoney(Math.abs(n))}`;
};

/** Cost per stock unit; grams and millilitres read better per kilogram and litre. */
export function formatUnitCost(cost: string | number | null | undefined, unit: MaterialUnit) {
  if (cost == null) return '—';
  const n = Number(cost);
  if (unit === 'g') return `${formatMoney(n * 1000)} / kg`;
  if (unit === 'ml') return `${formatMoney(n * 1000)} / l`;
  return `${formatMoney(n)} / ${unitLabel(unit)}`;
}

/** Average acquisition cost of a material; a material that never held stock has none yet. */
export const materialUnitCost = (material: Pick<Material, 'averageUnitCost' | 'inventoryValue' | 'quantity'>) =>
  Number(material.averageUnitCost) === 0 && Number(material.inventoryValue) === 0 && Number(material.quantity) === 0
    ? null
    : material.averageUnitCost;

export const stockStateOptions: { id: StockState; label: string }[] = [
  { id: 'in_stock', label: 'In stock' },
  { id: 'low_stock', label: 'Low' },
  { id: 'empty', label: 'Empty' },
];

const stockMeta = {
  in_stock: { label: 'In stock', type: 'green', icon: CheckmarkFilled },
  low_stock: { label: 'Low', type: 'warm-gray', icon: WarningAltFilled },
  empty: { label: 'Empty', type: 'red', icon: ErrorFilled },
} as const;

export function StockTag({ state, size = 'md' }: { state: StockState; size?: 'sm' | 'md' }) {
  const meta = stockMeta[state];
  return (
    <Tag type={meta.type} size={size} renderIcon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

export const formatGrams = (value: string | number) => `${number.format(Number(value))} g`;

// The API distinguishes who moved the stock; the table shows one tag per kind.
export const transactionKindOptions: { id: InventoryTransactionKind; label: string }[] = [
  { id: 'purchase', label: 'Purchase' },
  { id: 'machine_run_consumption', label: 'Run consumption' },
  { id: 'manual_consumption', label: 'Manual consumption' },
  { id: 'adjustment', label: 'Correction' },
  { id: 'disposal', label: 'Disposal' },
  { id: 'spool_transfer', label: 'Transfer' },
  { id: 'order_sale', label: 'Sold (order)' },
  { id: 'order_sale_reversal', label: 'Order reversed' },
];
const kindType = {
  purchase: 'green',
  machine_run_consumption: 'blue',
  manual_consumption: 'blue',
  adjustment: 'purple',
  disposal: 'red',
  spool_transfer: 'teal',
  order_sale: 'magenta',
  order_sale_reversal: 'cyan',
} as const;
export function TransactionKindTag({ kind, size = 'sm' }: { kind: InventoryTransactionKind; size?: 'sm' | 'md' }) {
  return (
    <Tag type={kindType[kind]} size={size}>
      {transactionKindOptions.find((item) => item.id === kind)?.label}
    </Tag>
  );
}

export const adjustmentReasonLabels: Record<InventoryAdjustmentReason, string> = {
  inventory_count: 'Inventory count',
  unrecorded_consumption: 'Unrecorded consumption',
  damaged: 'Damaged',
  disposed: 'Disposed',
  mark_empty: 'Marked as empty',
  job_corrected: 'Job corrected',
  other: 'Other',
};

export function NoInventoryAccess() {
  return (
    <EmptyState
      title="No access to inventory"
      description="Your role does not include viewing inventory. Ask a workshop supervisor for access."
    />
  );
}

/** Only filament articles are tracked per spool. */
export const isFilament = (material: Pick<Material, 'kind'>) => material.kind === 'filament';

export const articleKinds: MaterialKind[] = ['filament', 'consumable', 'part'];
export const kindNames: Record<MaterialKind, string> = { filament: 'Filament', consumable: 'Consumable', part: 'Part' };
/** What the material type of an article is called: parts have categories. */
export const typeNoun = (kind: MaterialKind) => (kind === 'part' ? 'Category' : 'Material');
export const typeNounLower = (kind: MaterialKind) => (kind === 'part' ? 'category' : 'material type');

export function ArticleKindTag({ kind, size = 'sm' }: { kind: MaterialKind; size?: 'sm' | 'md' }) {
  return (
    <Tag type={kind === 'filament' ? 'purple' : kind === 'consumable' ? 'teal' : 'cool-gray'} size={size}>
      {kindNames[kind]}
    </Tag>
  );
}

/** The name the backend generates for filament and consumables: "<Type> <Variant> · <Colour> · <Manufacturer>". */
export function generatedArticleName({
  typeName,
  variant,
  colorName,
  manufacturer,
}: {
  typeName?: string | null;
  variant?: string | null;
  colorName?: string | null;
  manufacturer?: string | null;
}) {
  const head = [typeName?.trim(), variant?.trim()].filter(Boolean).join(' ');
  return [head, colorName?.trim(), manufacturer?.trim()].filter(Boolean).join(' · ');
}

/** Parses a typed decimal ("1,5" or "1.5"); null when empty or not a number. */
export function parseDecimal(value: string): number | null {
  return decimalNumber(value);
}

/** API decimal (up to six fraction digits, no exponent) from a number. */
export const toDecimal = (value: number) => String(Number(value.toFixed(6)));
/** API money (up to two fraction digits). */
export const toMoney = (value: number) => value.toFixed(2);

/** Colour swatch and name of a material; spools and lists only display the colour, they never hold their own. */
export function MaterialColor({ name, hex }: { name?: string | null; hex?: string | null }) {
  if (!name && !hex) return <span className="mj-secondary">—</span>;
  return (
    <span className="mj-inline">
      {hex && <span className="mj-swatch" style={{ backgroundColor: hex }} role="img" aria-label={`Colour ${hex}`} />}
      {name && <span>{name}</span>}
    </span>
  );
}
