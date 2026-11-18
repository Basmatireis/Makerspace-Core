import type { Align, ListBlock, PTextBlock, HeadingBlock, TextBlock, TextWeight, ValueBlock } from '../../model';
import { textStyleSwitch, type TextStyleKey } from '../../propertyOps';
import { ColorField } from '../fields/ColorField';
import { ExprField, NumField, SelectField } from '../fields/Inputs';
import { ALIGN_OPTIONS, WEIGHT_OPTIONS } from '../fields/options';
import { usePanel } from '../fields/panelContext';
import { SizeField } from '../fields/SizeField';
import { TextStyleSelect } from '../fields/TextStyleSelect';
import { Row2, type NodeSectionProps } from './shared';

const weight = (v: string) => Number(v) as TextWeight;

/** Text style, or its parts (size, weight, colour, line height) when the block has none: shared by text-like blocks. */
export function TextLook({
  node,
  set,
  keys,
  defaultSize,
  defaultWeight = 400,
  styleLabel,
  withLineHeight,
}: Pick<NodeSectionProps<TextBlock | HeadingBlock | PTextBlock | ValueBlock | ListBlock>, 'set'> & {
  node: { textStyle?: string; size?: number | string; weight?: TextWeight; color?: string; lineHeight?: number };
  keys: readonly TextStyleKey[];
  defaultSize: number;
  defaultWeight?: TextWeight;
  styleLabel?: string;
  withLineHeight?: boolean;
}) {
  const { doc } = usePanel();
  return (
    <>
      <TextStyleSelect
        label={styleLabel}
        value={node.textStyle}
        onChange={(id) => set(textStyleSwitch(doc.styles, node.textStyle, id, keys), 'step')}
      />
      {!node.textStyle && (
        <>
          <Row2>
            <SizeField
              label="Size (pt)"
              unit="pt"
              step={0.5}
              min={1}
              value={node.size ?? defaultSize}
              onChange={(v, kind) => set({ size: v }, kind)}
            />
            {keys.includes('weight') && (
              <SelectField
                label="Weight"
                value={String(node.weight ?? defaultWeight)}
                options={WEIGHT_OPTIONS}
                onChange={(v, kind) => set({ weight: weight(v) }, kind)}
              />
            )}
          </Row2>
          {keys.includes('color') && (
            <ColorField
              label="Colour"
              value={node.color ?? '#161616'}
              onChange={(v, kind) => set({ color: v }, kind)}
            />
          )}
          {withLineHeight && (
            <NumField
              label="Line height"
              value={node.lineHeight}
              step={0.05}
              min={0.8}
              max={3}
              helper="Empty = the document's default"
              onChange={(v, kind) => set({ lineHeight: v }, kind)}
            />
          )}
        </>
      )}
    </>
  );
}

const TEXT_KEYS = ['size', 'weight', 'color', 'lineHeight'] as const;

export function TextSection({ node, set }: NodeSectionProps<TextBlock | HeadingBlock | PTextBlock>) {
  const { doc } = usePanel();
  return (
    <>
      <ExprField
        area
        label="Text"
        value={node.text}
        helper="Insert values with {{variable | filter}}, e.g. {{amounts.total | currency}}"
        onChange={(v, kind) => set({ text: v }, kind)}
      />
      <TextLook
        node={node}
        set={set}
        keys={TEXT_KEYS}
        defaultSize={node.type === 'heading' ? 17 : doc.page.baseSize}
        defaultWeight={node.type === 'heading' ? 600 : 400}
        withLineHeight
      />
      <SelectField
        label="Alignment"
        value={node.align ?? 'left'}
        options={ALIGN_OPTIONS}
        onChange={(v) => set({ align: v as Align }, 'step')}
      />
    </>
  );
}

export function ValueSection({ node, set }: NodeSectionProps<ValueBlock>) {
  return (
    <>
      <ExprField label="Label" value={node.label} onChange={(v, kind) => set({ label: v }, kind)} />
      <ExprField
        area
        rows={2}
        label="Value"
        value={node.value}
        helper="e.g. {{amounts.total | currency}}"
        onChange={(v, kind) => set({ value: v }, kind)}
      />
      <TextLook node={node} set={set} keys={['size', 'weight', 'color']} defaultSize={16} />
      <SelectField
        label="Alignment"
        value={node.align ?? 'left'}
        options={ALIGN_OPTIONS}
        onChange={(v) => set({ align: v as Align }, 'step')}
      />
    </>
  );
}
