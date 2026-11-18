import type {
  BarcodeBlock,
  EllipseBlock,
  GraphicBlock,
  ImageBlock,
  LineBlock,
  PictureBlock,
  QrBlock,
  RectBlock,
} from '../../model';
import { ColorField } from '../fields/ColorField';
import { CheckField, ExprField, NumField } from '../fields/Inputs';
import { SizeField } from '../fields/SizeField';
import { AssetSelect } from './AssetSelect';
import { PositionEditor } from './PositionEditor';
import { Hint, type NodeSectionProps } from './shared';

export function ImageSection({ node, set }: NodeSectionProps<ImageBlock>) {
  return (
    <>
      <NumField
        label="Height (mm)"
        value={node.height}
        step={1}
        min={1}
        onChange={(v, kind) => set({ height: v ?? 12 }, kind)}
      />
      <Hint>The logo comes from the branding settings. Nothing is loaded from the internet.</Hint>
    </>
  );
}

export function PictureSection({ node, area, set }: NodeSectionProps<PictureBlock>) {
  return (
    <>
      <PositionEditor node={node} set={set} withXY={area === 'layer'} withH />
      <AssetSelect kind="picture" value={node.asset} onChange={(v, kind) => set({ asset: v }, kind)} />
    </>
  );
}

export function GraphicSection({ node, area, set }: NodeSectionProps<GraphicBlock>) {
  return (
    <>
      <PositionEditor node={node} set={set} withXY={area === 'layer'} withH />
      <AssetSelect kind="graphic" value={node.art} onChange={(v, kind) => set({ art: v }, kind)} />
      <Hint>
        Vector artwork stored with the template. Replace it by uploading an SVG; scripts, links and external references
        are ignored.
      </Hint>
    </>
  );
}

export function CodeSection({ node, area, set }: NodeSectionProps<QrBlock | BarcodeBlock>) {
  return (
    <>
      <PositionEditor node={node} set={set} withXY={area === 'layer'} withH />
      <ExprField
        label="Content"
        value={node.value}
        helper="Text or a variable, e.g. {{order.number}}"
        onChange={(v, kind) => set({ value: v }, kind)}
      />
      {node.type === 'barcode' && (
        <CheckField
          label="Show the text below"
          checked={node.showText !== false}
          onChange={(v, kind) => set({ showText: v }, kind)}
        />
      )}
    </>
  );
}

export function ShapeSection({ node, area, set }: NodeSectionProps<LineBlock | RectBlock | EllipseBlock>) {
  return (
    <>
      <PositionEditor node={node} set={set} withXY={area === 'layer'} withH />
      <SizeField
        label="Line thickness (mm)"
        unit="mm"
        step={0.01}
        value={node.stroke}
        onChange={(v, kind) => set({ stroke: v ?? 0.3 }, kind)}
      />
      <ColorField
        label={node.type === 'line' ? 'Colour' : 'Line colour'}
        value={node.color}
        onChange={(v, kind) => set({ color: v ?? '#161616' }, kind)}
      />
      {node.type !== 'line' && (
        <ColorField label="Fill" allowNone value={node.fill} onChange={(v, kind) => set({ fill: v }, kind)} />
      )}
    </>
  );
}
