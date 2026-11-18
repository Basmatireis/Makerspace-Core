import { NumField } from '../fields/Inputs';
import { Hint, Row4, type NodeSectionProps } from './shared';
import type { Block } from '../../model';

/** x, y, w and h of an element in mm. Page-layer elements can also be moved and resized in the preview. */
export function PositionEditor({
  node,
  set,
  withXY,
  withH,
  withW = true,
}: Pick<NodeSectionProps<Block>, 'node' | 'set'> & { withXY: boolean; withH: boolean; withW?: boolean }) {
  const value = (key: 'x' | 'y' | 'w' | 'h') => node[key];
  const field = (key: 'x' | 'y' | 'w' | 'h', label: string) => (
    <NumField
      key={key}
      label={label}
      value={value(key)}
      step={0.01}
      min={0}
      onChange={(v, kind) => set({ [key]: v ?? 0 }, kind)}
    />
  );
  return (
    <>
      {withXY && <Hint>Position on the page (mm) · or drag it in the preview</Hint>}
      <Row4>
        {withXY && field('x', 'x mm')}
        {withXY && field('y', 'y mm')}
        {withW && field('w', 'w mm')}
        {withH && field('h', 'h mm')}
      </Row4>
    </>
  );
}
