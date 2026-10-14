import type { ConnectorHost, DetectedPrinterState, DetectedTray, MachineConnection, PrinterModel, PrinterModelId, BillingParty, IdentifierKind, InventoryTransaction, InventoryTransactionKind, Job, Machine, MachineType, Material, Operator, FilamentProduct, Print, PrinterProfile, Spool, SpoolFill, LeftoverOutcome } from './types';

// Timestamps are relative to page load so the prototype always looks "live".
const now = Date.now();
export const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const H = 60;
const D = 24 * H;

export const machineTypes: MachineType[] = [
  { id: 'type-fdm', name: 'FDM 3D printer', active: true },
  { id: 'type-sla', name: 'Resin printer', active: true },
  { id: 'type-laser', name: 'Laser cutter', active: true },
  { id: 'type-cnc', name: 'CNC router', active: true },
  { id: 'type-vinyl', name: 'Vinyl cutter', active: false },
];

const conn = (over: Partial<MachineConnection>): MachineConnection => ({
  connectorId: 'ch-workshop', adapterKind: 'simulator', ipAddress: null, serialNumber: null, accessCodeSet: false, autoMountRfid: false, enabled: true,
  runtimeState: 'connected', runtimeErrorCode: null, lastHeartbeatAt: ago(0.3), ...over,
});

export const machines: Machine[] = [
  { id: 'm-mk4-1', name: 'Prusa MK4 #1', machineTypeId: 'type-fdm', status: 'active', modelId: 'generic', automaticCollectionEnabled: true, lastIngestedAt: ago(4), jobCount: 412, runtimeSeconds: 1_522_800, failureRate: 6.1, createdAt: ago(400 * D), updatedAt: ago(3 * D), version: 7,
    connection: conn({ lastHeartbeatAt: ago(0.3) }) },
  { id: 'm-mk4-2', name: 'Prusa MK4 #2', machineTypeId: 'type-fdm', status: 'active', modelId: 'generic', automaticCollectionEnabled: true, lastIngestedAt: ago(52), jobCount: 377, runtimeSeconds: 1_310_400, failureRate: 4.8, createdAt: ago(380 * D), updatedAt: ago(10 * D), version: 4,
    connection: conn({ lastHeartbeatAt: ago(0.5) }) },
  { id: 'm-x1c', name: 'Bambu X1C', machineTypeId: 'type-fdm', status: 'active', modelId: 'bambu_x1c', automaticCollectionEnabled: true, lastIngestedAt: ago(3 * H), jobCount: 268, runtimeSeconds: 902_000, failureRate: 9.7, createdAt: ago(220 * D), updatedAt: ago(1 * D), version: 9,
    connection: conn({ runtimeState: 'degraded', runtimeErrorCode: 'MQTT_TIMEOUT', lastHeartbeatAt: ago(6) }) },
  { id: 'm-h2d', name: 'Bambu H2D', machineTypeId: 'type-fdm', status: 'active', modelId: 'bambu_h2d', automaticCollectionEnabled: true, lastIngestedAt: ago(35), jobCount: 41, runtimeSeconds: 188_000, failureRate: 4.9, createdAt: ago(60 * D), updatedAt: ago(2 * D), version: 3,
    connection: conn({ adapterKind: 'bambu_h2d', ipAddress: '192.168.20.41', serialNumber: '0948AD5B2300417', accessCodeSet: true, autoMountRfid: true, lastHeartbeatAt: ago(0.2) }) },
  { id: 'm-form3', name: 'Formlabs Form 3', machineTypeId: 'type-sla', status: 'maintenance', modelId: null, automaticCollectionEnabled: false, lastIngestedAt: null, jobCount: 96, runtimeSeconds: 640_800, failureRate: 3.1, createdAt: ago(600 * D), updatedAt: ago(2 * D), version: 12, connection: null },
  { id: 'm-laser', name: 'Trotec Speedy 300', machineTypeId: 'type-laser', status: 'active', modelId: null, automaticCollectionEnabled: false, lastIngestedAt: null, jobCount: 731, runtimeSeconds: 820_800, failureRate: 1.2, createdAt: ago(900 * D), updatedAt: ago(30 * D), version: 3, connection: null },
  { id: 'm-cnc', name: 'Shapeoko Pro', machineTypeId: 'type-cnc', status: 'active', modelId: null, automaticCollectionEnabled: false, lastIngestedAt: null, jobCount: 58, runtimeSeconds: 288_000, failureRate: 8.6, createdAt: ago(500 * D), updatedAt: ago(90 * D), version: 2, connection: null },
  { id: 'm-ender', name: 'Ender 3 (legacy)', machineTypeId: 'type-fdm', status: 'retired', modelId: 'generic', automaticCollectionEnabled: false, lastIngestedAt: null, jobCount: 1024, runtimeSeconds: 3_960_000, failureRate: 14.2, createdAt: ago(1500 * D), updatedAt: ago(200 * D), version: 5, connection: null },
];

export const connectorHosts: ConnectorHost[] = [
  { id: 'ch-workshop', name: 'Workshop Pi', locationLabel: 'Workshop rack', lifecycle: 'active', healthState: 'healthy', lastHeartbeatAt: ago(0.2), softwareVersion: '1.4.0', pendingEventCount: 3, quarantinedEventCount: 0,
    events: [
      { id: 'ev-1', kind: 'operational_state', receivedAt: ago(2), summary: 'Bambu H2D is idle', payload: { machine: 'Bambu H2D', state: 'idle', nozzleTempC: [24, 25] } },
      { id: 'ev-2', kind: 'progress', receivedAt: ago(35), summary: 'Prusa MK4 #2 print at 100 %', payload: { machine: 'Prusa MK4 #2', progressPercent: 100, remainingMinutes: 0 } },
      { id: 'ev-3', kind: 'connectivity', receivedAt: ago(6), summary: 'Bambu X1C MQTT timeout', payload: { machine: 'Bambu X1C', code: 'MQTT_TIMEOUT', retryInSeconds: 30 } },
    ] },
  { id: 'ch-laser', name: 'Laser room Pi', locationLabel: 'Laser room', lifecycle: 'pending', healthState: 'offline', lastHeartbeatAt: null, softwareVersion: null, pendingEventCount: 0, quarantinedEventCount: 0, events: [] },
];

// Printer model catalog. Template slot external identifiers match what the real H2D adapter reports:
// input-unit external id = AMS `id`, slot external id = tray `id`, external holders "254" (right) and "255" (left).
export const printerModels: PrinterModel[] = [
  { id: 'bambu_h2d', label: 'Bambu Lab H2D', description: '2 nozzles · AMS · LAN connector', adapterKind: 'bambu_h2d', nozzles: 2, template: [
    { name: 'AMS 2 Pro', externalIdentifier: '0', nozzle: 'left', slots: [0, 1, 2, 3].map((i) => ({ name: `Slot ${i + 1}`, externalIdentifier: String(i) })) },
    { name: 'External spool L', externalIdentifier: '255', nozzle: 'left', slots: [{ name: 'Spool', externalIdentifier: '255' }] },
    { name: 'External spool R', externalIdentifier: '254', nozzle: 'right', slots: [{ name: 'Spool', externalIdentifier: '254' }] },
  ] },
  { id: 'bambu_x1c', label: 'Bambu Lab X1C', description: '1 nozzle · AMS · simulator only', adapterKind: null, nozzles: 1, template: [
    { name: 'AMS', externalIdentifier: '0', nozzle: null, slots: [0, 1, 2, 3].map((i) => ({ name: `Slot ${i + 1}`, externalIdentifier: String(i) })) },
    { name: 'External spool', externalIdentifier: '254', nozzle: null, slots: [{ name: 'Spool', externalIdentifier: '254' }] },
  ] },
  { id: 'prusa_core_one', label: 'Prusa CORE One', description: '1 nozzle · direct feed · simulator only', adapterKind: null, nozzles: 1, template: [
    { name: 'Direct feed', externalIdentifier: null, nozzle: null, slots: [{ name: 'Extruder', externalIdentifier: null }] },
  ] },
  { id: 'generic', label: 'Other 3D printer', description: 'No template · set up spool inputs yourself', adapterKind: null, nozzles: 1, template: [] },
];
export const modelById = (id: PrinterModelId | null) => printerModels.find((model) => model.id === id);

