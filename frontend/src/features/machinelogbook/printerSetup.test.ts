import { describe, expect, it } from 'vitest';
import {
  autoMatch, draftFromProfile, draftFromTemplate, draftToInput, duplicatePairs, missingUnits, modelById, slotOptions, trayMismatch, draftUnitRefs,
} from './printerSetup';
import { h2dUnits, liveStatusOf, templateProfile, tray } from './printerTestData';

describe('printer setup helpers', () => {
  it('builds the H2D template with external holders using the vir_slot id as unit and slot identifier', () => {
    const units = draftFromTemplate('bambu_h2d');
    expect(units.map((unit) => [unit.name, unit.ext, unit.nozzle, unit.slots.length])).toEqual([['AMS 2 Pro', '0', 'left', 4], ['External spool L', '255', 'left', 1], ['External spool R', '254', 'right', 1]]);
    expect(units[1].slots[0]).toMatchObject({ unitExt: '255', ext: '255' });
    expect(draftFromTemplate('generic')).toEqual([]);
  });

  it('offers the X1C LAN adapter with its one-nozzle AMS topology', () => {
    expect(modelById('bambu_x1c')).toMatchObject({ adapterKind: 'bambu_x1c', nozzles: 1 });
    expect(draftFromTemplate('bambu_x1c').map((unit) => [unit.name, unit.ext, unit.slots.length])).toEqual([
      ['AMS', '0', 4], ['External spool', '255', 1],
    ]);
  });

  it('serializes drafts with ids only for stored items and trims names', () => {
    const [stored] = draftFromProfile(templateProfile());
    const input = draftToInput([{ ...stored, name: ' AMS ' }, ...draftFromTemplate('bambu_x1c').slice(1)]);
    expect(input[0]).toMatchObject({ id: 'unit-ams', name: 'AMS', nozzle: 'left', externalIdentifier: '0' });
    expect(input[0].slots[0]).toEqual({ id: 'slot-ams-0', name: 'Slot 1', status: 'available', externalIdentifier: '0' });
    expect(input[1]).toEqual({ name: 'External spool', nozzle: null, externalIdentifier: '255', slots: [{ name: 'Spool', status: 'available', externalIdentifier: '255' }] });
  });

  it('ignores retired slots and disabled units of a stored profile', () => {
    const profile = templateProfile();
    profile.slots[0] = { ...profile.slots[0], status: 'retired' };
    profile.inputUnits[1] = { ...profile.inputUnits[1], enabled: false };
    const units = draftFromProfile(profile);
    expect(units.map((unit) => unit.name)).toEqual(['AMS 2 Pro', 'External spool R']);
    expect(units[0].slots).toHaveLength(3);
  });

  it('detects duplicate printer slot mappings and matches the rest by position', () => {
    const units = draftFromTemplate('bambu_h2d');
    expect(duplicatePairs(units).size).toBe(0);
    units[0].slots[1].ext = '0';
    expect(duplicatePairs(units)).toEqual(new Set(['0/0']));
    const options = slotOptions(liveStatusOf().status, 'bambu_h2d');
    const { units: matched, count } = autoMatch(units, options);
    expect(matched[0].slots.map((slot) => slot.ext)).toEqual(['0', '1', '2', '3']);
    expect(count).toBe(6);
    expect(duplicatePairs(matched).size).toBe(0);
  });

  it('finds reported units that no input unit refers to', () => {
    const snapshot = liveStatusOf().status;
    const known = draftUnitRefs(draftFromTemplate('bambu_h2d'));
    expect(missingUnits(snapshot, known).map((unit) => unit.externalId)).toEqual(['128']);
    expect(missingUnits(null, known)).toEqual([]);
    expect(h2dUnits).toHaveLength(4);
  });

  it('tags mismatches between the reported tray and the mounted spool', () => {
    const spool = { id: 's', displayId: 'S-1', materialName: 'PLA Black' };
    expect(trayMismatch(tray('0'), spool)).toBe('Printer reports empty');
    expect(trayMismatch(tray('0', { empty: false, rfid: true, materialType: 'PLA' }), undefined)).toBe('Not mounted in Core');
    expect(trayMismatch(tray('0', { empty: false, materialType: 'PETG-CF' }), spool)).toBe('Material differs');
    expect(trayMismatch(tray('0', { empty: false, materialType: 'PLA' }), spool)).toBeNull();
    expect(trayMismatch(tray('0', { empty: false, materialType: 'PLA' }), undefined)).toBeNull();
  });
});
