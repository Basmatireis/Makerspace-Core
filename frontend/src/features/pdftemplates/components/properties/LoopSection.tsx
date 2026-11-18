import { listPaths } from '../../variables';
import { ExprField, SelectField, TextField } from '../fields/Inputs';
import { usePanel } from '../fields/panelContext';
import { Hint, Row2, type NodeSectionProps } from './shared';
import type { ListBlock, RepeatBlock, SheetBlock, TableBlock } from '../../model';

/** "Loop over" and "Name of one entry" of tables, repeats, lists and form tables. */
export function LoopSource({ node, set }: NodeSectionProps<TableBlock | RepeatBlock | SheetBlock | ListBlock>) {
  const { schema } = usePanel();
  const lists = listPaths(schema);
  const options = (lists.includes(node.source) ? lists : [node.source, ...lists]).filter(Boolean);
  return (
    <Row2>
      <SelectField
        label="Loop over"
        value={node.source}
        options={options.map((p) => ({ value: p, label: p }))}
        onChange={(v, kind) => set({ source: v }, kind)}
      />
      <TextField
        label="Name of one entry"
        value={node.as}
        maxLength={40}
        helper={`use {{${node.as || 'entry'}.…}}`}
        onChange={(v, kind) => set({ as: v.replace(/\W/g, '') }, kind)}
      />
    </Row2>
  );
}

export function RepeatSection(props: NodeSectionProps<RepeatBlock>) {
  return (
    <>
      <LoopSource {...props} />
      <Hint>The blocks inside are shown once for every entry. Add them in the structure.</Hint>
    </>
  );
}

export function ListSection({ node, set }: NodeSectionProps<ListBlock>) {
  return (
    <>
      <LoopSource node={node} area="body" set={set} />
      <ExprField
        area
        rows={2}
        label="Text of each entry"
        value={node.text}
        onChange={(v, kind) => set({ text: v }, kind)}
      />
      <SelectField
        label="Style"
        value={node.style || 'bullet'}
        options={[
          { value: 'bullet', label: 'Bullets' },
          { value: 'number', label: 'Numbers' },
        ]}
        onChange={(v) => set({ style: v }, 'step')}
      />
      <TextField
        label="Text when the list is empty"
        value={node.emptyText ?? ''}
        onChange={(v, kind) => set({ emptyText: v || undefined }, kind)}
      />
    </>
  );
}
