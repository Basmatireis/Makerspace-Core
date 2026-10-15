import {
  PrinterModel,
  type PrinterLiveStatusSnapshot,
  type PrinterLiveStatusTray,
  type PrinterLiveStatusUnit,
  type PrinterNozzle,
  type PrinterProfile,
  type PrinterSetupInputUnit,
  type PrinterSetupSlotStatus,
} from '../../api/generated/models';

// Pure helpers for the printer setup wizard and the machine detail screen: model templates, drafts of input units
// and slots, the printer slots that can be mapped, automatic matching and drift detection.

export type PrinterModelId = PrinterModel;
export type Nozzle = PrinterNozzle;
/** What the connector last reported about a printer, or null while nothing was received. */
export type Detection = PrinterLiveStatusSnapshot | null;

export type DraftSlot = { key: string; id?: string; name: string; unitExt: string | null; ext: string | null; custom: boolean; status: PrinterSetupSlotStatus };
export type DraftUnit = { key: string; id?: string; name: string; ext: string | null; nozzle: Nozzle | null; slots: DraftSlot[] };

/** A slot the printer reports (or, without a test, one the model template expects). */
export type SlotOption = { key: string; unitExt: string; ext: string; label: string; tray: PrinterLiveStatusTray | null };

type TemplateUnit = { name: string; externalIdentifier: string | null; nozzle: Nozzle | null; slots: { name: string; externalIdentifier: string | null }[] };
export type PrinterModelInfo = {
  id: PrinterModelId;
  label: string;
  description: string;
  /** Only the H2D has a live adapter; the simulator adapter works with any model for testing. */
  adapterKind: 'bambu_h2d' | null;
  nozzles: number;
  template: TemplateUnit[];
};

// Template slot external identifiers match what the H2D adapter reports: input-unit external id = AMS `id`, slot external
// id = tray `id`; the external spool holders report `vir_slot` ids "254" (right) and "255" (left) as unit and slot id.
export const printerModels: PrinterModelInfo[] = [
  {
    id: PrinterModel.bambu_h2d, label: 'Bambu Lab H2D', description: '2 nozzles · AMS · LAN connector', adapterKind: 'bambu_h2d', nozzles: 2, template: [
      { name: 'AMS 2 Pro', externalIdentifier: '0', nozzle: 'left', slots: [0, 1, 2, 3].map((i) => ({ name: `Slot ${i + 1}`, externalIdentifier: String(i) })) },
      { name: 'External spool L', externalIdentifier: '255', nozzle: 'left', slots: [{ name: 'Spool', externalIdentifier: '255' }] },
      { name: 'External spool R', externalIdentifier: '254', nozzle: 'right', slots: [{ name: 'Spool', externalIdentifier: '254' }] },
    ],
  },
  {
    id: PrinterModel.bambu_x1c, label: 'Bambu Lab X1C', description: '1 nozzle · AMS · simulator only', adapterKind: null, nozzles: 1, template: [
      { name: 'AMS', externalIdentifier: '0', nozzle: null, slots: [0, 1, 2, 3].map((i) => ({ name: `Slot ${i + 1}`, externalIdentifier: String(i) })) },
      { name: 'External spool', externalIdentifier: '254', nozzle: null, slots: [{ name: 'Spool', externalIdentifier: '254' }] },
    ],
  },
  {
    id: PrinterModel.prusa_core_one, label: 'Prusa CORE One', description: '1 nozzle · direct feed · simulator only', adapterKind: null, nozzles: 1, template: [
      { name: 'Direct feed', externalIdentifier: null, nozzle: null, slots: [{ name: 'Extruder', externalIdentifier: null }] },
    ],
  },
  { id: PrinterModel.generic, label: 'Other 3D printer', description: 'No template · set up spool inputs yourself', adapterKind: null, nozzles: 1, template: [] },
];
export const modelById = (id: PrinterModelId | null | undefined) => printerModels.find((model) => model.id === id);

let counter = 0;
export const draftKey = (prefix: string) => `${prefix}-${++counter}`;

// Extruder 0 is the right nozzle, extruder 1 the left one. The mapping is still to be verified on a real printer;
// this helper and the external holder mapping are the only places that know it.
export const extruderNozzle = (extruderId: number): Nozzle | null => extruderId === 0 ? 'right' : extruderId === 1 ? 'left' : null;
export const externalHolderNozzle = (externalId: string): Nozzle | null => externalId === '254' ? 'right' : externalId === '255' ? 'left' : null;