const tray = (externalId: string, over: Partial<DetectedTray> = {}): DetectedTray => ({ externalId, materialType: null, subBrand: null, colorHex: null, remainPercent: null, rfid: false, empty: true, ...over });

/** Observed from a Bambu Lab H2D (print.* status JSON). Extruder 0 = "Right nozzle", 1 = "Left nozzle"; the mapping is to be validated against real data. */
export const h2dDetectedState: DetectedPrinterState = {
  firmware: '01.04.00.00',
  nozzles: [{ id: '0', side: 'right', diameter: 0.4, type: 'HS01' }, { id: '1', side: 'left', diameter: 0.4, type: 'HS01' }],
  units: [
    { externalId: '0', kind: 'ams_2_pro', label: 'AMS 2 Pro', nozzle: 'left', humidityPercent: 3, temperatureC: 27, trays: [
      tray('0', { materialType: 'PLA', subBrand: 'PLA Basic', colorHex: 'FFFFFF', remainPercent: 82, rfid: true, empty: false }),
      tray('1', { materialType: 'PETG', subBrand: 'PETG HF', colorHex: 'FFF144', remainPercent: 64, rfid: true, empty: false }),
      tray('2', { materialType: 'PLA', subBrand: 'PLA Basic', colorHex: '000000', remainPercent: null, rfid: false, empty: false }),
      tray('3'),
    ] },
    { externalId: '128', kind: 'ams_ht', label: 'AMS HT', nozzle: 'right', humidityPercent: 12, temperatureC: 31, trays: [
      tray('0', { materialType: 'PETG-CF', subBrand: 'PETG-CF', colorHex: '1A1A1A', remainPercent: 41, rfid: true, empty: false }),
    ] },
    { externalId: '254', kind: 'external', label: 'External spool R', nozzle: 'right', humidityPercent: null, temperatureC: null, trays: [tray('254')] },
    { externalId: '255', kind: 'external', label: 'External spool L', nozzle: 'left', humidityPercent: null, temperatureC: null, trays: [
      tray('255', { materialType: 'TPU', subBrand: 'TPU 95A', colorHex: 'E8E8E8', remainPercent: 95, rfid: false, empty: false }),
    ] },
  ],
};

/** What the simulator adapter reports for a model without a live adapter: the template, with a few sample spools. */
export function simulatedDetectedState(modelId: PrinterModelId | null): DetectedPrinterState {
  const model = modelById(modelId);
  const sample = [['PLA', 'FFFFFF', 76], ['PETG', 'C0392B', 52], ['ASA', '808080', 33]] as const;
  return {
    firmware: 'simulator',
    nozzles: Array.from({ length: model?.nozzles ?? 1 }, (_, i) => ({ id: String(i), side: i === 0 ? 'right' as const : 'left' as const, diameter: 0.4, type: 'simulated' })),
    units: (model?.template ?? []).map((unit, ui) => ({
      externalId: unit.externalIdentifier ?? String(ui), kind: unit.name.startsWith('External') ? 'external' as const : 'ams_2_pro' as const, label: unit.name, nozzle: unit.nozzle ?? 'left', humidityPercent: null, temperatureC: null,
      trays: unit.slots.map((slot, si) => {
        const loaded = sample[(ui + si) % 4];
        return loaded ? tray(slot.externalIdentifier ?? String(si), { materialType: loaded[0], subBrand: loaded[0], colorHex: loaded[1], remainPercent: loaded[2], empty: false }) : tray(slot.externalIdentifier ?? String(si));
      }),
    })),
  };
}
export const detectedStates: Record<string, DetectedPrinterState> = { 'm-h2d': h2dDetectedState, 'm-x1c': simulatedDetectedState('bambu_x1c') };

export const people: BillingParty[] = [
  { kind: 'person', id: 'p-lena', displayName: 'Lena Huber', pricingGroup: 'Students' },
  { kind: 'person', id: 'p-jonas', displayName: 'Jonas Pichler', pricingGroup: 'Students' },
  { kind: 'person', id: 'p-amira', displayName: 'Amira Rahman', pricingGroup: 'Staff' },
  { kind: 'person', id: 'p-tobias', displayName: 'Tobias Wagner', pricingGroup: 'External' },
  { kind: 'organization', id: 'o-racing', displayName: 'TU Graz Racing Team', pricingGroup: 'Student teams' },
  { kind: 'organization', id: 'o-robotics', displayName: 'Robotics Lab', pricingGroup: 'Institutes' },
];

export const operators: Operator[] = [
  { personId: 'u-sara', displayName: 'Sara Kofler' },
  { personId: 'u-david', displayName: 'David Mayr' },
  { personId: 'u-nina', displayName: 'Nina Berger' },
];

// Inventory seed: materials and spools are derived from the ledger below so that
// stock, spool remainders and average costs always agree with the transactions.
type MaterialSeed = Omit<Material, 'quantity' | 'avgCostPerUnit'>;
const materialSeeds: MaterialSeed[] = [
  { id: 'mat-pla-black', name: 'PLA Black', category: 'Filament', unit: 'g', active: true, color: 'Black', diameterMm: 1.75, lowStockThreshold: 1000 },
  { id: 'mat-petg-white', name: 'PETG White', category: 'Filament', unit: 'g', active: true, color: 'White', diameterMm: 1.75, lowStockThreshold: 1500 },
  { id: 'mat-asa-grey', name: 'ASA Grey', category: 'Filament', unit: 'g', active: true, color: 'Grey', diameterMm: 1.75, lowStockThreshold: 1000 },
  { id: 'mat-pla-silk-gold', name: 'PLA Silk Gold', category: 'Filament', unit: 'g', active: false, color: 'Gold', diameterMm: 1.75, lowStockThreshold: null },
  { id: 'mat-resin-clear', name: 'Clear Resin V4', category: 'Resin', unit: 'ml', active: true, color: 'Clear', diameterMm: null, lowStockThreshold: 500 },
  { id: 'mat-ply-3', name: 'Birch plywood 3 mm', category: 'Sheet', unit: 'm2', active: true, color: null, diameterMm: null, lowStockThreshold: 3 },
  { id: 'mat-mdf-6', name: 'MDF 6 mm', category: 'Sheet', unit: 'm2', active: true, color: null, diameterMm: null, lowStockThreshold: 2 },
];

