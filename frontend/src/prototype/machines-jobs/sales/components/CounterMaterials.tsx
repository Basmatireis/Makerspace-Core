/* eslint-disable react-refresh/only-export-components -- the material line form and its helpers belong together */
import { Button, ComboBox, IconButton, RadioTile, TextInput, TileGroup, Toggle } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { filamentColor } from '../../previewImages';
import { useStore } from '../../store';
import type { Material, Spool } from '../../types';
import { formatQuantity, parseQuantity } from '../format';

export type MaterialLine = { key: string; ownership: 'makerspace' | 'external'; spoolId: string; materialId: string; other: boolean; externalName: string; quantity: string };

let counter = 0;
export const blankLine = (): MaterialLine => ({ key: `ml-${++counter}`, ownership: 'makerspace', spoolId: '', materialId: '', other: false, externalName: '', quantity: '' });

export const unitOf = (line: MaterialLine, materials: Material[]) => line.ownership === 'external' ? 'g' : materials.find((item) => item.id === line.materialId)?.unit ?? '';
export const unitLabel = (unit: string) => unit === 'm2' ? 'm²' : unit;

/** A line is complete when it names a material and a positive quantity; an untouched blank line is ignored. */
export function lineState(line: MaterialLine): 'blank' | 'valid' | 'invalid' {
  const touched = line.quantity.trim() || line.materialId || line.externalName.trim();
  if (!touched) return 'blank';
  const quantity = parseQuantity(line.quantity);
  const named = line.ownership === 'external' ? line.externalName.trim() !== '' : line.materialId !== '';
  return named && quantity !== null && quantity > 0 ? 'valid' : 'invalid';
}

/** Spools that sit on the chosen printer, from its printer setup. */
export function useMountedSpools(machineId: string): Spool[] {
  const store = useStore();
  const profile = store.printerProfiles.find((item) => item.machineId === machineId);
  const ids = new Set((profile?.slots ?? []).map((slot) => slot.spoolId).filter(Boolean));
  return store.spools.filter((spool) => ids.has(spool.id) && spool.lifecycle === 'active' && spool.materialId);
}

export function MaterialLines({ machineId, lines, onChange, disabled }: { machineId: string; lines: MaterialLine[]; onChange: (lines: MaterialLine[]) => void; disabled?: boolean }) {
  const store = useStore();
  const mounted = useMountedSpools(machineId);
  const materials = store.materials.filter((item) => item.active);
  const patch = (key: string, change: Partial<MaterialLine>) => onChange(lines.map((line) => line.key === key ? { ...line, ...change } : line));
  const machine = store.machines.find((item) => item.id === machineId);

  return (
    <div className="sales-lines">
      {lines.map((line, index) => {
        const material = store.materials.find((item) => item.id === line.materialId);
        const showTiles = line.ownership === 'makerspace' && mounted.length > 0;
        const quantity = parseQuantity(line.quantity);
        const unit = unitLabel(unitOf(line, store.materials));
        const state = lineState(line);
        return (
          <div key={line.key} className="sales-line">
            <div className="sales-line__head">
              <Toggle id={`${line.key}-own`} size="sm" labelText="Material" labelA="From the makerspace" labelB="Customer’s own material" toggled={line.ownership === 'external'} disabled={disabled}
                onToggle={(checked) => patch(line.key, { ownership: checked ? 'external' : 'makerspace', materialId: '', spoolId: '', other: false })} />
              {lines.length > 1 && <IconButton label="Remove this material" kind="ghost" size="md" disabled={disabled} onClick={() => onChange(lines.filter((item) => item.key !== line.key))}><TrashCan /></IconButton>}
            </div>
            {line.ownership === 'external' && <TextInput id={`${line.key}-name`} labelText="Material" placeholder="e.g. customer’s TPU spool" value={line.externalName} disabled={disabled} onChange={(event) => patch(line.key, { externalName: event.target.value })} helperText="Not charged and not taken from stock." />}
            {showTiles && (
              <TileGroup legend={`Mounted on ${machine?.name ?? 'the printer'}`} name={`${line.key}-spool`} valueSelected={line.other ? 'other' : line.spoolId} disabled={disabled} className="sales-spool-tiles"
                onChange={(value) => { const spool = mounted.find((item) => item.id === value); patch(line.key, value === 'other' ? { other: true, spoolId: '', materialId: '' } : { other: false, spoolId: String(value), materialId: spool?.materialId ?? '' }); }}>
                {mounted.map((spool) => (
                  <RadioTile key={spool.id} id={`${line.key}-${spool.id}`} value={spool.id}>
                    <span className="sales-spool"><span className="mj-swatch" style={{ background: filamentColor(spool.materialName) }} aria-hidden /><span className="mj-cell-stack"><strong>{spool.materialName}</strong><span className="mj-secondary">{spool.displayId} · {formatQuantity(spool.remainingQuantity)} g left</span></span></span>
                  </RadioTile>
                ))}
                <RadioTile id={`${line.key}-other`} value="other"><span className="sales-spool"><span className="mj-cell-stack"><strong>Another material</strong><span className="mj-secondary">Search the stock</span></span></span></RadioTile>
              </TileGroup>
            )}
            {line.ownership === 'makerspace' && (!showTiles || line.other) && (
              <ComboBox autoAlign id={`${line.key}-material`} titleText="Material" placeholder="Search materials" items={materials} itemToString={(item) => item ? `${item.name} (${unitLabel(item.unit)})` : ''}
                selectedItem={material ?? null} disabled={disabled} onChange={({ selectedItem }) => patch(line.key, { materialId: selectedItem?.id ?? '', spoolId: '' })}
                shouldFilterItem={({ item, inputValue }) => !inputValue || !item || item.name.toLowerCase().includes(inputValue.toLowerCase())} />
            )}
            <TextInput id={`${line.key}-qty`} labelText={`Quantity${unit ? ` (${unit})` : ''}`} inputMode="decimal" value={line.quantity} disabled={disabled}
              invalid={state === 'invalid' && (quantity === null || quantity <= 0)} invalidText="Enter a quantity greater than zero" helperText={index === 0 ? 'As used for this sale. Stock is booked when the sale is completed.' : undefined}
              onChange={(event) => patch(line.key, { quantity: event.target.value })} />
          </div>
        );
      })}
      <Button kind="ghost" size="sm" renderIcon={Add} disabled={disabled} onClick={() => onChange([...lines, blankLine()])}>Add another material</Button>
    </div>
  );
}
