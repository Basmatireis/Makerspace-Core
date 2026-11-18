import { Button, IconButton } from '@carbon/react';
import { Add, ArrowDown, ArrowUp } from '../../icons';
import type { GridBlock, GridCell, GridRow } from '../../model';
import { patchAt, removeAt } from '../../listOps';
import { ColorField } from '../fields/ColorField';
import { ExprField, NumField, SelectField } from '../fields/Inputs';
import { ALIGN_OPTIONS } from '../fields/options';
import { SizeField } from '../fields/SizeField';
import { PartStyleSelect } from '../fields/TextStyleSelect';
import { ItemCard, ItemsEditor, Row2, type NodeSectionProps } from './shared';
import type { ChangeKind } from '../../history';

const VALIGN_OPTIONS = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
];

const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

function CellEditor({
  cell,
  label,
  onChange,
  onRemove,
}: {
  cell: GridCell;
  /** "Row 1, cell 2": names the cell's fields for assistive technology. */
  label: string;
  onChange: (patch: Partial<GridCell>, kind: ChangeKind) => void;
  onRemove?: () => void;
}) {
  return (
    <ItemCard removeLabel={`Remove ${label}`} onRemove={onRemove}>
      <ExprField
        label={`${label}: text`}
        value={cell.text}
        rows={2}
        area
        onChange={(v, kind) => onChange({ text: v }, kind)}
      />
      <Row2>
        <SelectField
          label={`${label}: align`}
          value={cell.align ?? 'left'}
          options={ALIGN_OPTIONS}
          onChange={(v, kind) => onChange({ align: v as GridCell['align'] }, kind)}
        />
        <SelectField
          label={`${label}: vertical`}
          value={cell.valign ?? 'top'}
          options={VALIGN_OPTIONS}
          onChange={(v, kind) => onChange({ valign: v as GridCell['valign'] }, kind)}
        />
      </Row2>
      <Row2>
        <NumField
          label={`${label}: span`}
          value={cell.span ?? 1}
          step={1}
          min={1}
          onChange={(v, kind) => onChange({ span: v && v > 1 ? Math.round(v) : undefined }, kind)}
        />
        <PartStyleSelect
          label={`${label}: text style`}
          value={cell.textStyle}
          onChange={(v, kind) => onChange({ textStyle: v }, kind)}
        />
      </Row2>
      <ColorField
        label={`${label}: fill`}
        allowNone
        value={cell.fill}
        onChange={(v, kind) => onChange({ fill: v }, kind)}
      />
    </ItemCard>
  );
}

/** A grid: column widths, the frame line and padding, and the rows with their cells. */
export function GridSection({ node, set }: NodeSectionProps<GridBlock>) {
  const setRows = (rows: GridRow[], kind: ChangeKind = 'step') => set({ rows }, kind);
  const setRow = (i: number, patch: Partial<GridRow>, kind: ChangeKind) => setRows(patchAt(node.rows, i, patch), kind);
  const newCells = (): GridCell[] => node.colWidths.map(() => ({ text: '' }));
  const total = node.colWidths.reduce((sum, w) => sum + w, 0);

  return (
    <>
      <Row2>
        <SizeField
          label="Line thickness (mm)"
          unit="mm"
          step={0.05}
          value={node.stroke}
          onChange={(v, kind) => set({ stroke: v }, kind)}
        />
        <SizeField
          label="Cell padding (mm)"
          unit="mm"
          step={0.5}
          value={node.padding}
          onChange={(v, kind) => set({ padding: v }, kind)}
        />
      </Row2>
      <ColorField label="Frame colour" allowNone value={node.color} onChange={(v, kind) => set({ color: v }, kind)} />
      <ItemsEditor
        title={`Columns (${Math.round(total * 10) / 10} mm in all)`}
        addLabel="Add column"
        onAdd={() =>
          set({
            colWidths: [...node.colWidths, 30],
            rows: node.rows.map((r) => ({ ...r, cells: [...r.cells, { text: '' }] })),
          })
        }
      >
        {node.colWidths.map((w, i) => (
          <ItemCard
            key={i}
            removeLabel={`Remove column ${i + 1}`}
            onRemove={
              node.colWidths.length > 1
                ? () =>
                    set({
                      colWidths: removeAt(node.colWidths, i),
                      rows: node.rows.map((r) => ({ ...r, cells: removeAt(r.cells, Math.min(i, r.cells.length - 1)) })),
                    })
                : undefined
            }
          >
            <NumField
              label={`Column ${i + 1} width (mm)`}
              value={w}
              step={1}
              min={1}
              onChange={(v, kind) => set({ colWidths: node.colWidths.map((x, j) => (j === i ? (v ?? x) : x)) }, kind)}
            />
          </ItemCard>
        ))}
      </ItemsEditor>
      <ItemsEditor
        title="Rows"
        addLabel="Add row"
        onAdd={() => setRows([...node.rows, { height: 8, cells: newCells() }])}
      >
        {node.rows.map((row, i) => (
          <ItemCard key={i} removeLabel={`Remove row ${i + 1}`} onRemove={() => setRows(removeAt(node.rows, i))}>
            <div className="pdft-gridrow__head">
              <SizeField
                label={`Row ${i + 1} height (mm)`}
                unit="mm"
                step={0.5}
                value={row.height}
                onChange={(v, kind) => setRow(i, { height: v ?? 8 }, kind)}
              />
              <IconButton
                label={`Move row ${i + 1} up`}
                kind="ghost"
                size="sm"
                disabled={i === 0}
                onClick={() => setRows(move(node.rows, i, i - 1))}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label={`Move row ${i + 1} down`}
                kind="ghost"
                size="sm"
                disabled={i === node.rows.length - 1}
                onClick={() => setRows(move(node.rows, i, i + 1))}
              >
                <ArrowDown />
              </IconButton>
            </div>
            {row.cells.map((cell, j) => (
              <CellEditor
                key={j}
                cell={cell}
                label={`Row ${i + 1}, cell ${j + 1}`}
                onChange={(patch, kind) => setRow(i, { cells: patchAt(row.cells, j, patch) }, kind)}
                onRemove={row.cells.length > 1 ? () => setRow(i, { cells: removeAt(row.cells, j) }, 'step') : undefined}
              />
            ))}
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              onClick={() => setRow(i, { cells: [...row.cells, { text: '' }] }, 'step')}
            >
              Add cell
            </Button>
          </ItemCard>
        ))}
      </ItemsEditor>
    </>
  );
}