/** Filament product catalog (future backend capability). Spools and fills reference it and keep manufacturer/product as snapshot text. */
export const filamentProducts: FilamentProduct[] = [
  { id: 'prod-bambu-pla-black', manufacturer: 'Bambu Lab', name: 'PLA Basic Black', materialId: 'mat-pla-black', netWeightG: 1000, defaultPrice: 19.99, packaging: 'refill', notes: 'Comes with RFID tags', active: true },
  { id: 'prod-bambu-petg-white', manufacturer: 'Bambu Lab', name: 'PETG HF White', materialId: 'mat-petg-white', netWeightG: 1000, defaultPrice: 21.99, packaging: 'refill', notes: 'Comes with RFID tags', active: true },
  { id: 'prod-bambu-asa-grey', manufacturer: 'Bambu Lab', name: 'ASA Grey', materialId: 'mat-asa-grey', netWeightG: 1000, defaultPrice: 27.99, packaging: 'spool', notes: null, active: true },
  { id: 'prod-prusament-pla-black', manufacturer: 'Prusament', name: 'PLA Galaxy Black', materialId: 'mat-pla-black', netWeightG: 1000, defaultPrice: 29.99, packaging: 'spool', notes: null, active: true },
  { id: 'prod-prusament-petg-white', manufacturer: 'Prusament', name: 'PETG Signal White', materialId: 'mat-petg-white', netWeightG: 1000, defaultPrice: 29.99, packaging: 'spool', notes: null, active: true },
  { id: 'prod-extrudr-petg-white', manufacturer: 'Extrudr', name: 'PETG Pure White', materialId: 'mat-petg-white', netWeightG: 1000, defaultPrice: 24.9, packaging: 'spool', notes: null, active: true },
  { id: 'prod-polymaker-asa-grey', manufacturer: 'Polymaker', name: 'ASA Grey', materialId: 'mat-asa-grey', netWeightG: 1000, defaultPrice: 28, packaging: 'spool', notes: null, active: true },
  { id: 'prod-fillamentum-silk-gold', manufacturer: 'Fillamentum', name: 'PLA Extrafill Silk Gold', materialId: 'mat-pla-silk-gold', netWeightG: 1000, defaultPrice: 32, packaging: 'spool', notes: 'Discontinued colour.', active: false },
];
const productIdOf = (manufacturer: string | null, name: string | null) => filamentProducts.find((item) => item.manufacturer === manufacturer && item.name === name)?.id ?? null;

type TxExtra = { price?: number; supplier?: string; note?: string; job?: string; by?: string; fill?: number };
const at = (days: number, minutes = 0) => ago(days * D + minutes);
type RawTransaction = Omit<InventoryTransaction, 'id' | 'unitCost' | 'totalValue' | 'spoolDisplayId'> & { price: number | null };
const rawTransactions: RawTransaction[] = [];
const add = (kind: InventoryTransactionKind, materialId: string, spoolId: string | null, quantity: number, occurredAt: string, extra: TxExtra = {}) => {
  rawTransactions.push({
    materialId, spoolId, fillNumber: extra.fill ?? null, kind, quantity, occurredAt, jobId: extra.job ?? null, supplier: extra.supplier ?? null, note: extra.note ?? null,
    by: extra.by ?? 'Sara Kofler', price: extra.price ?? null,
  });
};
const FW = 'Filamentwerk GmbH';

// Earlier deliveries that fed the historic fills of the reusable spools (prices keep the average cost per kg).
add('purchase', 'mat-pla-black', null, 5000, at(200), { price: 100, supplier: FW, note: 'Earlier delivery' });
add('purchase', 'mat-petg-white', null, 3000, at(200), { price: 68.1, supplier: FW, note: 'Earlier delivery' });
add('purchase', 'mat-asa-grey', null, 1000, at(200), { price: 28, supplier: FW, note: 'Earlier delivery' });

type Tag = [IdentifierKind, string];
type HistoricFill = {
  spool: string; fill: number; material: string; manufacturer: string; product: string; from: number; to: number; used: number; leftover: number;
  outcome: LeftoverOutcome; tags: Tag[]; ledger?: boolean; boughtFor?: number;
};
const HF: HistoricFill[] = [
  { spool: 'sp-0141', fill: 1, material: 'mat-petg-white', manufacturer: 'Extrudr', product: 'PETG Pure White', from: 170, to: 122, used: 940, leftover: 60, outcome: 'returned_to_stock', tags: [['nfc', '04:11:5A:C3:2D:90:44']] },
  { spool: 'sp-0141', fill: 2, material: 'mat-pla-black', manufacturer: 'Prusament', product: 'PLA Galaxy Black', from: 121, to: 62, used: 968, leftover: 32, outcome: 'disposed', tags: [['nfc', '04:3D:E0:72:A8:15:9B'], ['barcode', '8594173690124']] },
  { spool: 'sp-0152', fill: 1, material: 'mat-pla-black', manufacturer: 'Prusament', product: 'PLA Galaxy Black', from: 210, to: 165, used: 1000, leftover: 0, outcome: 'used_up', tags: [['nfc', '04:9A:67:0B:F2:3C:18']] },
  { spool: 'sp-0152', fill: 2, material: 'mat-petg-white', manufacturer: 'Extrudr', product: 'PETG Pure White', from: 164, to: 120, used: 930, leftover: 70, outcome: 'returned_to_stock', tags: [['nfc', '04:C4:21:8E:55:D0:7A']] },
  { spool: 'sp-0152', fill: 3, material: 'mat-pla-black', manufacturer: 'Prusament', product: 'PLA Galaxy Black', from: 119, to: 59, used: 910, leftover: 90, outcome: 'disposed', tags: [['nfc', '04:E7:B3:44:19:6F:A2']] },
  { spool: 'sp-0163', fill: 1, material: 'mat-asa-grey', manufacturer: 'Polymaker', product: 'ASA Grey', from: 180, to: 100, used: 700, leftover: 300, outcome: 'returned_to_stock', tags: [['nfc', '04:28:D1:F6:0C:83:5E']] },
  { spool: 'sp-0163', fill: 2, material: 'mat-pla-black', manufacturer: 'Bambu Lab', product: 'PLA Basic Black', from: 99, to: 46, used: 1000, leftover: 0, outcome: 'used_up', tags: [['nfc', '04:F0:5B:9C:37:E4:21']] },
  { spool: 'sp-0207', fill: 1, material: 'mat-pla-black', manufacturer: 'Bambu Lab', product: 'PLA Basic Black', from: 150, to: 95, used: 910, leftover: 90, outcome: 'disposed', tags: [['nfc', '04:6B:A0:D8:32:7C:F5']] },
  { spool: 'sp-0207', fill: 2, material: 'mat-petg-white', manufacturer: 'Bambu Lab', product: 'PETG HF White', from: 94, to: 38, used: 760, leftover: 240, outcome: 'returned_to_stock', tags: [['nfc', '04:5C:9E:21:B7:03:6A']] },
  // Single-use spools that were finished and archived long ago (cleanup candidates). Their ledger entries are written below.
  { spool: 'sp-0098', fill: 1, material: 'mat-pla-black', manufacturer: 'Prusament', product: 'PLA Galaxy Black', from: 380, to: 332, used: 900, leftover: 100, outcome: 'disposed', tags: [['barcode', '8594173690001']], boughtFor: 20 },
  { spool: 'sp-0105', fill: 1, material: 'mat-asa-grey', manufacturer: 'Polymaker', product: 'ASA Grey', from: 300, to: 277, used: 850, leftover: 150, outcome: 'disposed', tags: [['barcode', '8594173690002']], boughtFor: 28 },
  { spool: 'sp-0120', fill: 1, material: 'mat-pla-silk-gold', manufacturer: 'Fillamentum', product: 'PLA Extrafill Silk Gold', from: 300, to: 245, used: 750, leftover: 250, outcome: 'returned_to_stock', tags: [['barcode', '8594173690551']], ledger: false },
  { spool: 'sp-0155', fill: 1, material: 'mat-petg-white', manufacturer: 'Extrudr', product: 'PETG Pure White', from: 188, to: 152, used: 960, leftover: 40, outcome: 'disposed', tags: [], ledger: false },
];
for (const f of HF.filter((item) => item.ledger !== false)) {
  const common = { fill: f.fill };
  if (f.boughtFor != null) add('purchase', f.material, f.spool, 1000, at(f.from), { ...common, price: f.boughtFor, supplier: FW, note: 'Single spool' });
  else add('transfer', f.material, f.spool, 1000, at(f.from), { ...common, note: `Fill ${f.fill} taken from loose stock` });
  add('consumption', f.material, f.spool, -f.used, at(Math.round((f.from + f.to) / 2)), { ...common, note: 'Prints reported by the printer', by: 'System' });
  if (f.leftover > 0 && f.outcome === 'returned_to_stock') add('transfer', f.material, f.spool, -f.leftover, at(f.to), { ...common, note: `Fill ${f.fill} leftover returned to loose stock` });
  if (f.leftover > 0 && f.outcome === 'disposed') add('disposal', f.material, f.spool, -f.leftover, at(f.to), { ...common, note: `Fill ${f.fill} leftover disposed`, by: 'David Mayr' });
}