export const nozzleLabel = (nozzle: Nozzle | null) => nozzle === 'left' ? 'Left nozzle' : nozzle === 'right' ? 'Right nozzle' : 'Not assigned';
export const NOZZLE_GROUPS: (Nozzle | null)[] = ['left', 'right', null];

export const pairKey = (unitExt: string | null, ext: string | null) => ext == null ? null : `${unitExt ?? ''}/${ext}`;
export const slotPair = (unit: DraftUnit, slot: DraftSlot) => pairKey(slot.unitExt ?? unit.ext, slot.ext);

export function draftFromTemplate(modelId: PrinterModelId | null): DraftUnit[] {
  return (modelById(modelId)?.template ?? []).map((unit) => ({
    key: draftKey('u'), name: unit.name, ext: unit.externalIdentifier, nozzle: unit.nozzle,
    slots: unit.slots.map((slot) => ({ key: draftKey('s'), name: slot.name, unitExt: unit.externalIdentifier, ext: slot.externalIdentifier, custom: false, status: 'available' as const })),
  }));
}

/** Active input units and slots of a stored profile (retired slots and disabled units only exist for history). */
export function draftFromProfile(profile: PrinterProfile): DraftUnit[] {
  return profile.inputUnits.filter((unit) => unit.enabled).sort((a, b) => a.position - b.position).map((unit) => ({
    key: draftKey('u'), id: unit.id, name: unit.name, ext: unit.externalIdentifier ?? null, nozzle: unit.nozzle,
    slots: profile.slots.filter((slot) => slot.inputUnitId === unit.id && slot.status !== 'retired').sort((a, b) => a.position - b.position)
      .map((slot) => ({
        key: draftKey('s'), id: slot.id, name: slot.name, unitExt: unit.externalIdentifier ?? null, ext: slot.externalIdentifier ?? null, custom: false,
        status: slot.status === 'unavailable' ? 'unavailable' as const : 'available' as const,
      })),
  }));
}

/** Request body units of the atomic setup endpoint. */
export function draftToInput(units: DraftUnit[]): PrinterSetupInputUnit[] {
  return units.map((unit) => ({
    ...(unit.id ? { id: unit.id } : {}),
    name: unit.name.trim(), nozzle: unit.nozzle,
    externalIdentifier: unit.slots.find((slot) => slot.ext != null)?.unitExt ?? unit.ext,
    slots: unit.slots.map((slot) => ({
      ...(slot.id ? { id: slot.id } : {}),
      name: slot.name.trim(), status: slot.status, externalIdentifier: slot.ext?.trim() || null,
    })),
  }));
}

const unitLabel = (unit: PrinterLiveStatusUnit) => `${unit.label} (${unit.externalId})`;

/** Slots offered in the "Printer slot" dropdown: reported ones after a test, the template's expected ones before. */
export function slotOptions(detection: Detection, modelId: PrinterModelId | null): SlotOption[] {
  if (detection) {
    return detection.units.flatMap((unit) => unit.trays.map((tray, index) => ({
      key: pairKey(unit.externalId, tray.externalId)!, unitExt: unit.externalId, ext: tray.externalId,
      label: unit.kind === 'external' ? unitLabel(unit) : `${unitLabel(unit)} · Slot ${index + 1}`, tray,
    })));
  }
  return (modelById(modelId)?.template ?? []).flatMap((unit) => unit.slots.flatMap((slot, index) => slot.externalIdentifier == null || unit.externalIdentifier == null ? [] : [{
    key: pairKey(unit.externalIdentifier, slot.externalIdentifier)!, unitExt: unit.externalIdentifier, ext: slot.externalIdentifier,
    label: unit.slots.length > 1 ? `${unit.name} (${unit.externalIdentifier}) · Slot ${index + 1}` : `${unit.name} (${unit.externalIdentifier})`, tray: null,
  }]));
}

export function trayFor(detection: Detection, unitExt: string | null, ext: string | null): PrinterLiveStatusTray | null {
  if (!detection || ext == null) return null;
  return detection.units.find((unit) => unit.externalId === unitExt)?.trays.find((tray) => tray.externalId === ext) ?? null;
}

/** Mapping of a stored profile slot to its human label, e.g. "AMS 2 Pro (0) · Slot 1". */
export function mappingLabel(detection: Detection, modelId: PrinterModelId | null, unitExt: string | null, ext: string | null): string | null {
  const pair = pairKey(unitExt, ext);
  if (!pair) return null;
  return slotOptions(detection, modelId).find((option) => option.key === pair)?.label ?? `Custom identifier ${unitExt ?? '?'}/${ext}`;
}

