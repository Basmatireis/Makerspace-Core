import type { MaterialDimension, MaterialUnit } from '../../api/generated/models';

/** Units of each dimension, reference unit first. Mirrors the backend unit table. */
export const unitsByDimension: Record<MaterialDimension, readonly MaterialUnit[]> = {
  mass: ['g', 'kg'],
  length: ['mm', 'cm', 'm'],
  area: ['cm2', 'm2'],
  volume: ['ml', 'l'],
  count: ['piece'],
};

export const dimensionOrder: readonly MaterialDimension[] = ['mass', 'length', 'area', 'volume', 'count'];

export const dimensionNames: Record<MaterialDimension, string> = {
  mass: 'Mass',
  length: 'Length',
  area: 'Area',
  volume: 'Volume',
  count: 'Count',
};

/** Long names for selects. */
export const unitNames: Record<MaterialUnit, string> = {
  g: 'Grams (g)',
  kg: 'Kilograms (kg)',
  mm: 'Millimetres (mm)',
  cm: 'Centimetres (cm)',
  m: 'Metres (m)',
  cm2: 'Square centimetres (cm²)',
  m2: 'Square metres (m²)',
  ml: 'Millilitres (ml)',
  l: 'Litres (l)',
  piece: 'Pieces',
};

/** All units in select order, grouped by dimension. */
export const allUnits: readonly MaterialUnit[] = dimensionOrder.flatMap((dimension) => unitsByDimension[dimension]);

export function dimensionOf(unit: MaterialUnit): MaterialDimension {
  return dimensionOrder.find((dimension) => unitsByDimension[dimension].includes(unit)) ?? 'count';
}

export const unitsOfDimension = (dimension: MaterialDimension): readonly MaterialUnit[] => unitsByDimension[dimension];

/** Short symbol: "cm²", "m²", "pcs", otherwise the unit itself. */
export const unitSymbol = (unit: MaterialUnit) =>
  unit === 'm2' ? 'm²' : unit === 'cm2' ? 'cm²' : unit === 'piece' ? 'pcs' : unit;

/** The unit of an article as shown to people: its count label (sheet, pair) when it has one, else the symbol. */
export const articleUnitLabel = (unit: MaterialUnit, countLabel?: string | null) =>
  unit === 'piece' && countLabel ? countLabel : unitSymbol(unit);

/** Factor of a unit to its dimension's smallest unit (mirrors the backend). */
const factors: Record<MaterialUnit, number> = {
  g: 1,
  kg: 1000,
  mm: 1,
  cm: 10,
  m: 1000,
  cm2: 1,
  m2: 10000,
  ml: 1,
  l: 1000,
  piece: 1,
};

export const unitFactor = (unit: MaterialUnit) => factors[unit];

/** Converts a quantity between units of one dimension. */
export const convertQuantity = (value: number, from: MaterialUnit, to: MaterialUnit) =>
  (value * factors[from]) / factors[to];

/** Symbol of a unit given as free text (order items copy a unit or count label): known units get their symbol. */
export const unitDisplay = (unit: string) => (unit in factors ? unitSymbol(unit as MaterialUnit) : unit);
