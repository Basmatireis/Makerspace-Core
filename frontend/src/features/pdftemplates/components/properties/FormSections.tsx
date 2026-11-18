import type { CheckboxBlock, InputLineBlock, SignaturesBlock } from '../../model';
import { ConditionEditor } from '../fields/ConditionEditor';
import { ExprField, NumField } from '../fields/Inputs';
import { ItemCard, ItemsEditor, type NodeSectionProps } from './shared';
import { removeAt } from '../../listOps';

export function SignaturesSection({ node, set }: NodeSectionProps<SignaturesBlock>) {
  const labels = node.labels;
  return (
    <>
      <ItemsEditor
        title="Fields (one signature line each)"
        addLabel="Add field"
        onAdd={() => set({ labels: [...labels, 'Signature'] }, 'step')}
      >
        {labels.map((label, i) => (
          <ItemCard
            key={i}
            removeLabel="Remove field"
            onRemove={labels.length > 1 ? () => set({ labels: removeAt(labels, i) }, 'step') : undefined}
          >
            <ExprField
              label={`Label ${i + 1}`}
              value={label}
              onChange={(v, kind) => set({ labels: labels.map((l, j) => (j === i ? v : l)) }, kind)}
            />
          </ItemCard>
        ))}
      </ItemsEditor>
      <NumField
        label="Space above the line (mm)"
        value={node.height}
        step={1}
        min={0}
        onChange={(v, kind) => set({ height: v ?? 0 }, kind)}
      />
    </>
  );
}

export function CheckboxSection({ node, set }: NodeSectionProps<CheckboxBlock>) {
  return (
    <>
      <ExprField label="Label" value={node.label} onChange={(v, kind) => set({ label: v }, kind)} />
      <ConditionEditor
        title="Ticked when"
        value={node.when ?? { path: '', op: 'exists' }}
        onChange={(when, kind) => set({ when }, kind)}
      />
    </>
  );
}

export function InputLineSection({ node, set }: NodeSectionProps<InputLineBlock>) {
  return (
    <>
      <ExprField label="Label" value={node.label} onChange={(v, kind) => set({ label: v }, kind)} />
      <NumField
        label="Line width (mm)"
        value={node.lineWidth}
        step={1}
        min={0}
        helper="Empty = to the edge"
        onChange={(v, kind) => set({ lineWidth: v && v > 0 ? v : undefined }, kind)}
      />
    </>
  );
}
