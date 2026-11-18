import type { Align, SheetBlock, TableBlock, TableColumn } from '../../model';
import { CheckField, ExprField, NumField, SelectField, TextField } from '../fields/Inputs';
import { ALIGN_OPTIONS } from '../fields/options';
import { ColorField } from '../fields/ColorField';
import { SizeField } from '../fields/SizeField';
import { LoopSource } from './LoopSection';
import { RowsEditor } from './FieldsSection';
import { ItemCard, ItemsEditor, Hint, Row2, type NodeSectionProps } from './shared';
import { patchAt, removeAt } from '../../listOps';

const positive = (v: number | undefined) => (v && v > 0 ? Math.floor(v) : undefined);

export function TableSection({ node, area, set }: NodeSectionProps<TableBlock>) {
  const columns = node.columns;
  const setColumn = (i: number, patch: Partial<TableColumn>, kind: 'typing' | 'step') =>
    set({ columns: patchAt(columns, i, patch) }, kind);
  return (
    <>
      <LoopSource node={node} area={area} set={set} />
      <Row2>
        <NumField
          label="Max. rows per page"
          value={node.maxRows}
          step={1}
          min={1}
          helper="Empty = as many as fit"
          onChange={(v, kind) => set({ maxRows: positive(v) }, kind)}
        />
        <NumField
          label="Max. rows on first page"
          value={node.maxRowsFirst}
          step={1}
          min={1}
          helper="Empty = same limit"
          onChange={(v, kind) => set({ maxRowsFirst: positive(v) }, kind)}
        />
      </Row2>
      <CheckField
        label="Repeat header on new pages"
        checked={node.repeatHeader}
        onChange={(v, kind) => set({ repeatHeader: v }, kind)}
      />
      <TextField
        label="Text when the list is empty"
        value={node.emptyText ?? ''}
        placeholder="No entries"
        onChange={(v, kind) => set({ emptyText: v || undefined }, kind)}
      />
      <ItemsEditor
        title="Columns"
        addLabel="Add column"
        onAdd={() =>
          set(
            { columns: [...columns, { header: 'Column', value: `{{${node.as}.}}`, width: 25, align: 'left' }] },
            'step',
          )
        }
      >
        {columns.map((c, i) => (
          <ItemCard
            key={i}
            removeLabel="Remove column"
            onRemove={columns.length > 1 ? () => set({ columns: removeAt(columns, i) }, 'step') : undefined}
          >
            <Row2>
              <ExprField label="Header" value={c.header} onChange={(v, kind) => setColumn(i, { header: v }, kind)} />
              <NumField
                label="Width (share)"
                value={c.width}
                step={1}
                min={1}
                onChange={(v, kind) => setColumn(i, { width: v ?? 1 }, kind)}
              />
            </Row2>
            <SelectField
              label="Align"
              value={c.align}
              options={ALIGN_OPTIONS}
              onChange={(v, kind) => setColumn(i, { align: v as Align }, kind)}
            />
            <ExprField label="Value" value={c.value} onChange={(v, kind) => setColumn(i, { value: v }, kind)} />
            <ExprField
              label="Second line (small)"
              value={c.sub ?? ''}
              onChange={(v, kind) => setColumn(i, { sub: v || undefined }, kind)}
            />
          </ItemCard>
        ))}
      </ItemsEditor>
      <RowsEditor
        title="Total rows below the table"
        addLabel="Add total row"
        removeLabel="Remove total"
        rows={node.totals ?? []}
        newRow={{ label: 'Total', value: '' }}
        onChange={(totals, kind) => set({ totals }, kind)}
      />
    </>
  );
}