// PLA Black
add('purchase', 'mat-pla-black', null, 5000, at(60), { price: 100, supplier: FW, note: 'Opening stock, 5 spools of 1 kg' });
add('transfer', 'mat-pla-black', 'sp-0141', 1000, at(55), { note: 'Spool registered from loose stock' });
add('consumption', 'mat-pla-black', 'sp-0141', -229, at(30), { note: 'Prints reported by Prusa MK4 #1', by: 'System' });
add('consumption', 'mat-pla-black', null, -420, at(50), { note: 'Course: introduction to 3D printing', by: 'David Mayr' });
add('transfer', 'mat-pla-black', 'sp-0160', 1000, at(20), { note: 'Spool registered from loose stock' });
add('correction', 'mat-pla-black', null, -85, at(12), { note: 'Physical count was lower than the ledger', by: 'David Mayr' });
add('purchase', 'mat-pla-black', null, 2000, at(14), { price: 40, supplier: FW, note: 'Restock' });
add('consumption', 'mat-pla-black', 'sp-0141', -142, at(1, -60), { job: 'j-1089', note: 'Reported by Prusa MK4 #1', by: 'System' });
add('consumption', 'mat-pla-black', 'sp-0141', -17, ago(245), { note: 'Failed print (filament runout)', by: 'System' });

// PETG White
add('purchase', 'mat-petg-white', null, 4000, at(58), { price: 88, supplier: FW, note: 'Opening stock, 4 spools of 1 kg' });
add('transfer', 'mat-petg-white', 'sp-0155', 1000, at(188), { note: 'Spool registered from loose stock' });
add('consumption', 'mat-petg-white', 'sp-0155', -640, at(180), { note: 'Semester project prints', by: 'Nina Berger' });
add('transfer', 'mat-petg-white', 'sp-0152', 1000, at(44), { note: 'Spool registered from loose stock' });
add('consumption', 'mat-petg-white', 'sp-0155', -320, at(170), { note: 'Prints reported by Prusa MK4 #2', by: 'System' });
add('disposal', 'mat-petg-white', 'sp-0155', -40, at(152), { note: 'Finished: remnant discarded', by: 'David Mayr' });
add('consumption', 'mat-petg-white', null, -380, at(41), { note: 'Student team enclosure panels', by: 'Sara Kofler' });
add('purchase', 'mat-petg-white', null, 2000, at(17), { price: 46, supplier: FW, note: 'Restock' });
add('purchase', 'mat-petg-white', 'sp-0170', 1000, at(10), { price: 24.9, supplier: 'Extrudr Austria', note: 'Single spool, INV-4411' });
add('consumption', 'mat-petg-white', 'sp-0152', -55, at(6), { note: 'Cable clips', by: 'System' });
add('consumption', 'mat-petg-white', null, -210, at(5, -200), { job: 'j-1084', note: 'Reported by Prusa MK4 #1', by: 'System' });
add('consumption', 'mat-petg-white', 'sp-0152', -61, ago(4), { note: 'Reported by Prusa MK4 #2', by: 'System' });

// ASA Grey
add('purchase', 'mat-asa-grey', null, 2000, at(45), { price: 56, supplier: FW, note: 'Two spools of 1 kg' });
add('transfer', 'mat-asa-grey', 'sp-0163', 1000, at(44), { note: 'Spool registered from loose stock' });
add('consumption', 'mat-asa-grey', 'sp-0163', -721, at(25), { note: 'Prints reported by Bambu X1C', by: 'System' });
add('consumption', 'mat-asa-grey', null, -420, at(22), { note: 'Drone frame brackets', by: 'Nina Berger' });
add('consumption', 'mat-asa-grey', 'sp-0163', -96, at(1, 180), { job: 'j-1088', note: 'Reported by Bambu X1C', by: 'System' });
add('consumption', 'mat-asa-grey', 'sp-0163', -38, ago(180), { note: 'Reported by Bambu X1C', by: 'System' });

// PLA Silk Gold (inactive)
add('purchase', 'mat-pla-silk-gold', null, 1000, at(305), { price: 32, supplier: FW, note: 'Trial spool' });
add('transfer', 'mat-pla-silk-gold', 'sp-0120', 1000, at(300), { note: 'Spool registered from loose stock' });
add('consumption', 'mat-pla-silk-gold', 'sp-0120', -750, at(280), { note: 'Open day displays', by: 'Nina Berger' });
add('transfer', 'mat-pla-silk-gold', 'sp-0120', -250, at(245), { note: 'Finished: leftover returned to loose stock' });

// Clear Resin
add('purchase', 'mat-resin-clear', null, 2000, at(50), { price: 190, supplier: 'Formlabs Reseller AT', note: 'Two 1 l cartridges' });
add('consumption', 'mat-resin-clear', null, -310, at(36), { note: 'Lens prototypes', by: 'Nina Berger' });
add('consumption', 'mat-resin-clear', null, -120, at(11), { note: 'Jewellery casting masters', by: 'Nina Berger' });
add('consumption', 'mat-resin-clear', null, -54, at(4, -300), { job: 'j-1085', note: 'Clear lens prototypes', by: 'Nina Berger' });

// Birch plywood 3 mm
add('purchase', 'mat-ply-3', null, 20, at(58), { price: 142, supplier: 'Holzland Graz', note: '20 sheets of 1 m²' });
add('consumption', 'mat-ply-3', null, -2.5, at(44), { note: 'Laser workshop', by: 'David Mayr' });
add('consumption', 'mat-ply-3', null, -4.9, at(35), { note: 'Student team templates', by: 'David Mayr' });
add('purchase', 'mat-ply-3', null, 10, at(18), { price: 72, supplier: 'Holzland Graz', note: 'Restock' });
add('consumption', 'mat-ply-3', null, -2.2, at(13), { note: 'Laser workshop', by: 'David Mayr' });
add('disposal', 'mat-ply-3', null, -0.6, at(9), { note: 'Warped sheet discarded', by: 'David Mayr' });
add('consumption', 'mat-ply-3', null, -0.4, at(6, -20), { job: 'j-1083', note: 'Birthday card cut-outs', by: 'David Mayr' });
add('consumption', 'mat-ply-3', null, -1.2, at(0, 335), { job: 'j-1090', note: 'Wing endplate templates', by: 'David Mayr' });

