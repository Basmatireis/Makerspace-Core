import { within } from '@testing-library/react';
import type {
  DetectedSpoolTag,
  FilamentSpool,
  InventoryTransaction,
  Material,
  MaterialType,
} from '../../api/generated/models';

/** Test fixtures of the inventory screens: articles, types, spools, ledger entries and detected tags. */
export const invId = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8e${String(n).padStart(3, '0')}`;
const now = '2026-10-30T10:00:00Z';

export const page = <T>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

export const materialType = (overrides: Partial<MaterialType> = {}): MaterialType => ({
  id: invId(1),
  name: 'PLA',
  code: 'PLA',
  kind: 'filament',
  machineUse: true,
  unit: 'g',
  processIds: [],
  active: true,
  materialCount: 1,
  pricingRuleCount: 1,
  version: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

export const plaType = materialType();
export const partType = materialType({
  id: invId(2),
  name: 'Fasteners',
  code: 'FASTENERS',
  kind: 'part',
  machineUse: false,
  unit: 'piece',
  pricingRuleCount: 0,
});

export const material = (overrides: Partial<Material> = {}): Material => ({
  id: invId(10),
  displayId: 'A-0001',
  name: 'PLA Basic · Dark Blue · Bambu Lab',
  kind: 'filament',
  materialTypeId: plaType.id,
  materialTypeName: 'PLA',
  materialTypeCode: 'PLA',
  machineUse: true,
  variant: 'Basic',
  manufacturer: 'Bambu Lab',
  packageSize: '1000',
  storageLocation: 'Shelf B2',
  notes: null,
  colorName: 'Dark Blue',
  colorHex: '#0A2989',
  unit: 'g',
  active: true,
  lowStockThreshold: '500',
  quantity: '1612',
  assignedQuantity: '612',
  unassignedQuantity: '1000',
  filamentDiameterMm: '1.75',
  averageUnitCost: '0.02',
  inventoryValue: '32.24',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '37',
  prices: [
    {
      pricingGroupId: invId(90),
      pricingGroupName: 'Members',
      rate: '0.04',
      source: 'material_type',
      pricingRuleId: invId(91),
    },
  ],
  attention: [],
  version: 3,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

export const part = (overrides: Partial<Material> = {}): Material =>
  material({
    id: invId(11),
    displayId: 'A-0002',
    name: 'M3 heat-set insert',
    kind: 'part',
    materialTypeId: partType.id,
    materialTypeName: 'Fasteners',
    materialTypeCode: 'FASTENERS',
    machineUse: false,
    variant: null,
    manufacturer: 'Ruthex',
    colorName: null,
    colorHex: null,
    unit: 'piece',
    packageSize: '100',
    quantity: '240',
    assignedQuantity: '0',
    unassignedQuantity: '240',
    lowStockThreshold: '50',
    filamentDiameterMm: null,
    storageLocation: 'Drawer F1',
    inventoryValue: '16.80',
    averageUnitCost: '0.07',
    inventoryVersion: 2,
    prices: [],
    ...overrides,
  });

export const spool = (overrides: Partial<FilamentSpool> = {}): FilamentSpool => ({
  id: invId(20),
  displayId: 'S-PLA-BASIC-DARK BLUE-01',
  materialId: invId(10),
  materialDisplayId: 'A-0001',
  materialName: 'PLA Basic · Dark Blue · Bambu Lab',
  materialTypeName: 'PLA',
  colorName: 'Dark Blue',
  colorHex: '#0A2989',
  manufacturer: 'Bambu Lab',
  unit: 'g',
  initialNetWeightG: '1000',
  remainingQuantity: '612',
  tareWeightG: '250',
  acquiredOn: '2026-10-30',
  acquisitionReference: 'INV-4711',
  storageLocation: 'Shelf B2',
  notes: null,
  lifecycle: 'active',
  archivedAt: null,
  retiredOutcome: null,
  retiredQuantity: null,
  retiredByName: null,
  mounted: true,
  mountedOn: {
    machineId: invId(40),
    machineName: 'H2D',
    inputUnitName: 'AMS 1',
    slotId: invId(41),
    slotName: 'Slot 1',
  },
  identifiers: [{ id: invId(30), kind: 'nfc', value: '7A3F19C2', createdAt: now }],
  attention: [],
  version: 4,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

export const transaction = (overrides: Partial<InventoryTransaction> = {}): InventoryTransaction => ({
  id: invId(60),
  materialId: invId(10),
  kind: 'purchase',
  quantityDelta: '2000',
  unitAcquisitionCost: '0.02',
  inventoryValueDelta: '40',
  totalPurchasePrice: '40.00',
  occurredAt: '2026-10-30T09:00:00Z',
  supplier: '3DJake',
  note: null,
  adjustmentReason: null,
  reference: null,
  machineJobId: null,
  machineJobDisplayId: null,
  orderId: null,
  orderReference: null,
  spoolId: null,
  spoolDisplayId: null,
  fromSpoolId: null,
  fromSpoolDisplayId: null,
  toSpoolId: null,
  toSpoolDisplayId: null,
  transferQuantity: null,
  actorName: 'Lena Hofer',
  createdAt: now,
  ...overrides,
});

export const detectedTag = (overrides: Partial<DetectedSpoolTag> = {}): DetectedSpoolTag => ({
  machineId: invId(40),
  machineName: 'H2D',
  unitExternalId: '0',
  unitLabel: 'AMS 1',
  trayExternalId: '1',
  slotId: invId(42),
  slotName: 'Slot 2',
  inputUnitName: 'AMS 1',
  tagUid: 'A1C4D77E',
  materialType: 'PLA',
  subBrand: 'PLA Basic',
  colorHex: '0A2989',
  remainPercent: 68,
  observedAt: now,
  spool: null,
  ...overrides,
});

/**
 * A Carbon icon-only button by its tooltip text. The button is labelled by its (hidden) tooltip, which jsdom's
 * accessible-name computation leaves out.
 */
export function iconButton(container: HTMLElement, label: string | RegExp): HTMLElement {
  const tip = within(container)
    .getAllByText(label)
    .map((element) => element.closest('[role="tooltip"]'))
    .find(Boolean);
  const button = tip ? container.querySelector(`[aria-labelledby="${tip.id}"]`) : null;
  if (!(button instanceof HTMLElement)) throw new Error(`No icon button labelled ${String(label)}`);
  return button;
}
