import { ActionableNotification, Button, Dropdown, InlineNotification, OverflowMenu, OverflowMenuItem, Select, SelectItem, Stack, TextInput, Tile } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import {
  autoMatch, draftFromDetected, draftKey, draftUnitRefs, duplicatePairs, missingUnits, NOZZLE_GROUPS, nozzleLabel, slotOptions, slotPair, trayFor,
  type Detection, type DraftSlot, type DraftUnit, type Nozzle, type PrinterModelInfo, type SlotOption,
} from '../../printerSetup';
import { useNotify } from '../../shared/toasts';
import { DetectedTrayCell } from '../DetectedTrayCell';

type Item = { id: string; label: string };
const NOT_MAPPED: Item = { id: '', label: 'Not mapped' };

/** Step 3 of the setup wizard: internal input units and slots, mapped to the slots the printer reports. */
export function SpoolInputsEditor({ units, onChange, detection, model }: {
  units: DraftUnit[]; onChange: (units: DraftUnit[]) => void; detection: Detection; model: PrinterModelInfo | undefined;
}) {
  const notify = useNotify();
  const options = slotOptions(detection, model?.id ?? null);
  const duplicates = duplicatePairs(units);
  const multiNozzle = (model?.nozzles ?? 1) > 1 || units.some((unit) => unit.nozzle);
  const missing = missingUnits(detection, draftUnitRefs(units));

  const patchUnit = (key: string, patch: Partial<DraftUnit>) => onChange(units.map((unit) => unit.key === key ? { ...unit, ...patch } : unit));
  const patchSlot = (unitKey: string, slotKey: string, patch: Partial<DraftSlot>) => onChange(units.map((unit) => unit.key === unitKey ? { ...unit, slots: unit.slots.map((slot) => slot.key === slotKey ? { ...slot, ...patch } : slot) } : unit));
  const addUnit = (nozzle: Nozzle | null) => onChange([...units, { key: draftKey('u'), name: `Input unit ${units.length + 1}`, ext: null, nozzle, slots: [{ key: draftKey('s'), name: 'Slot 1', unitExt: null, ext: null, custom: false, status: 'available' }] }]);
  const addSlot = (unit: DraftUnit) => patchUnit(unit.key, { slots: [...unit.slots, { key: draftKey('s'), name: `Slot ${unit.slots.length + 1}`, unitExt: unit.ext, ext: null, custom: false, status: 'available' }] });
  const match = () => {
    const result = autoMatch(units, options);
    onChange(result.units);
    notify({ kind: 'success', title: `${result.count} of ${units.reduce((sum, unit) => sum + unit.slots.length, 0)} slots matched`, subtitle: 'By printer identifier, then by position.' });
  };

  const usedByOthers = (slotKey: string) => new Set(units.flatMap((unit) => unit.slots.filter((slot) => slot.key !== slotKey).map((slot) => slotPair(unit, slot))).filter((pair): pair is string => Boolean(pair)));

  const renderSlot = (unit: DraftUnit, slot: DraftSlot) => {
    const pair = slotPair(unit, slot);
    const taken = usedByOthers(slot.key);
    const choices: Item[] = [NOT_MAPPED, ...options.filter((option) => !taken.has(option.key)).map((option) => ({ id: option.key, label: option.label }))];
    const current: SlotOption | undefined = options.find((option) => option.key === pair);
    const selected = slot.custom ? undefined : current ? { id: current.key, label: current.label } : NOT_MAPPED;
    const duplicate = pair != null && duplicates.has(pair);
    return (
      <div key={slot.key} className="mj-slot-row">
        <TextInput id={`slot-name-${slot.key}`} labelText="Slot name" size="sm" value={slot.name} autoComplete="off" invalid={!slot.name.trim()} invalidText="Enter a slot name." onChange={(event) => patchSlot(unit.key, slot.key, { name: event.target.value })} />
        <Dropdown<Item>
          id={`slot-map-${slot.key}`} titleText="Printer slot" label="Not mapped" size="sm" autoAlign items={choices} itemToString={(item) => item?.label ?? ''}
          selectedItem={selected} invalid={duplicate} invalidText="Another slot already uses this printer slot."
          helperText={slot.custom ? 'Custom identifier' : detection || !current ? undefined : 'Expected for this model'}
          onChange={({ selectedItem }) => {
            const option = options.find((item) => item.key === selectedItem?.id);
            patchSlot(unit.key, slot.key, option ? { unitExt: option.unitExt, ext: option.ext, custom: false } : { ext: null, custom: false });
            if (option && unit.ext == null) patchUnit(unit.key, { ext: option.unitExt });
          }}
        />
        <div>
          <p className="cds--label">Reported by printer</p>
          <div className="mj-slot-row__detected"><DetectedTrayCell tray={trayFor(detection, slot.unitExt ?? unit.ext, slot.ext)} unknownLabel={detection ? 'Not reported' : '—'} /></div>
        </div>
        <OverflowMenu aria-label={`More actions for ${slot.name || 'slot'}`} flipped size="md">
          <OverflowMenuItem itemText="Use custom identifier" onClick={() => patchSlot(unit.key, slot.key, { custom: true })} />
          <OverflowMenuItem itemText="Remove slot" isDelete disabled={unit.slots.length === 1} onClick={() => patchUnit(unit.key, { slots: unit.slots.filter((item) => item.key !== slot.key) })} />
        </OverflowMenu>
        {slot.custom && (
          <TextInput
            id={`slot-custom-${slot.key}`} className="mj-slot-row__custom" labelText="Custom printer identifier" size="sm" autoComplete="off" value={slot.ext ?? ''}
            helperText="Advanced: the slot identifier as the adapter reports it (for the H2D, the AMS tray id)." invalid={duplicate} invalidText="Another slot already uses this identifier."
            onChange={(event) => patchSlot(unit.key, slot.key, { ext: event.target.value.trim() || null })}
          />
        )}
      </div>
    );
  };

  const renderUnit = (unit: DraftUnit) => (
    <Tile key={unit.key} className="mj-unit">
      <div className="mj-unit__head">
        <TextInput id={`unit-name-${unit.key}`} labelText="Input unit name" value={unit.name} autoComplete="off" invalid={!unit.name.trim()} invalidText="Enter a name." onChange={(event) => patchUnit(unit.key, { name: event.target.value })} />
        {multiNozzle ? (
          <Select id={`unit-nozzle-${unit.key}`} labelText="Nozzle" value={unit.nozzle ?? ''} onChange={(event) => patchUnit(unit.key, { nozzle: (event.target.value || null) as Nozzle | null })}>
            <SelectItem value="left" text="Left nozzle" />
            <SelectItem value="right" text="Right nozzle" />
            <SelectItem value="" text="Not assigned" />
          </Select>
        ) : <span />}
        <Button hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription={`Remove ${unit.name || 'input unit'}`} tooltipPosition="left" onClick={() => onChange(units.filter((item) => item.key !== unit.key))} />
      </div>
      {unit.slots.map((slot) => renderSlot(unit, slot))}
      <div><Button kind="ghost" size="sm" renderIcon={Add} onClick={() => addSlot(unit)}>Add slot</Button></div>
    </Tile>
  );

  return (
    <Stack gap={5}>
      {!detection && <InlineNotification kind="info" lowContrast hideCloseButton title="Connect the printer to see what's loaded in each slot." subtitle="Until the connector has reported, printer slots come from the model template." />}
      {missing.map((unit) => (
        <ActionableNotification
          key={unit.externalId} kind="info" lowContrast hideCloseButton inline title={`The printer reports ${unit.label} (${unit.externalId}), which isn't set up`}
          actionButtonLabel="Add as input unit" onActionButtonClick={() => onChange([...units, draftFromDetected(unit)])}
        />
      ))}
      <div className="mj-toolbar">
        <Button kind="tertiary" size="sm" disabled={!detection || units.length === 0} onClick={match}>Match automatically</Button>
        <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => addUnit(null)}>Add input unit</Button>
      </div>
      {units.length === 0 && <p className="mj-secondary">No input units yet. Add the spool holders or material systems of this printer.</p>}
      {multiNozzle
        ? NOZZLE_GROUPS.map((group) => {
          const inGroup = units.filter((unit) => unit.nozzle === group);
          if (inGroup.length === 0) return null;
          return <Stack key={group ?? 'none'} gap={4}><h4 className="mj-group-title">{nozzleLabel(group)}</h4>{inGroup.map(renderUnit)}</Stack>;
        })
        : units.map(renderUnit)}
    </Stack>
  );
}
