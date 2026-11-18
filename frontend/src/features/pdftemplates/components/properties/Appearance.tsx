import type { ReactNode } from 'react';
import type { Block } from '../../model';
import { textStyleSwitch } from '../../propertyOps';
import { ColorField } from '../fields/ColorField';
import { usePanel } from '../fields/panelContext';
import { SizeField } from '../fields/SizeField';
import { PartStyleSelect, TextStyleSelect } from '../fields/TextStyleSelect';
import type { NodeSectionProps } from './shared';

/** Colours and text styles of the parts of compound blocks, as in the prototype's "Appearance". */
export function Appearance({ node, set }: Pick<NodeSectionProps<Block>, 'node' | 'set'>) {
  const { doc } = usePanel();
  const style = (label: string, key: string, value: string | undefined) => (
    <PartStyleSelect key={key} label={label} value={value} onChange={(v, kind) => set({ [key]: v }, kind)} />
  );
  const colour = (label: string, key: string, value: string | undefined, allowNone = true) => (
    <ColorField
      key={key}
      label={label}
      allowNone={allowNone}
      value={value}
      onChange={(v, kind) => set({ [key]: v }, kind)}
    />
  );
  /** A line colour: "None" is stored as `transparent`, since an absent value means the default line. */
  const line = (label: string, key: string, value: string | undefined, fallback: string) => (
    <ColorField
      key={key}
      label={label}
      allowNone
      value={value === 'transparent' ? undefined : (value ?? fallback)}
      onChange={(v, kind) => set({ [key]: v ?? 'transparent' }, kind)}
    />
  );

  const parts = ((): ReactNode[] | null => {
    switch (node.type) {
      case 'table':
        return [
          style('Header text', 'headerStyle', node.headerStyle),
          colour('Header background', 'headerFill', node.headerFill),
          line('Header line', 'headerRule', node.headerRule, '#161616'),
          style('Row text', 'bodyStyle', node.bodyStyle),
          style('Second lines and empty text', 'subStyle', node.subStyle),
          line('Row lines', 'rowRule', node.rowRule, '#c6c6c6'),
          colour('Every second row', 'zebra', node.zebra),
          style('Total rows text', 'totalsStyle', node.totalsStyle),
        ];
      case 'fields':
        return [
          style('Label text', 'labelStyle', node.labelStyle),
          style('Value text', 'valueStyle', node.valueStyle),
          colour('Background', 'fill', node.fill),
          ...(node.boxed ? [line('Row lines', 'ruleColor', node.ruleColor, '#3c3c3c')] : []),
        ];
      case 'list':
        return [
          <TextStyleSelect
            key="ts"
            value={node.textStyle}
            onChange={(id) =>
              set(textStyleSwitch(doc.styles, node.textStyle, id, ['size', 'weight', 'color', 'lineHeight']), 'step')
            }
          />,
          ...(node.textStyle
            ? []
            : [
                <SizeField
                  key="size"
                  label="Size (pt)"
                  unit="pt"
                  step={0.5}
                  value={node.size ?? doc.page.baseSize}
                  onChange={(v, kind) => set({ size: v }, kind)}
                />,
                colour('Text colour', 'color', node.color ?? '#161616', false),
              ]),
        ];
      case 'checkbox':
        return [
          <TextStyleSelect
            key="ts"
            value={node.textStyle}
            onChange={(id) => set(textStyleSwitch(doc.styles, node.textStyle, id, ['size', 'color']), 'step')}
          />,
          ...(node.textStyle ? [] : [colour('Text colour', 'color', node.color ?? '#161616', false)]),
          colour('Box', 'boxColor', node.boxColor ?? '#161616', false),
        ];
      case 'signatures':
        return [
          style('Label text', 'labelStyle', node.labelStyle),
          line('Signature line', 'lineColor', node.lineColor, '#3c3c3c'),
        ];
      case 'inputline':
        return [
          style('Label text', 'labelStyle', node.labelStyle),
          line('Line', 'lineColor', node.lineColor, '#161616'),
        ];
      case 'sheet':
        return [
          colour('Text', 'textColor', node.textColor ?? node.color, false),
          colour('Second lines', 'subColor', node.subColor),
          style('Header text', 'headerStyle', node.headerStyle),
          style('Row text', 'bodyStyle', node.bodyStyle),
          style('Second lines text', 'subStyle', node.subStyle),
          style('Sum rows text', 'totalsStyle', node.totalsStyle),
        ];
      case 'graphic':
        return [colour('Artwork colour', 'color', node.color)];
      case 'value':
        return [style('Label text', 'labelStyle', node.labelStyle)];
      default:
        return null;
    }
  })();
  if (!parts) return null;
  return (
    <section className="pdft-appearance" aria-label="Appearance">
      <h3 className="pdft-subhead">Appearance</h3>
      {parts}
    </section>
  );
}