// MDF 6 mm
add('purchase', 'mat-mdf-6', null, 8, at(56), { price: 41.6, supplier: 'Holzland Graz', note: '8 sheets of 1 m²' });
add('consumption', 'mat-mdf-6', null, -3.4, at(40), { note: 'CNC fixtures', by: 'David Mayr' });
add('consumption', 'mat-mdf-6', null, -2.7, at(22), { note: 'CNC fixtures', by: 'David Mayr' });
add('consumption', 'mat-mdf-6', null, -0.9, at(7), { note: 'Prototype enclosure', by: 'David Mayr' });
add('consumption', 'mat-mdf-6', null, -0.3, at(3, -150), { job: 'j-1086', note: 'Router jig (cancelled)', by: 'David Mayr' });
add('consumption', 'mat-mdf-6', null, -0.2, ago(40), { job: 'j-1093', note: 'Workshop name plates', by: 'David Mayr' });
add('disposal', 'mat-mdf-6', null, -0.5, at(2), { note: 'Offcuts too small to use', by: 'David Mayr' });

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits + 0;

export const materials: Material[] = materialSeeds.map((seed) => {
  const own = rawTransactions.filter((tx) => tx.materialId === seed.id);
  const bought = own.filter((tx) => tx.kind === 'purchase' && tx.price != null);
  const boughtQuantity = bought.reduce((sum, tx) => sum + tx.quantity, 0);
  return {
    ...seed,
    quantity: round(own.filter((tx) => tx.kind !== 'transfer').reduce((sum, tx) => sum + tx.quantity, 0), 3),
    avgCostPerUnit: boughtQuantity > 0 ? round(bought.reduce((sum, tx) => sum + (tx.price ?? 0), 0) / boughtQuantity, 5) : null,
  };
});

const currentFill: Record<string, number> = { 'sp-0120': 1, 'sp-0141': 3, 'sp-0152': 4, 'sp-0155': 1, 'sp-0160': 1, 'sp-0163': 3, 'sp-0170': 1, 'sp-0098': 1, 'sp-0105': 1, 'sp-0207': 2 };
const displayIdOf = (spoolId: string | null) => spoolId ? spoolId.toUpperCase() : null;

/** Oldest first; ids are stable so the ledger can be keyed. */
export const inventoryTransactions: InventoryTransaction[] = [...rawTransactions]
  .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  .map(({ price, ...tx }, index) => {
    const average = materials.find((material) => material.id === tx.materialId)?.avgCostPerUnit ?? null;
    const unitCost = tx.kind === 'purchase' ? (price != null ? round(price / tx.quantity, 5) : null) : tx.kind === 'transfer' ? null : average;
    const totalValue = tx.kind === 'purchase' ? price : unitCost != null && tx.kind !== 'transfer' ? round(unitCost * tx.quantity, 2) : null;
    return {
      ...tx, id: `tx-${String(index + 1).padStart(3, '0')}`, unitCost, totalValue,
      spoolDisplayId: displayIdOf(tx.spoolId), fillNumber: tx.spoolId ? tx.fillNumber ?? currentFill[tx.spoolId] ?? null : null,
    };
  });

type SpoolSeed = Omit<Spool, 'remainingQuantity' | 'productId'>;
const day = (days: number) => at(days).slice(0, 10);
const materialName = (id: string) => materialSeeds.find((item) => item.id === id)?.name ?? id;
const tagsOf = (spool: string, fill: number, tags: Tag[]) => tags.map(([kind, value], index) => ({ id: `id-${spool}-f${fill}-${index}`, kind, value, addedAt: at(0) }));
const fillsOf = (spool: string): SpoolFill[] => HF.filter((item) => item.spool === spool).map((f) => ({
  id: `${spool}-fill-${f.fill}`, fillNumber: f.fill, materialId: f.material, materialName: materialName(f.material), productId: productIdOf(f.manufacturer, f.product), manufacturer: f.manufacturer, productName: f.product,
  initialNetWeightG: 1000, usedG: f.used, leftoverG: f.leftover, leftoverOutcome: f.outcome, filledAt: at(f.from), closedAt: at(f.to),
  identifiers: tagsOf(spool, f.fill, f.tags).map((tag) => ({ ...tag, addedAt: at(f.from) })),
}));
const closedSingle = { kind: 'single_use', label: null, mounted: false, initialNetWeightG: 1000, lifecycle: 'archived' } as const;
const spoolSeeds: SpoolSeed[] = [
  { ...closedSingle, id: 'sp-0098', displayId: 'SP-0098', fillNumber: 1, filledAt: at(380), fills: fillsOf('sp-0098'), archivedAt: at(332), materialId: 'mat-pla-black', materialName: 'PLA Black', color: 'Black', tareWeightG: 230, manufacturer: 'Prusament', productName: 'PLA Galaxy Black', storageLocation: null, acquiredOn: day(380), acquisitionReference: 'INV-2877', purchasePrice: 20, notes: null, identifiers: [{ id: 'id-098a', kind: 'barcode', value: '8594173690001', addedAt: at(380) }] },
  { ...closedSingle, id: 'sp-0105', displayId: 'SP-0105', fillNumber: 1, filledAt: at(300), fills: fillsOf('sp-0105'), archivedAt: at(277), materialId: 'mat-asa-grey', materialName: 'ASA Grey', color: 'Grey', tareWeightG: 250, manufacturer: 'Polymaker', productName: 'ASA Grey', storageLocation: null, acquiredOn: day(300), acquisitionReference: 'INV-3120', purchasePrice: 28, notes: null, identifiers: [{ id: 'id-105a', kind: 'barcode', value: '8594173690002', addedAt: at(300) }] },
  { ...closedSingle, id: 'sp-0120', displayId: 'SP-0120', fillNumber: 1, filledAt: at(300), fills: fillsOf('sp-0120'), archivedAt: at(244), materialId: 'mat-pla-silk-gold', materialName: 'PLA Silk Gold', color: 'Gold', tareWeightG: 215, manufacturer: 'Fillamentum', productName: 'PLA Extrafill Silk Gold', storageLocation: 'Archive box', acquiredOn: day(305), acquisitionReference: 'INV-3987', purchasePrice: null, notes: 'Discontinued colour.', identifiers: [{ id: 'id-120a', kind: 'barcode', value: '8594173690551', addedAt: at(300) }] },
  { id: 'sp-0141', displayId: 'SP-0141', kind: 'reusable', label: 'Prusa spool 01', fillNumber: 3, filledAt: at(55), fills: fillsOf('sp-0141'), archivedAt: null, materialId: 'mat-pla-black', materialName: 'PLA Black', color: 'Black', mounted: true, initialNetWeightG: 1000, tareWeightG: 230, manufacturer: 'Prusament', productName: 'PLA Galaxy Black', storageLocation: 'Printer', lifecycle: 'active', acquiredOn: day(210), acquisitionReference: 'INV-3411', purchasePrice: null, notes: null, identifiers: [{ id: 'id-141a', kind: 'nfc', value: '04:A2:3B:19:7C:5E:80', addedAt: at(55) }, { id: 'id-141b', kind: 'barcode', value: '8594173690124', addedAt: at(55) }] },
  { id: 'sp-0152', displayId: 'SP-0152', kind: 'reusable', label: 'Prusa spool 02', fillNumber: 4, filledAt: at(44), fills: fillsOf('sp-0152'), archivedAt: null, materialId: 'mat-petg-white', materialName: 'PETG White', color: 'White', mounted: true, initialNetWeightG: 1000, tareWeightG: 245, manufacturer: 'Extrudr', productName: 'PETG Pure White', storageLocation: 'Printer', lifecycle: 'active', acquiredOn: day(210), acquisitionReference: 'INV-3412', purchasePrice: null, notes: null, identifiers: [{ id: 'id-152a', kind: 'barcode', value: '9120098765432', addedAt: at(44) }] },
  { ...closedSingle, id: 'sp-0155', displayId: 'SP-0155', fillNumber: 1, filledAt: at(188), fills: fillsOf('sp-0155'), archivedAt: at(152), materialId: 'mat-petg-white', materialName: 'PETG White', color: 'White', tareWeightG: 245, manufacturer: 'Extrudr', productName: 'PETG Pure White', storageLocation: 'Recycling shelf', acquiredOn: day(190), acquisitionReference: 'INV-3991', purchasePrice: null, notes: null, identifiers: [] },
  { id: 'sp-0160', displayId: 'SP-0160', kind: 'single_use', label: null, fillNumber: 1, filledAt: at(20), fills: [], archivedAt: null, materialId: 'mat-pla-black', materialName: 'PLA Black', color: 'Black', mounted: true, initialNetWeightG: 1000, tareWeightG: 230, manufacturer: 'Prusament', productName: 'PLA Galaxy Black', storageLocation: 'Shelf A2', lifecycle: 'active', acquiredOn: day(20), acquisitionReference: 'INV-4102', purchasePrice: null, notes: null, identifiers: [{ id: 'id-160a', kind: 'nfc', value: '04:7F:11:C2:90:3A:61', addedAt: at(20) }] },
  { id: 'sp-0163', displayId: 'SP-0163', kind: 'reusable', label: 'Bambu spool 03', fillNumber: 3, filledAt: at(44), fills: fillsOf('sp-0163'), archivedAt: null, materialId: 'mat-asa-grey', materialName: 'ASA Grey', color: 'Grey', mounted: true, initialNetWeightG: 1000, tareWeightG: 250, manufacturer: 'Polymaker', productName: 'ASA Grey', storageLocation: 'Printer', lifecycle: 'active', acquiredOn: day(180), acquisitionReference: 'INV-3702', purchasePrice: null, notes: 'Running low; reorder planned.', identifiers: [{ id: 'id-163a', kind: 'nfc', value: '04:B8:5D:2E:44:19:CC', addedAt: at(44) }] },
  { id: 'sp-0170', displayId: 'SP-0170', kind: 'single_use', label: null, fillNumber: 1, filledAt: at(10), fills: [], archivedAt: null, materialId: 'mat-petg-white', materialName: 'PETG White', color: 'White', mounted: true, initialNetWeightG: 1000, tareWeightG: 245, manufacturer: 'Extrudr', productName: 'PETG Pure White', storageLocation: 'Shelf B1', lifecycle: 'active', acquiredOn: day(10), acquisitionReference: 'INV-4411', purchasePrice: 24.9, notes: null, identifiers: [{ id: 'id-170a', kind: 'barcode', value: '9120098765449', addedAt: at(10) }] },
  { id: 'sp-0207', displayId: 'SP-0207', kind: 'reusable', label: 'Bambu spool 07', fillNumber: 2, filledAt: null, fills: fillsOf('sp-0207'), archivedAt: null, materialId: '', materialName: '', color: '', mounted: false, initialNetWeightG: 0, tareWeightG: 250, manufacturer: null, productName: null, storageLocation: 'AMS shelf', lifecycle: 'empty', acquiredOn: day(150), acquisitionReference: null, purchasePrice: null, notes: 'Old NFC tag is still on the spool.', identifiers: [{ id: 'id-207a', kind: 'nfc', value: '04:5C:9E:21:B7:03:6A', addedAt: at(94) }] },
];

