import type {
  BoxBlock,
  ColumnsBlock,
  DividerBlock,
  IfBlock,
  Layer,
  LayerPages,
  SpacerBlock,
  SwitchBlock,
} from '../../model';
import { PAGE_LABELS } from '../../model';
import { conditionPaths } from '../../variables';
import { ColorField } from '../fields/ColorField';
import { ConditionEditor } from '../fields/ConditionEditor';
import { CheckField, NumField, SelectField, TextField } from '../fields/Inputs';
import { usePanel } from '../fields/panelContext';
import { SizeField } from '../fields/SizeField';
import { Hint, ItemCard, ItemsEditor, Row2, type NodeSectionProps } from './shared';
import { patchAt, removeAt } from '../../listOps';

export function IfSection({ node, set }: NodeSectionProps<IfBlock>) {
  return (
    <>
      <ConditionEditor title="Show “Then” when" value={node.when} onChange={(when, kind) => set({ when }, kind)} />
      <Hint>
        Otherwise the blocks under “Else” are shown. Add blocks to a branch with the insert tools and move them with Up
        and Down.
      </Hint>
    </>
  );
}

export function SwitchSection({ node, set }: NodeSectionProps<SwitchBlock>) {
  const { doc, schema } = usePanel();
  const paths = conditionPaths(doc, schema);
  const known = !node.path || paths.includes(node.path) ? paths : [node.path, ...paths];
  return (
    <>
      <SelectField
        label="Value to compare"
        value={node.path}
        options={[{ value: '', label: 'Choose a value' }, ...known.map((p) => ({ value: p, label: p }))]}
        onChange={(v, kind) => set({ path: v }, kind)}
      />
      <ItemsEditor
        title="Cases (shown when the value equals)"
        addLabel="Add case"
        onAdd={() => set({ cases: [...node.cases, { value: '', blocks: [] }] }, 'step')}
      >
        {node.cases.map((c, i) => (
          <ItemCard key={i} removeLabel="Remove case" onRemove={() => set({ cases: removeAt(node.cases, i) }, 'step')}>
            <TextField
              label={`Case ${i + 1}`}
              value={c.value}
              onChange={(v, kind) => set({ cases: patchAt(node.cases, i, { value: v }) }, kind)}
            />
          </ItemCard>
        ))}
      </ItemsEditor>
      <Hint>Blocks under “Otherwise” show when no case matches. Removing a case removes its blocks.</Hint>
    </>
  );
}

export function ColumnsSection({ node, set }: NodeSectionProps<ColumnsBlock>) {
  return (
    <>
      {node.columns.map((c, i) => (
        <NumField
          key={i}
          label={`Column ${i + 1} width (share, 0 = as wide as its content)`}
          value={c.width}
          step={1}
          min={0}
          onChange={(v, kind) => set({ columns: patchAt(node.columns, i, { width: v ?? 0 }) }, kind)}
        />
      ))}
      <SizeField
        label="Gap (mm)"
        unit="mm"
        step={0.5}
        value={node.gap}
        onChange={(v, kind) => set({ gap: v ?? 6 }, kind)}
      />
    </>
  );
}

export function BoxSection({ node, set }: NodeSectionProps<BoxBlock>) {
  return (
    <>
      <Row2>
        <SizeField
          label="Padding (mm)"
          unit="mm"
          step={0.5}
          value={node.padding}
          onChange={(v, kind) => set({ padding: v ?? 4 }, kind)}
        />
        <SizeField
          label="Border (mm, 0 = none)"
          unit="mm"
          step={0.05}
          value={node.stroke}
          onChange={(v, kind) => set({ stroke: v ?? 0 }, kind)}
        />
      </Row2>
      <ColorField
        label="Border colour"
        value={node.color}
        onChange={(v, kind) => set({ color: v ?? '#c6c6c6' }, kind)}
      />
      <ColorField label="Background" allowNone value={node.fill} onChange={(v, kind) => set({ fill: v }, kind)} />
    </>
  );
}

export function SpacerSection({ node, set }: NodeSectionProps<SpacerBlock>) {
  return (
    <SizeField
      label="Height (mm)"
      unit="mm"
      step={0.5}
      value={node.height}
      onChange={(v, kind) => set({ height: v ?? 0 }, kind)}
    />
  );
}

export function DividerSection({ node, set }: NodeSectionProps<DividerBlock>) {
  return (
    <>
      <SizeField
        label="Thickness (mm)"
        unit="mm"
        step={0.05}
        value={node.stroke}
        onChange={(v, kind) => set({ stroke: v ?? 0.3 }, kind)}
      />
      <ColorField label="Colour" value={node.color} onChange={(v, kind) => set({ color: v ?? '#c6c6c6' }, kind)} />
    </>
  );
}

export function LayerSection({ node, set }: NodeSectionProps<Layer>) {
  return (
    <>
      <SelectField
        label="Show on"
        value={node.pages}
        options={(Object.keys(PAGE_LABELS) as LayerPages[]).map((p) => ({ value: p, label: PAGE_LABELS[p] }))}
        onChange={(v) => set({ pages: v }, 'step')}
      />
      <CheckField
        label="Hidden"
        checked={!!node.hidden}
        onChange={(v, kind) => set({ hidden: v || undefined }, kind)}
      />
      <Hint>Add elements with the insert bar below the page, or drag blocks into this layer.</Hint>
    </>
  );
}
