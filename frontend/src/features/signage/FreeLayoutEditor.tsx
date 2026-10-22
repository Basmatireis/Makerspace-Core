import { useRef } from 'react';
import { Button, ContainedList, ContainedListItem, IconButton, NumberInput } from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import type { SignageFreeRect } from '../../api/generated/models';
import {
  dragRect,
  MAX_ZONES,
  moveZone,
  newRect,
  nextZoneId,
  nextZoneLabel,
  normalizeRect,
  numberOf,
  replaceZone,
  type ResizeHandle,
} from './customLayoutModel';
import { ZoneLabelField, type LayoutEditorProps } from './layoutEditorShared';

const HANDLES: { name: string; handle: ResizeHandle }[] = [
  { name: 'nw', handle: { n: true, w: true } },
  { name: 'n', handle: { n: true } },
  { name: 'ne', handle: { n: true, e: true } },
  { name: 'e', handle: { e: true } },
  { name: 'se', handle: { s: true, e: true } },
  { name: 's', handle: { s: true } },
  { name: 'sw', handle: { s: true, w: true } },
  { name: 'w', handle: { w: true } },
];

type Drag = { id: string; handle?: ResizeHandle; x: number; y: number; start: SignageFreeRect };

/**
 * Free mode: zones as rectangles on a scaled screen. Drag a zone to move it, drag a handle to resize it (both snap to
 * 0.5 %). The number fields and the arrow keys do the same without a pointer. Later zones are drawn on top.
 * Carbon has no canvas or resize control, so the rectangles and handles are plain elements.
 */
export function FreeLayoutEditor({ layout, orientation, selectedId, onSelect, onChange }: LayoutEditorProps) {
  const { zones } = layout;
  const canvas = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const selected = zones.find((zone) => zone.id === selectedId) ?? null;

  const setRect = (id: string, rect: SignageFreeRect) => onChange({ zones: replaceZone(zones, id, { rect }) });

  const begin = (event: React.PointerEvent, id: string, start: SignageFreeRect, handle?: ResizeHandle) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id, handle, x: event.clientX, y: event.clientY, start };
    onSelect(id);
  };
  const move = (event: React.PointerEvent) => {
    const current = drag.current;
    const box = canvas.current?.getBoundingClientRect();
    if (!current || !box || box.width === 0 || box.height === 0) return;
    const dx = ((event.clientX - current.x) / box.width) * 100;
    const dy = ((event.clientY - current.y) / box.height) * 100;
    setRect(current.id, dragRect(current.start, dx, dy, current.handle));
  };
  const end = () => {
    drag.current = null;
  };

  const rectField = (key: keyof SignageFreeRect, label: string, min: number) => {
    const rect = selected?.rect;
    if (!selected || !rect) return null;
    return (
      <NumberInput
        id={`free-zone-${key}`}
        label={label}
        size="sm"
        min={min}
        max={100}
        step={0.5}
        value={rect[key]}
        onChange={(_, { value }) => {
          const number = numberOf(value);
          if (number !== null) setRect(selected.id, normalizeRect({ ...rect, [key]: number }, 0.01));
        }}
      />
    );
  };

  // Top of the stack first, like layers in a drawing tool.
  const stacking = [...zones].map((zone, index) => ({ zone, index })).reverse();

  return (
    <div className="sg-stack">
      <p className="sg-secondary">
        Drag a zone to move it and its handles to resize. Arrow keys move the selected zone by 0.5 % (Shift: 5 %). Zones
        may overlap; the one lower in the list is drawn on top.
      </p>
      <div className={`sg-free-canvas sg-free-canvas--${orientation}`} ref={canvas} role="group" aria-label="Screen">
        {zones.map((zone, index) => {
          const rect = zone.rect;
          if (!rect) return null;
          const isSelected = zone.id === selectedId;
          return (
            <div
              key={zone.id}
              // A drawn rectangle that can be moved; keyboard users use the arrow keys or the number fields.
              role="button"
              tabIndex={0}
              aria-label={`Zone ${zone.label}`}
              aria-pressed={isSelected}
              className={`sg-free-zone sg-free-zone--tint-${index % 6}${isSelected ? ' sg-free-zone--selected' : ''}`}
              style={{
                insetInlineStart: `${rect.x}%`,
                insetBlockStart: `${rect.y}%`,
                inlineSize: `${rect.width}%`,
                blockSize: `${rect.height}%`,
                zIndex: index + 1,
              }}
              onPointerDown={(event) => begin(event, zone.id, rect)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onFocus={() => onSelect(zone.id)}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 5 : 0.5;
                const delta: Record<string, [number, number]> = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                };
                const change = delta[event.key];
                if (!change) return;
                event.preventDefault();
                setRect(zone.id, dragRect(rect, change[0], change[1]));
              }}
            >
              <span className="sg-free-zone__label">{zone.label}</span>
              {isSelected &&
                HANDLES.map(({ name, handle }) => (
                  <span
                    key={name}
                    className={`sg-free-handle sg-free-handle--${name}`}
                    aria-hidden="true"
                    onPointerDown={(event) => begin(event, zone.id, rect, handle)}
                  />
                ))}
            </div>
          );
        })}
      </div>

      <Button
        kind="tertiary"
        size="sm"
        renderIcon={Add}
        disabled={zones.length >= MAX_ZONES}
        onClick={() => {
          const id = nextZoneId(zones);
          onChange({ zones: [...zones, { id, label: nextZoneLabel(zones), grid: null, rect: newRect(zones.length) }] });
          onSelect(id);
        }}
      >
        Add zone
      </Button>

      <ContainedList label={`Zones, top first (${zones.length} of ${MAX_ZONES})`} kind="on-page">
        {stacking.map(({ zone, index }) => (
          <ContainedListItem
            key={zone.id}
            className={zone.id === selectedId ? 'sg-zone-item--active' : undefined}
            onClick={() => onSelect(zone.id)}
            action={
              <>
                <IconButton
                  label={`Bring ${zone.label} forward`}
                  kind="ghost"
                  size="sm"
                  disabled={index === zones.length - 1}
                  onClick={() => onChange({ zones: moveZone(zones, index, 1) })}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  label={`Send ${zone.label} backward`}
                  kind="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => onChange({ zones: moveZone(zones, index, -1) })}
                >
                  <ArrowDown />
                </IconButton>
              </>
            }
          >
            <span className="sg-zone-row" aria-current={zone.id === selectedId ? 'true' : undefined}>
              {zone.label}
            </span>
          </ContainedListItem>
        ))}
      </ContainedList>

      {selected?.rect && (
        <div className="sg-panel">
          <h3 className="sg-section-title">Zone: {selected.label}</h3>
          <div className="sg-stack">
            <ZoneLabelField
              id="free-zone-label"
              zone={selected}
              onChange={(label) => onChange({ zones: replaceZone(zones, selected.id, { label }) })}
            />
            <div className="sg-form-row sg-form-row--four">
              {rectField('x', 'Left (%)', 0)}
              {rectField('y', 'Top (%)', 0)}
              {rectField('width', 'Width (%)', 1)}
              {rectField('height', 'Height (%)', 1)}
            </div>
            <div>
              <Button
                kind="danger--tertiary"
                size="sm"
                renderIcon={TrashCan}
                disabled={zones.length <= 1}
                onClick={() => {
                  onChange({ zones: zones.filter((zone) => zone.id !== selected.id) });
                  onSelect(null);
                }}
              >
                Delete zone
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
