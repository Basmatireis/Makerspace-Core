import { modelById } from './mockData';
import type { SetupUnitInput } from './store';
import type { DetectedPrinterState, DetectedTray, DetectedUnit, MachineType, Nozzle, PrinterModelId, PrinterProfile, SlotStatus } from './types';

// Pure helpers for the printer setup wizard and the machine detail screen: drafts of input units and slots,
// the list of printer slots that can be mapped, automatic matching and drift detection.

export type DraftSlot = { key: string; id?: string; name: string; unitExt: string | null; ext: string | null; custom: boolean; status: SlotStatus };
export type DraftUnit = { key: string; id?: string; name: string; ext: string | null; nozzle: Nozzle | null; slots: DraftSlot[] };

/** A slot the printer reports (or, without a test, one the model template expects). */
export type SlotOption = { key: string; unitExt: string; ext: string; label: string; tray: DetectedTray | null };

let counter = 0;
export const draftKey = (prefix: string) => `${prefix}-${++counter}`;

// Extruder 0 is labelled "Right nozzle", extruder 1 "Left nozzle". The mapping is to be validated against real printer data.
export const nozzleLabel = (nozzle: Nozzle | null) => nozzle === 'left' ? 'Left nozzle' : nozzle === 'right' ? 'Right nozzle' : 'Not assigned';
export const NOZZLE_GROUPS: (Nozzle | null)[] = ['left', 'right', null];

/** Only FDM / 3D-printer machine types get a printer model, a connection and spool inputs. */
export const isPrinterType = (type: Pick<MachineType, 'name'> | undefined) => Boolean(type && /fdm|3d/i.test(type.name));

export const pairKey = (unitExt: string | null, ext: string | null) => ext == null ? null : `${unitExt ?? ''}/${ext}`;
export const slotPair = (unit: DraftUnit, slot: DraftSlot) => pairKey(slot.unitExt ?? unit.ext, slot.ext);

export function draftFromTemplate(modelId: PrinterModelId | null): DraftUnit[] {
  return (modelById(modelId)?.template ?? []).map((unit) => ({
    key: draftKey('u'), name: unit.name, ext: unit.externalIdentifier, nozzle: unit.nozzle,
    slots: unit.slots.map((slot) => ({ key: draftKey('s'), name: slot.name, unitExt: unit.externalIdentifier, ext: slot.externalIdentifier, custom: false, status: 'available' as const })),
  }));
}

export function draftFromProfile(profile: PrinterProfile): DraftUnit[] {
  return [...profile.inputUnits].sort((a, b) => a.position - b.position).map((unit) => ({
    key: draftKey('u'), id: unit.id, name: unit.name, ext: unit.externalIdentifier, nozzle: unit.nozzle,
    slots: profile.slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position)
      .map((slot) => ({ key: draftKey('s'), id: slot.id, name: slot.name, unitExt: unit.externalIdentifier, ext: slot.externalIdentifier, custom: false, status: slot.status })),
  }));
}

export function draftToInput(units: DraftUnit[]): SetupUnitInput[] {
  return units.map((unit) => ({
    id: unit.id, name: unit.name.trim(), nozzle: unit.nozzle,
    externalIdentifier: unit.slots.find((slot) => slot.ext != null)?.unitExt ?? unit.ext,
    slots: unit.slots.map((slot) => ({ id: slot.id, name: slot.name.trim(), externalIdentifier: slot.ext?.trim() || null, status: slot.status })),
  }));
}

const unitLabel = (unit: DetectedUnit) => `${unit.label} (${unit.externalId})`;

/** Slots offered in the "Printer slot" dropdown: detected ones after a test, the template's expected ones before. */
export function slotOptions(detected: DetectedPrinterState | null, modelId: PrinterModelId | null): SlotOption[] {
  if (detected) {
    return detected.units.flatMap((unit) => unit.trays.map((tray, index) => ({
      key: pairKey(unit.externalId, tray.externalId)!, unitExt: unit.externalId, ext: tray.externalId,
      label: unit.kind === 'external' ? unitLabel(unit) : `${unitLabel(unit)} · Slot ${index + 1}`, tray,
    })));
  }
  return (modelById(modelId)?.template ?? []).flatMap((unit) => unit.slots.flatMap((slot, index) => slot.externalIdentifier == null || unit.externalIdentifier == null ? [] : [{
    key: pairKey(unit.externalIdentifier, slot.externalIdentifier)!, unitExt: unit.externalIdentifier, ext: slot.externalIdentifier,
    label: unit.slots.length > 1 ? `${unit.name} (${unit.externalIdentifier}) · Slot ${index + 1}` : `${unit.name} (${unit.externalIdentifier})`, tray: null,
  }]));
}

export function trayFor(detected: DetectedPrinterState | null, unitExt: string | null, ext: string | null): DetectedTray | null {
  if (!detected || ext == null) return null;
  return detected.units.find((unit) => unit.externalId === unitExt)?.trays.find((tray) => tray.externalId === ext) ?? null;
}

/** Mapping of a stored profile slot to its human label, e.g. "AMS 2 Pro (0) · Slot 1". */
export function mappingLabel(detected: DetectedPrinterState | null, modelId: PrinterModelId | null, unitExt: string | null, ext: string | null): string | null {
  const pair = pairKey(unitExt, ext);
  if (!pair) return null;
  return slotOptions(detected, modelId).find((option) => option.key === pair)?.label ?? `Custom identifier ${unitExt ?? '?'}/${ext}`;
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
export function missingUnits(detected: DetectedPrinterState | null, units: { ext: string | null; mapped: (string | null)[] }[]): DetectedUnit[] {
  if (!detected) return [];
  const known = new Set(units.flatMap((unit) => [unit.ext, ...unit.mapped]).filter((value): value is string => value != null));
  return detected.units.filter((unit) => !known.has(unit.externalId));
}

export const draftUnitRefs = (units: DraftUnit[]) => units.map((unit) => ({ ext: unit.ext, mapped: unit.slots.map((slot) => slot.ext != null ? slot.unitExt : null) }));
export const profileUnitRefs = (profile: PrinterProfile) => profile.inputUnits.map((unit) => ({ ext: unit.externalIdentifier, mapped: [] as (string | null)[] }));

/** Builds a new input unit (with slots mapped to the printer's trays) from a detected unit. */
export function draftFromDetected(unit: DetectedUnit): DraftUnit {
  return {
    key: draftKey('u'), name: unit.label, ext: unit.externalId, nozzle: unit.nozzle,
    slots: unit.trays.map((tray, index) => ({ key: draftKey('s'), name: unit.kind === 'external' ? 'Spool' : `Slot ${index + 1}`, unitExt: unit.externalId, ext: tray.externalId, custom: false, status: 'available' as const })),
  };
}

export function describeDetection(detected: DetectedPrinterState): string {
  const amsNames = detected.units.filter((unit) => unit.kind !== 'external').map((unit) => unit.label);
  const holders = detected.units.filter((unit) => unit.kind === 'external').length;
  const parts = [`Firmware ${detected.firmware}`, `${detected.nozzles.length} nozzle${detected.nozzles.length === 1 ? '' : 's'}`];
  if (amsNames.length) parts.push(amsNames.join(', '));
  if (holders) parts.push(`${holders} external spool holder${holders === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export const isIPv4 = (value: string) => {
  const octets = value.trim().split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return false;
  const first = Number(octets[0]);
  return first > 0 && first !== 127 && first < 224;
};
export const SERIAL_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
