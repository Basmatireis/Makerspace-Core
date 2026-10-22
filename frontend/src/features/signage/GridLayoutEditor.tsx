import { useEffect, useState } from 'react';
import { Button, ContainedList, ContainedListItem, InlineNotification, NumberInput, Tag } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useLatestCallback } from '../../app/useLatestCallback';
import {
  collidingZone,
  fitZonesToGrid,
  MAX_TRACKS,
  MAX_WEIGHT,
  MAX_ZONES,
  nextZoneId,
  nextZoneLabel,
  numberOf,
  placementBetween,
  placementFits,
  replaceZone,
  resizeTracks,
  zoneAtCell,
} from './customLayoutModel';
import { ZoneLabelField, type LayoutEditorProps } from './layoutEditorShared';
import { pluralize } from './helpers';

type Cell = { col: number; row: number };

const TINTS = 6;
const span = (from: number, count: number) => (count === 1 ? `${from}` : `${from}–${from + count - 1}`);

/**
 * Grid mode: columns and rows with `fr` weights, zones drawn by selecting a range of cells. Cells are plain buttons
 * because Carbon has no grid-selection control. Everything a drag does is also possible with the number fields and the
 * keyboard (Enter on a first cell, then Enter on the last cell).
 */
export function GridLayoutEditor({ layout, orientation, selectedId, onSelect, onChange }: LayoutEditorProps) {
  const { columns, rows, zones } = layout;
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [hover, setHover] = useState<Cell | null>(null);
  const [dragging, setDragging] = useState(false);
  const [redraw, setRedraw] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draw, setDraw] = useState({ fromCol: 1, toCol: 1, fromRow: 1, toRow: 1 });
  const selected = zones.find((zone) => zone.id === selectedId) ?? null;

  const reset = () => {
    setAnchor(null);
    setHover(null);
    setDragging(false);
  };

  const commit = useLatestCallback((from: Cell, to: Cell) => {
    const placement = placementBetween(from, to);
    const sameCell = from.col === to.col && from.row === to.row;
    setNotice(null);
    if (redraw && selected) {
      const other = collidingZone(zones, placement, selected.id);
      if (other) setNotice(`That area overlaps ${other.label}.`);
      else {
        onChange({ zones: replaceZone(zones, selected.id, { grid: placement }) });
        setRedraw(false);
      }
      return;
    }
    const existing = sameCell ? zoneAtCell(zones, from.col, from.row) : undefined;
    if (existing) {
      onSelect(existing.id);
      return;
    }
    const other = collidingZone(zones, placement);
    if (other) setNotice(`That area overlaps ${other.label}.`);
    else if (zones.length >= MAX_ZONES) setNotice(`A layout has at most ${MAX_ZONES} zones.`);
    else {
      const id = nextZoneId(zones);
      onChange({ zones: [...zones, { id, label: nextZoneLabel(zones), grid: placement, rect: null }] });
      onSelect(id);
    }
  });

  // The pointer is released anywhere on the page, not necessarily over the grid.
  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      if (anchor) commit(anchor, hover ?? anchor);
      reset();
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', reset);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', reset);
    };
  }, [dragging, anchor, hover, commit]);

  const preview = anchor && hover ? placementBetween(anchor, hover) : null;
  const previewBlocked = preview ? Boolean(collidingZone(zones, preview, redraw ? selected?.id : '')) : false;

  const setCount = (axis: 'columns' | 'rows', value: unknown) => {
    const count = numberOf(value);
    if (count === null) return;
    const tracks = resizeTracks(layout[axis], count);
    const fitted = fitZonesToGrid(
      zones,
      axis === 'columns' ? tracks.length : columns.length,
      axis === 'rows' ? tracks.length : rows.length,
    );
    if (fitted.zones.length === 0) {
      setNotice('At least one zone must stay inside the grid.');
      return;
    }
    setNotice(
      fitted.removed.length > 0
        ? `Removed ${fitted.removed.map((zone) => zone.label).join(', ')}: outside the smaller grid.`
        : null,
    );
    onChange({ [axis]: tracks, zones: fitted.zones });
  };
  const setWeight = (axis: 'columns' | 'rows', index: number, value: unknown) => {
    const weight = numberOf(value);
    if (weight === null) return;
    const next = [...layout[axis]];
    next[index] = Math.min(MAX_WEIGHT, Math.max(1, Math.round(weight)));
    onChange({ [axis]: next });
  };

  const drawPlacement = placementBetween(
    { col: draw.fromCol, row: draw.fromRow },
    { col: draw.toCol, row: draw.toRow },
  );
  const drawFits = placementFits(drawPlacement, columns.length, rows.length);
  const drawOverlap = drawFits ? collidingZone(zones, drawPlacement) : undefined;
  const drawProblem = !drawFits
    ? 'The cells must lie inside the grid.'
    : drawOverlap
      ? `Overlaps ${drawOverlap.label}.`
      : zones.length >= MAX_ZONES
        ? `A layout has at most ${MAX_ZONES} zones.`
        : null;
  const drawField = (key: keyof typeof draw, label: string, max: number) => (
    <NumberInput
      id={`grid-draw-${key}`}
      label={label}
      size="sm"
      min={1}
      max={max}
      value={draw[key]}
      onChange={(_, { value }) => {
        const number = numberOf(value);
        if (number !== null) setDraw({ ...draw, [key]: Math.min(max, Math.max(1, Math.round(number))) });
      }}
    />
  );

  const placementField = (key: 'col' | 'row' | 'colSpan' | 'rowSpan', label: string, max: number) => {
    const grid = selected?.grid;
    if (!selected || !grid) return null;
    return (
      <NumberInput
        id={`grid-zone-${key}`}
        label={label}
        size="sm"
        min={1}
        max={max}
        value={grid[key]}
        onChange={(_, { value }) => {
          const number = numberOf(value);
          if (number === null) return;
          const placement = { ...grid, [key]: Math.max(1, Math.round(number)) };
          const other = collidingZone(zones, placement, selected.id);
          if (!placementFits(placement, columns.length, rows.length)) setNotice(`${label}: outside the grid.`);
          else if (other) setNotice(`That area overlaps ${other.label}.`);
          else {
            setNotice(null);
            onChange({ zones: replaceZone(zones, selected.id, { grid: placement }) });
          }
        }}
      />
    );
  };

  const trackInputs = (axis: 'columns' | 'rows', noun: string) => (
    <div className="sg-track-row">
      {layout[axis].map((weight, index) => (
        <NumberInput
          key={index}
          id={`grid-${axis}-weight-${index + 1}`}
          label={`${noun} ${index + 1} weight`}
          hideLabel
          size="sm"
          min={1}
          max={MAX_WEIGHT}
          value={weight}
          onChange={(_, { value }) => setWeight(axis, index, value)}
        />
      ))}
    </div>
  );

  return (
    <div className="sg-stack">
      <div className="sg-form-row">
        <div className="sg-stack">
          <NumberInput
            id="grid-columns"
            label="Columns"
            helperText="Weights set the relative width of each column."
            min={1}
            max={MAX_TRACKS}
            value={columns.length}
            onChange={(_, { value }) => setCount('columns', value)}
          />
          {trackInputs('columns', 'Column')}
        </div>
        <div className="sg-stack">
          <NumberInput
            id="grid-rows"
            label="Rows"
            helperText="Weights set the relative height of each row."
            min={1}
            max={MAX_TRACKS}
            value={rows.length}
            onChange={(_, { value }) => setCount('rows', value)}
          />
          {trackInputs('rows', 'Row')}
        </div>
      </div>

      <p className="sg-secondary">
        {redraw
          ? `Select the new area of ${selected?.label ?? 'the zone'} by dragging over cells.`
          : 'Drag over empty cells to create a zone. Select a zone by clicking one of its cells. With the keyboard, press Enter on the first cell and again on the last.'}
      </p>
      <div
        className={`sg-grid-canvas sg-grid-canvas--${orientation}`}
        style={{
          gridTemplateColumns: columns.map((weight) => `${weight}fr`).join(' '),
          gridTemplateRows: rows.map((weight) => `${weight}fr`).join(' '),
        }}
        role="group"
        aria-label="Grid of cells"
      >
        {rows.flatMap((_, rowIndex) =>
          columns.map((__, colIndex) => {
            const cell = { col: colIndex + 1, row: rowIndex + 1 };
            const zone = zoneAtCell(zones, cell.col, cell.row);
            const inPreview =
              preview &&
              cell.col >= preview.col &&
              cell.col < preview.col + preview.colSpan &&
              cell.row >= preview.row &&
              cell.row < preview.row + preview.rowSpan;
            const classes = [
              'sg-grid-cell',
              inPreview ? (previewBlocked ? 'sg-grid-cell--blocked' : 'sg-grid-cell--range') : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={`${cell.col}-${cell.row}`}
                type="button"
                className={classes}
                // Explicit positions: the zone boxes below are placed explicitly, which would push auto-placed cells away.
                style={{ gridColumn: cell.col, gridRow: cell.row }}
                aria-label={`Column ${cell.col}, row ${cell.row}${zone ? `, ${zone.label}` : ''}`}
                aria-pressed={zone ? zone.id === selectedId : undefined}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  // Touch pointers are captured by the pressed cell, which would stop the other cells from seeing the drag.
                  try {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  } catch {
                    // Not captured: nothing to release.
                  }
                  setAnchor(cell);
                  setHover(cell);
                  setDragging(true);
                }}
                onPointerEnter={() => {
                  if (dragging) setHover(cell);
                }}
                onFocus={() => {
                  if (anchor && !dragging) setHover(cell);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') reset();
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  if (!anchor) {
                    if (zone && !redraw) {
                      onSelect(zone.id);
                      return;
                    }
                    setAnchor(cell);
                    setHover(cell);
                    return;
                  }
                  commit(anchor, cell);
                  reset();
                }}
              ></button>
            );
          }),
        )}
        {/* One box per zone over its cells, so a zone spanning several cells reads as one area; clicks go to the cells. */}
        {zones.map((zone, index) =>
          zone.grid ? (
            <div
              key={zone.id}
              aria-hidden="true"
              className={[
                'sg-grid-zone',
                `sg-grid-cell--tint-${index % TINTS}`,
                zone.id === selectedId ? 'sg-grid-zone--selected' : '',
                preview ? 'sg-grid-zone--faded' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                gridColumn: `${zone.grid.col} / span ${zone.grid.colSpan}`,
                gridRow: `${zone.grid.row} / span ${zone.grid.rowSpan}`,
              }}
            >
              <span className="sg-grid-cell__label">{zone.label}</span>
            </div>
          ) : null,
        )}
      </div>
      {notice && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Not changed" subtitle={notice} />
      )}

      <div className="sg-panel">
        <h3 className="sg-section-title">Add a zone by cell numbers</h3>
        <div className="sg-form-row sg-form-row--four">
          {drawField('fromCol', 'First column', columns.length)}
          {drawField('toCol', 'Last column', columns.length)}
          {drawField('fromRow', 'First row', rows.length)}
          {drawField('toRow', 'Last row', rows.length)}
        </div>
        {drawProblem && <p className="sg-error-text">{drawProblem}</p>}
        <Button
          className="sg-top-gap"
          kind="tertiary"
          size="sm"
          renderIcon={Add}
          disabled={drawProblem !== null}
          onClick={() => {
            const id = nextZoneId(zones);
            onChange({ zones: [...zones, { id, label: nextZoneLabel(zones), grid: drawPlacement, rect: null }] });
            onSelect(id);
            setNotice(null);
          }}
        >
          Add zone
        </Button>
      </div>

      <ContainedList label={`Zones (${zones.length} of ${MAX_ZONES})`} kind="on-page">
        {zones.map((zone) => (
          <ContainedListItem
            key={zone.id}
            className={zone.id === selectedId ? 'sg-zone-item--active' : undefined}
            onClick={() => onSelect(zone.id)}
          >
            <span className="sg-zone-row" aria-current={zone.id === selectedId ? 'true' : undefined}>
              <span>{zone.label}</span>
              {zone.grid && (
                <Tag size="sm" type="cool-gray">
                  {pluralize(zone.grid.colSpan, 'col')} × {pluralize(zone.grid.rowSpan, 'row')}
                </Tag>
              )}
            </span>
          </ContainedListItem>
        ))}
      </ContainedList>

      {selected?.grid && (
        <div className="sg-panel">
          <h3 className="sg-section-title">Zone: {selected.label}</h3>
          <div className="sg-stack">
            <ZoneLabelField
              id="grid-zone-label"
              zone={selected}
              onChange={(label) => onChange({ zones: replaceZone(zones, selected.id, { label }) })}
            />
            <div className="sg-form-row sg-form-row--four">
              {placementField('col', 'Column', columns.length)}
              {placementField('colSpan', 'Width (columns)', columns.length)}
              {placementField('row', 'Row', rows.length)}
              {placementField('rowSpan', 'Height (rows)', rows.length)}
            </div>
            <p className="sg-secondary">
              Covers columns {span(selected.grid.col, selected.grid.colSpan)}, rows{' '}
              {span(selected.grid.row, selected.grid.rowSpan)}.
            </p>
            <div className="sg-inline">
              <Button
                kind={redraw ? 'primary' : 'tertiary'}
                size="sm"
                aria-pressed={redraw}
                onClick={() => setRedraw((value) => !value)}
              >
                {redraw ? 'Cancel redraw' : 'Redraw area'}
              </Button>
              <Button
                kind="danger--tertiary"
                size="sm"
                renderIcon={TrashCan}
                disabled={zones.length <= 1}
                onClick={() => {
                  onChange({ zones: zones.filter((zone) => zone.id !== selected.id) });
                  onSelect(null);
                  setRedraw(false);
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