export function SheetSection({ node, area, set }: NodeSectionProps<SheetBlock>) {
  const columns = node.columns;
  const setColumn = (i: number, patch: Partial<SheetBlock['columns'][number]>, kind: 'typing' | 'step') =>
    set({ columns: patchAt(columns, i, patch) }, kind);
  const mm = (label: string, key: keyof SheetBlock, step = 0.01) => (
    <SizeField
      label={label}
      unit="mm"
      step={step}
      value={node[key] as number | string | undefined}
      onChange={(v, kind) => set({ [key]: v }, kind)}
    />
  );
  return (
    <>
      <LoopSource node={node} area={area} set={set} />
      <Row2>
        <NumField
          label="Rows on first page"
          value={node.rowsFirst}
          step={1}
          min={0}
          onChange={(v, k) => set({ rowsFirst: v ?? 0 }, k)}
        />
        <NumField
          label="Rows on later pages"
          value={node.rowsNext}
          step={1}
          min={0}
          onChange={(v, k) => set({ rowsNext: v ?? 0 }, k)}
        />
        <NumField
          label="Top on first page (mm)"
          value={node.firstTop}
          onChange={(v, k) => set({ firstTop: v ?? 0 }, k)}
        />
        <NumField
          label="Top on later pages (mm)"
          value={node.nextTop}
          onChange={(v, k) => set({ nextTop: v ?? 0 }, k)}
        />
      </Row2>
      <Row2>
        {mm('Row height (mm)', 'rowHeight')}
        {mm('Header height (mm)', 'headHeight')}
        {mm('Carried row height (mm)', 'carryHeight')}
        {mm('Sum row height (mm)', 'sumHeight')}
      </Row2>
      <Hint>Different heights on the first sheet (empty = the same as the others):</Hint>
      <Row2>
        {mm('Row height, first sheet', 'rowHeightFirst')}
        {mm('Header height, first sheet', 'headHeightFirst')}
        {mm('Carried row, first sheet', 'carryHeightFirst')}
        {mm('Sum row, first sheet', 'sumHeightFirst')}
      </Row2>
      <SizeField
        label="Line thickness (mm)"
        unit="mm"
        step={0.05}
        value={node.stroke}
        onChange={(v, kind) => set({ stroke: v }, kind)}
      />
      <ColorField label="Line colour" value={node.color} onChange={(v, kind) => set({ color: v ?? '#3c3c3c' }, kind)} />
      <CheckField
        label="Keep empty rows like the paper form"
        checked={node.fillEmpty}
        onChange={(v, kind) => set({ fillEmpty: v }, kind)}
      />
      <ItemsEditor title="Carried balance row">
        <ExprField
          label="Label"
          value={node.carry.label}
          onChange={(v, kind) => set({ carry: { ...node.carry, label: v } }, kind)}
        />
        <ExprField
          label="Value"
          value={node.carry.value}
          onChange={(v, kind) => set({ carry: { ...node.carry, value: v } }, kind)}
        />
        <ColorField
          label="Grey cell of the amount out column"
          allowNone
          value={node.carry.outFill}
          onChange={(v, kind) => set({ carry: { ...node.carry, outFill: v } }, kind)}
        />
      </ItemsEditor>
      <ItemsEditor title="Sum row">
        <ExprField
          label="Label"
          value={node.sum.label}
          onChange={(v, kind) => set({ sum: { ...node.sum, label: v } }, kind)}
        />
        <Row2>
          <ExprField
            label="Money in"
            value={node.sum.in}
            onChange={(v, kind) => set({ sum: { ...node.sum, in: v } }, kind)}
          />
          <ExprField
            label="Money out"
            value={node.sum.out}
            onChange={(v, kind) => set({ sum: { ...node.sum, out: v } }, kind)}
          />
        </Row2>
        <ExprField
          label="Balance"
          value={node.sum.balance ?? ''}
          onChange={(v, kind) => set({ sum: { ...node.sum, balance: v || undefined } }, kind)}
        />
        <ColorField
          label="Grey cell of the amount out column"
          allowNone
          value={node.sum.outFill}
          onChange={(v, kind) => set({ sum: { ...node.sum, outFill: v } }, kind)}
        />
      </ItemsEditor>
      <ItemsEditor
        title="Columns (the last two are the money in and out columns)"
        addLabel="Add column"
        onAdd={() =>
          set(
            {
              columns: [
                ...columns,
                { header: 'Column', value: `{{${node.as}.}}`, x: 20, w: 20, align: 'left' as const },
              ],
            },
            'step',
          )
        }
      >
        {columns.map((c, i) => (
          <ItemCard
            key={i}
            removeLabel="Remove column"
            onRemove={columns.length > 1 ? () => set({ columns: removeAt(columns, i) }, 'step') : undefined}
          >
            <ExprField label="Header" value={c.header} onChange={(v, kind) => setColumn(i, { header: v }, kind)} />
            <Row2>
              <NumField
                label="x (mm)"
                value={c.x}
                onChange={(v, kind) => setColumn(i, { x: v ?? 0 }, kind)}
                step={0.01}
              />
              <NumField
                label="Width (mm)"
                value={c.w}
                min={0}
                onChange={(v, kind) => setColumn(i, { w: v ?? 0 }, kind)}
                step={0.01}
              />
              <SelectField
                label="Align"
                value={c.align}
                options={ALIGN_OPTIONS}
                onChange={(v, kind) => setColumn(i, { align: v as Align }, kind)}
              />
              <SelectField
                label="Header align"
                value={c.headerAlign ?? ''}
                options={[{ value: '', label: 'Same as column' }, ...ALIGN_OPTIONS]}
                onChange={(v, kind) => setColumn(i, { headerAlign: (v || undefined) as Align | undefined }, kind)}
              />
            </Row2>
            <ExprField label="Value" value={c.value} onChange={(v, kind) => setColumn(i, { value: v }, kind)} />
            <ExprField
              label="Second line (small)"
              value={c.sub ?? ''}
              onChange={(v, kind) => setColumn(i, { sub: v || undefined }, kind)}
            />
          </ItemCard>
        ))}
      </ItemsEditor>
      <Hint>
        Each page of a form table knows sheet.carry, sheet.sumIn, sheet.sumOut and sheet.balance; the next page carries
        sheet.balance over.
      </Hint>
    </>
  );
}