export function duplicatePairs(units: DraftUnit[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const unit of units) for (const slot of unit.slots) {
    const pair = slotPair(unit, slot);
    if (!pair) continue;
    if (seen.has(pair)) duplicates.add(pair); else seen.add(pair);
  }
  return duplicates;
}

/**
 * Keeps slots whose external id the printer reports, then maps the remaining (unmapped or unknown) slots by position,
 * preferring the printer unit the input unit already points at. Returns the number of slots mapped to a printer slot afterwards.
 */
export function autoMatch(units: DraftUnit[], options: SlotOption[]): { units: DraftUnit[]; count: number } {
  const known = new Set(options.map((option) => option.key));
  const next = units.map((unit) => ({ ...unit, slots: unit.slots.map((slot) => ({ ...slot })) }));
  const used = new Set<string>();
  for (const unit of next) for (const slot of unit.slots) {
    const pair = slotPair(unit, slot);
    if (pair && known.has(pair) && !used.has(pair)) used.add(pair);
    else { slot.ext = null; slot.custom = false; }
  }
  for (const unit of next) {
    const home = unit.slots.find((slot) => slot.ext != null)?.unitExt ?? unit.ext;
    for (const slot of unit.slots) {
      if (slot.ext != null) continue;
      const option = options.find((item) => !used.has(item.key) && (home == null || item.unitExt === home)) ?? options.find((item) => !used.has(item.key) && home == null);
      if (!option) continue;
      slot.unitExt = option.unitExt; slot.ext = option.ext; used.add(option.key);
    }
  }
  return { units: next, count: used.size };
}

/** Printer units the connector reports that no input unit refers to yet. */
export function missingUnits(detection: Detection, units: { ext: string | null; mapped: (string | null)[] }[]): PrinterLiveStatusUnit[] {
  if (!detection) return [];
  const known = new Set(units.flatMap((unit) => [unit.ext, ...unit.mapped]).filter((value): value is string => value != null));
  return detection.units.filter((unit) => !known.has(unit.externalId));
}

export const draftUnitRefs = (units: DraftUnit[]) => units.map((unit) => ({ ext: unit.ext, mapped: unit.slots.map((slot) => slot.ext != null ? slot.unitExt : null) }));
export const profileUnitRefs = (profile: PrinterProfile) => profile.inputUnits.filter((unit) => unit.enabled).map((unit) => ({ ext: unit.externalIdentifier ?? null, mapped: [] as (string | null)[] }));

/** Builds a new input unit (with slots mapped to the printer's trays) from a reported unit. */
export function draftFromDetected(unit: PrinterLiveStatusUnit): DraftUnit {
  return {
    key: draftKey('u'), name: unit.label, ext: unit.externalId, nozzle: unit.kind === 'external' ? externalHolderNozzle(unit.externalId) : null,
    slots: unit.trays.map((tray, index) => ({ key: draftKey('s'), name: unit.kind === 'external' ? 'Spool' : `Slot ${index + 1}`, unitExt: unit.externalId, ext: tray.externalId, custom: false, status: 'available' as const })),
  };
}

export function describeDetection(detection: PrinterLiveStatusSnapshot): string {
  const amsNames = detection.units.filter((unit) => unit.kind !== 'external').map((unit) => unit.label);
  const holders = detection.units.filter((unit) => unit.kind === 'external').length;
  const parts = [detection.firmwareVersion ? `Firmware ${detection.firmwareVersion}` : 'Firmware unknown', `${detection.nozzles.length} nozzle${detection.nozzles.length === 1 ? '' : 's'}`];
  if (amsNames.length) parts.push(amsNames.join(', '));
  if (holders) parts.push(`${holders} external spool holder${holders === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export type MountedSpool = { id: string; displayId: string | null; materialName: string | null };

/** Compares what the printer reports in a tray with what Core believes is mounted there. */
export function trayMismatch(tray: PrinterLiveStatusTray, spool: MountedSpool | undefined): string | null {
  if (tray.empty && spool) return 'Printer reports empty';
  if (!tray.empty && !spool && tray.rfid) return 'Not mounted in Core';
  if (spool?.materialName && tray.materialType && !spool.materialName.toLowerCase().includes(tray.materialType.split(/[\s-]/)[0].toLowerCase())) return 'Material differs';
  return null;
}

export const SERIAL_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
