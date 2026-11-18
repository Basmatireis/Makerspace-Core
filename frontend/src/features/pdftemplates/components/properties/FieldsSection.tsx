import type { FieldRow, FieldsBlock } from '../../model';
import { ConditionEditor } from '../fields/ConditionEditor';
import { CheckField, ExprField, type Change } from '../fields/Inputs';
import { SizeField } from '../fields/SizeField';
import { ItemCard, ItemsEditor, type NodeSectionProps } from './shared';
import { patchAt, removeAt } from '../../listOps';

/** Label/value rows with bold and "only when set": the rows of a label & value list, and the total rows of a table. */
export function RowsEditor({
  title,
  addLabel,
  rows,
  onChange,
  removeLabel,
  newRow,
}: {
  title: string;
  addLabel: string;
  rows: readonly FieldRow[];
  onChange: Change<FieldRow[]>;
  removeLabel: string;
  newRow: FieldRow;
}) {
  return (
    <ItemsEditor title={title} addLabel={addLabel} onAdd={() => onChange([...rows, newRow], 'step')}>
      {rows.map((row, i) => (
        <ItemCard key={i} removeLabel={removeLabel} onRemove={() => onChange(removeAt(rows, i), 'step')}>
          <ExprField
            label="Label"
            value={row.label}
            onChange={(v, kind) => onChange(patchAt(rows, i, { label: v }), kind)}
          />
          <ExprField
            label="Value"
            value={row.value}
            onChange={(v, kind) => onChange(patchAt(rows, i, { value: v }), kind)}
          />
          <div className="pdft-checks">
            <CheckField
              label="Bold"
              checked={!!row.bold}
              onChange={(v, kind) => onChange(patchAt(rows, i, { bold: v || undefined }), kind)}
            />
            <CheckField
              label="Only when set"
              checked={!!row.when}
              onChange={(v, kind) =>
                onChange(patchAt(rows, i, { when: v ? { path: '', op: 'exists' } : undefined }), kind)
              }
            />
          </div>
          {row.when && (
            <ConditionEditor
              title="Show this row only when"
              value={row.when}
              onChange={(when, kind) => onChange(patchAt(rows, i, { when }), kind)}
            />
          )}
        </ItemCard>
      ))}
    </ItemsEditor>
  );
}

export function FieldsSection({ node, set }: NodeSectionProps<FieldsBlock>) {
  return (
    <>
      <SizeField
        label="Label width (mm)"
        unit="mm"
        step={1}
        value={node.labelWidth}
        onChange={(v, kind) => set({ labelWidth: v ?? 48 }, kind)}
      />
      <CheckField
        label="Boxed (lines between rows)"
        checked={!!node.boxed}
        onChange={(v, kind) => set({ boxed: v || undefined }, kind)}
      />
      <RowsEditor
        title="Rows"
        addLabel="Add row"
        removeLabel="Remove row"
        rows={node.rows}
        newRow={{ label: 'Label', value: '' }}
        onChange={(rows, kind) => set({ rows }, kind)}
      />
    </>
  );
}