export const spools: Spool[] = spoolSeeds.map((seed) => ({
  ...seed,
  productId: productIdOf(seed.manufacturer, seed.productName),
  remainingQuantity: round(rawTransactions.filter((tx) => tx.spoolId === seed.id && (tx.fillNumber ?? currentFill[seed.id]) === seed.fillNumber).reduce((sum, tx) => sum + tx.quantity, 0), 3),
}));

const snapshot = (group: string, capturedAt: string, extra: Partial<{ revision: number; reason: 'initial' | 'customer_changed' }> = {}) => ({
  revision: extra.revision ?? 1,
  pricingGroupName: group,
  reason: extra.reason ?? 'initial',
  capturedAt,
  rules: [
    { label: 'Machine time', rate: group === 'External' ? '6.00' : '2.00', unit: 'h', missing: false },
    { label: 'Filament', rate: group === 'External' ? '0.08' : '0.04', unit: 'g', missing: false },
  ],
});

const [lena, jonas, amira, tobias, racing, robotics] = people;
const [sara, david, nina] = operators;

export const jobs: Job[] = [
  { id: 'j-1095', displayId: 'J-1095', title: 'Pen holders for Tobias', machineId: 'm-mk4-2', startsAt: ago(30), endsAt: ago(-150), durationSeconds: 10800, run: 'manual', printId: null, source: 'manual', externalId: null, customer: tobias, operator: sara, outcome: 'unknown', notes: 'Printer not reporting; started by hand.',
    usages: [{ id: 'u12', ownership: 'makerspace', materialId: 'mat-petg-white', spoolId: 'sp-0152', spoolDisplayId: 'SP-0152', materialName: 'PETG White', category: 'Filament', unit: 'g', quantity: 150, quantityBasis: 'estimated' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('External', ago(30)), calculatedPrice: 30, priceAdjustment: null, order: null, version: 1 },
  { id: 'j-1094', displayId: 'J-1094', title: 'Acrylic door signs', machineId: 'm-laser', startsAt: ago(20), endsAt: ago(-25), durationSeconds: 2700, run: 'manual', printId: null, source: 'manual', externalId: null, customer: amira, operator: david, outcome: 'unknown', notes: 'Acrylic signage, single pass.',
    usages: [{ id: 'u13', ownership: 'makerspace', materialId: 'mat-ply-3', spoolId: null, spoolDisplayId: null, materialName: 'Birch plywood 3 mm', category: 'Sheet', unit: 'm2', quantity: 0.5, quantityBasis: 'estimated' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Staff', ago(20)), calculatedPrice: 7.5, priceAdjustment: null, order: null, version: 1 },
  { id: 'j-1093', displayId: 'J-1093', title: 'Workshop name plates', machineId: 'm-cnc', startsAt: ago(2 * H + 10), endsAt: ago(40), durationSeconds: 5400, run: 'manual', printId: null, source: 'manual', externalId: null, customer: lena, operator: david, outcome: 'unknown', notes: 'Engraved name plates, two passes.',
    usages: [{ id: 'u-1093', ownership: 'makerspace', materialId: 'mat-mdf-6', spoolId: null, spoolDisplayId: null, materialName: 'MDF 6 mm', category: 'Sheet', unit: 'm2', quantity: 0.2, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Students', ago(2 * H + 10)), calculatedPrice: 5.4, priceAdjustment: null, order: null, version: 1 },
  { id: 'j-1090', displayId: 'J-1090', title: 'Wing endplate templates', machineId: 'm-laser', startsAt: ago(6 * H), endsAt: ago(5 * H + 35), durationSeconds: 1500, run: 'manual', printId: null, source: 'manual', externalId: null, customer: racing, operator: david, outcome: 'successful', notes: 'Wing endplate templates, 4 sheets.',
    usages: [{ id: 'u4', ownership: 'makerspace', materialId: 'mat-ply-3', spoolId: null, spoolDisplayId: null, materialName: 'Birch plywood 3 mm', category: 'Sheet', unit: 'm2', quantity: 1.2, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Student teams', ago(5 * H + 30)), calculatedPrice: 14.4, priceAdjustment: { kind: 'discount_percent', value: 20, reason: 'Student team sponsorship agreement.' }, order: null, version: 2 },
  { id: 'j-1089', displayId: 'J-1089', title: null, machineId: 'm-mk4-1', startsAt: ago(1 * D + 2 * H), endsAt: ago(1 * D - 1 * H), durationSeconds: 10800, run: 'automatic', printId: 'pr-301', source: 'automatic', externalId: 'prusa-55101', customer: lena, operator: sara, outcome: 'successful', notes: null,
    usages: [{ id: 'u5', ownership: 'makerspace', materialId: 'mat-pla-black', spoolId: 'sp-0141', spoolDisplayId: 'SP-0141', materialName: 'PLA Black', category: 'Filament', unit: 'g', quantity: 142, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Students', ago(1 * D - 1 * H)), calculatedPrice: 11.68, priceAdjustment: null, order: { orderId: 'ord-2201', orderReference: 'ORD-2201', sourceChanged: false }, version: 3 },
  { id: 'j-1088', displayId: 'J-1088', title: null, machineId: 'm-x1c', startsAt: ago(1 * D + 5 * H), endsAt: ago(1 * D + 3 * H), durationSeconds: 7200, run: 'automatic', printId: 'pr-300', source: 'automatic', externalId: 'bambu-88190', customer: robotics, operator: nina, outcome: 'partial_failure', notes: 'Two of six brackets detached from the plate.',
    usages: [{ id: 'u6', ownership: 'makerspace', materialId: 'mat-asa-grey', spoolId: 'sp-0163', spoolDisplayId: 'SP-0163', materialName: 'ASA Grey', category: 'Filament', unit: 'g', quantity: 96, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Institutes', ago(1 * D + 3 * H)), calculatedPrice: 7.84, priceAdjustment: { kind: 'multiplier', value: 0.67, reason: 'Four of six brackets usable; charged for those only.' }, order: null, version: 4 },
  { id: 'j-1087', displayId: 'J-1087', title: 'TPU phone bumpers', machineId: 'm-mk4-2', startsAt: ago(2 * D), endsAt: ago(2 * D - 90), durationSeconds: 5400, run: 'manual', printId: null, source: 'manual', externalId: null, customer: tobias, operator: sara, outcome: 'successful', notes: null,
    usages: [{ id: 'u7', ownership: 'external', materialId: null, spoolId: null, spoolDisplayId: null, materialName: 'Customer TPU (own spool)', category: 'Filament', unit: 'g', quantity: 80, quantityBasis: 'estimated' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('External', ago(2 * D - 90)), calculatedPrice: 9, priceAdjustment: null, order: { orderId: 'ord-2198', orderReference: 'ORD-2198', sourceChanged: false }, version: 2 },
  { id: 'j-1086', displayId: 'J-1086', title: 'Router jig', machineId: 'm-cnc', startsAt: ago(3 * D), endsAt: ago(3 * D - 150), durationSeconds: 9000, run: 'manual', printId: null, source: 'manual', externalId: null, customer: jonas, operator: david, outcome: 'cancelled', notes: 'Stopped: wrong stock thickness. Re-scheduled.',
    usages: [{ id: 'u8', ownership: 'makerspace', materialId: 'mat-mdf-6', spoolId: null, spoolDisplayId: null, materialName: 'MDF 6 mm', category: 'Sheet', unit: 'm2', quantity: 0.3, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Students', ago(3 * D - 150)), calculatedPrice: 5, priceAdjustment: { kind: 'fixed', value: 0, reason: 'Cancelled before cutting; no charge.' }, order: null, version: 3 },
  { id: 'j-1085', displayId: 'J-1085', title: 'Clear lens prototypes', machineId: 'm-form3', startsAt: ago(4 * D), endsAt: ago(4 * D - 300), durationSeconds: 18000, run: 'manual', printId: null, source: 'manual', externalId: null, customer: amira, operator: nina, outcome: 'successful', notes: null,
    usages: [{ id: 'u9', ownership: 'makerspace', materialId: 'mat-resin-clear', spoolId: null, spoolDisplayId: null, materialName: 'Clear Resin V4', category: 'Resin', unit: 'ml', quantity: 54, quantityBasis: 'actual' }],
    pricingStatus: 'incomplete', pricingSnapshot: { ...snapshot('Staff', ago(4 * D - 300)), rules: [{ label: 'Machine time', rate: '2.00', unit: 'h', missing: false }, { label: 'Resin', rate: '—', unit: 'ml', missing: true }] }, calculatedPrice: null, priceAdjustment: null, order: null, version: 2 },
  { id: 'j-1084', displayId: 'J-1084', title: null, machineId: 'm-mk4-1', startsAt: ago(5 * D), endsAt: ago(5 * D - 200), durationSeconds: 12000, run: 'automatic', printId: 'pr-284', source: 'automatic', externalId: 'prusa-55043', customer: racing, operator: sara, outcome: 'successful', notes: null,
    usages: [{ id: 'u10', ownership: 'makerspace', materialId: 'mat-petg-white', spoolId: null, spoolDisplayId: null, materialName: 'PETG White', category: 'Filament', unit: 'g', quantity: 210, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Student teams', ago(5 * D - 200), { revision: 2, reason: 'customer_changed' }), calculatedPrice: 15.07, priceAdjustment: null, order: { orderId: 'ord-2187', orderReference: 'ORD-2187', sourceChanged: true }, version: 5 },
  { id: 'j-1083', displayId: 'J-1083', title: 'Birthday card cut-outs', machineId: 'm-laser', startsAt: ago(6 * D), endsAt: ago(6 * D - 20), durationSeconds: 1200, run: 'manual', printId: null, source: 'manual', externalId: null, customer: lena, operator: david, outcome: 'successful', notes: null,
    usages: [{ id: 'u11', ownership: 'makerspace', materialId: 'mat-ply-3', spoolId: null, spoolDisplayId: null, materialName: 'Birch plywood 3 mm', category: 'Sheet', unit: 'm2', quantity: 0.4, quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot: snapshot('Students', ago(6 * D - 20)), calculatedPrice: 4.8, priceAdjustment: null, order: { orderId: 'ord-2180', orderReference: 'ORD-2180', sourceChanged: false }, version: 2 },
];

const usage = (materialId: string, materialName: string, spoolDisplayId: string | null, quantity: number) => ({ materialId, materialName, spoolDisplayId, quantity, unit: 'g' });

export const prints: Print[] = [
  { id: 'pr-311', displayId: 'PR-2026-000311', machineId: 'm-mk4-1', fileName: 'gearbox_housing_v3.gcode', state: 'printing', startedAt: ago(95), endedAt: null, estimatedEndAt: ago(-50), progress: 64,
    reportedUsage: usage('mat-pla-black', 'PLA Black', 'SP-0141', 118), linkedJobId: null, connectorName: 'Workshop Pi',
    events: [
      { id: 'e1', kind: 'operational_state', occurredAt: ago(95), sourceId: 'workshop-pi', summary: 'Printer state: PRINTING' },
      { id: 'e2', kind: 'progress', occurredAt: ago(2), sourceId: 'workshop-pi', summary: 'Progress 64 % · 50 min remaining' },
    ] },
  { id: 'pr-310', displayId: 'PR-2026-000310', machineId: 'm-x1c', fileName: 'drone_arm_bracket.3mf', state: 'finished', startedAt: ago(3 * H + 40), endedAt: ago(3 * H), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-asa-grey', 'ASA Grey', 'SP-0163', 38), linkedJobId: null, connectorName: 'Workshop Pi',
    events: [
      { id: 'e3', kind: 'terminal_outcome', occurredAt: ago(3 * H), sourceId: 'workshop-pi', summary: 'Print finished' },
      { id: 'e4', kind: 'consumption_report', occurredAt: ago(3 * H), sourceId: 'workshop-pi', summary: 'Reported 38 g ASA Grey from SP-0163' },
    ] },
  // Overlaps the manual run J-1095 on the same printer, so linking with replace can be demonstrated.
  { id: 'pr-309', displayId: 'PR-2026-000309', machineId: 'm-mk4-2', fileName: 'cable_clips_x12.gcode', state: 'finished', startedAt: ago(34), endedAt: ago(4), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-petg-white', 'PETG White', 'SP-0152', 61), linkedJobId: null, connectorName: 'Workshop Pi',
    events: [
      { id: 'e5', kind: 'terminal_outcome', occurredAt: ago(4), sourceId: 'workshop-pi', summary: 'Print finished' },
      { id: 'e6', kind: 'consumption_report', occurredAt: ago(4), sourceId: 'workshop-pi', summary: 'Reported 61 g PETG White from SP-0152' },
    ] },
  { id: 'pr-308', displayId: 'PR-2026-000308', machineId: 'm-mk4-1', fileName: 'phone_stand_v2.gcode', state: 'failed', startedAt: ago(5 * H), endedAt: ago(4 * H + 5), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-pla-black', 'PLA Black', 'SP-0141', 17), linkedJobId: null, connectorName: 'Workshop Pi',
    events: [
      { id: 'e7', kind: 'terminal_outcome', occurredAt: ago(4 * H + 5), sourceId: 'workshop-pi', summary: 'Print failed: filament runout' },
    ] },
  { id: 'pr-301', displayId: 'PR-2026-000301', machineId: 'm-mk4-1', fileName: 'nameplates_door_set.gcode', state: 'finished', startedAt: ago(1 * D + 2 * H), endedAt: ago(1 * D - 1 * H), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-pla-black', 'PLA Black', 'SP-0141', 142), linkedJobId: 'j-1089', connectorName: 'Workshop Pi',
    events: [{ id: 'e8', kind: 'terminal_outcome', occurredAt: ago(1 * D - 1 * H), sourceId: 'workshop-pi', summary: 'Print finished' }] },
  { id: 'pr-300', displayId: 'PR-2026-000300', machineId: 'm-x1c', fileName: 'drone_brackets_x6.3mf', state: 'finished', startedAt: ago(1 * D + 5 * H), endedAt: ago(1 * D + 3 * H), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-asa-grey', 'ASA Grey', 'SP-0163', 96), linkedJobId: 'j-1088', connectorName: 'Workshop Pi',
    events: [{ id: 'e9', kind: 'terminal_outcome', occurredAt: ago(1 * D + 3 * H), sourceId: 'workshop-pi', summary: 'Print finished' }] },
  { id: 'pr-284', displayId: 'PR-2026-000284', machineId: 'm-mk4-1', fileName: 'team_logo_plate.gcode', state: 'finished', startedAt: ago(5 * D), endedAt: ago(5 * D - 200), estimatedEndAt: null, progress: null,
    reportedUsage: usage('mat-petg-white', 'PETG White', null, 210), linkedJobId: 'j-1084', connectorName: 'Workshop Pi',
    events: [{ id: 'e10', kind: 'terminal_outcome', occurredAt: ago(5 * D - 200), sourceId: 'workshop-pi', summary: 'Print finished' }] },
];

export const printerProfiles: PrinterProfile[] = [
  { machineId: 'm-mk4-1', enabled: true, inputUnits: [{ id: 'iu-1', machineId: 'm-mk4-1', name: 'Direct feed', position: 0, externalIdentifier: null, nozzle: null }], slots: [{ id: 'sl-1', inputUnitId: 'iu-1', name: 'Extruder', position: 0, status: 'available', spoolId: 'sp-0141', externalIdentifier: null }] },
  { machineId: 'm-mk4-2', enabled: true, inputUnits: [{ id: 'iu-2', machineId: 'm-mk4-2', name: 'Direct feed', position: 0, externalIdentifier: null, nozzle: null }], slots: [{ id: 'sl-2', inputUnitId: 'iu-2', name: 'Extruder', position: 0, status: 'available', spoolId: 'sp-0152', externalIdentifier: null }] },
  { machineId: 'm-x1c', enabled: true, inputUnits: [{ id: 'iu-3', machineId: 'm-x1c', name: 'AMS unit A', position: 0, externalIdentifier: '0', nozzle: null }],
    slots: [
      { id: 'sl-3', inputUnitId: 'iu-3', name: 'Slot A1', position: 0, status: 'available', spoolId: 'sp-0163', externalIdentifier: '0' },
      { id: 'sl-4', inputUnitId: 'iu-3', name: 'Slot A2', position: 1, status: 'available', spoolId: null, externalIdentifier: '1' },
      { id: 'sl-5', inputUnitId: 'iu-3', name: 'Slot A3', position: 2, status: 'unavailable', spoolId: null, externalIdentifier: '2' },
      { id: 'sl-6', inputUnitId: 'iu-3', name: 'Slot A4', position: 3, status: 'available', spoolId: null, externalIdentifier: '3' },
    ] },
  { machineId: 'm-h2d', enabled: true,
    inputUnits: [
      { id: 'iu-h2d-1', machineId: 'm-h2d', name: 'AMS 2 Pro', position: 0, externalIdentifier: '0', nozzle: 'left' },
      { id: 'iu-h2d-2', machineId: 'm-h2d', name: 'External spool L', position: 1, externalIdentifier: '255', nozzle: 'left' },
      { id: 'iu-h2d-3', machineId: 'm-h2d', name: 'External spool R', position: 2, externalIdentifier: '254', nozzle: 'right' },
    ],
    slots: [
      { id: 'sl-h2d-1', inputUnitId: 'iu-h2d-1', name: 'Slot 1', position: 0, status: 'available', spoolId: null, externalIdentifier: '0' },
      { id: 'sl-h2d-2', inputUnitId: 'iu-h2d-1', name: 'Slot 2', position: 1, status: 'available', spoolId: null, externalIdentifier: '1' },
      { id: 'sl-h2d-3', inputUnitId: 'iu-h2d-1', name: 'Slot 3', position: 2, status: 'available', spoolId: 'sp-0160', externalIdentifier: '2' },
      { id: 'sl-h2d-4', inputUnitId: 'iu-h2d-1', name: 'Slot 4', position: 3, status: 'available', spoolId: null, externalIdentifier: '3' },
      { id: 'sl-h2d-5', inputUnitId: 'iu-h2d-2', name: 'Spool', position: 0, status: 'available', spoolId: null, externalIdentifier: '255' },
      { id: 'sl-h2d-6', inputUnitId: 'iu-h2d-3', name: 'Spool', position: 0, status: 'available', spoolId: 'sp-0170', externalIdentifier: '254' },
    ] },
];

