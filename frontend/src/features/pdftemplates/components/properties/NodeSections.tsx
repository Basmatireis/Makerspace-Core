import type { Block, Layer, TemplateNode } from '../../model';
import { GridSection } from './GridSection';
import { FieldsSection } from './FieldsSection';
import { CheckboxSection, InputLineSection, SignaturesSection } from './FormSections';
import {
  BoxSection,
  ColumnsSection,
  DividerSection,
  IfSection,
  LayerSection,
  SpacerSection,
  SwitchSection,
} from './LogicSections';
import { ListSection, RepeatSection } from './LoopSection';
import { CodeSection, GraphicSection, ImageSection, PictureSection, ShapeSection } from './MediaSections';
import { PositionEditor } from './PositionEditor';
import { TableSection, SheetSection } from './TableSection';
import { TextSection, ValueSection } from './TextSections';
import type { NodeSectionProps } from './shared';

/** The fields of one block type. Exhaustive: a new block type fails to compile here until it has a section. */
function TypeFields(props: NodeSectionProps) {
  const { node, area, set } = props;
  switch (node.type) {
    case 'heading':
    case 'text':
    case 'ptext':
      return (
        <>
          <TextSection node={node} area={area} set={set} />
          {node.type === 'ptext' && area === 'layer' && <PositionEditor node={node} set={set} withXY withH={false} />}
        </>
      );
    case 'value':
      return <ValueSection node={node} area={area} set={set} />;
    case 'list':
      return <ListSection node={node} area={area} set={set} />;
    case 'fields':
      return <FieldsSection node={node} area={area} set={set} />;
    case 'table':
      return <TableSection node={node} area={area} set={set} />;
    case 'sheet':
      return <SheetSection node={node} area={area} set={set} />;
    case 'repeat':
      return <RepeatSection node={node} area={area} set={set} />;
    case 'if':
      return <IfSection node={node} area={area} set={set} />;
    case 'switch':
      return <SwitchSection node={node} area={area} set={set} />;
    case 'columns':
      return <ColumnsSection node={node} area={area} set={set} />;
    case 'box':
      return <BoxSection node={node} area={area} set={set} />;
    case 'grid':
      return <GridSection node={node} area={area} set={set} />;
    case 'image':
      return <ImageSection node={node} area={area} set={set} />;
    case 'picture':
      return <PictureSection node={node} area={area} set={set} />;
    case 'graphic':
      return <GraphicSection node={node} area={area} set={set} />;
    case 'qr':
    case 'barcode':
      return <CodeSection node={node} area={area} set={set} />;
    case 'signatures':
      return <SignaturesSection node={node} area={area} set={set} />;
    case 'checkbox':
      return <CheckboxSection node={node} area={area} set={set} />;
    case 'inputline':
      return <InputLineSection node={node} area={area} set={set} />;
    case 'spacer':
      return <SpacerSection node={node} area={area} set={set} />;
    case 'divider':
      return <DividerSection node={node} area={area} set={set} />;
    case 'pagebreak':
      return null;
    case 'line':
    case 'rect':
    case 'ellipse':
      return <ShapeSection node={node} area={area} set={set} />;
    case 'layer':
      return <LayerSection node={node as Layer} area={area} set={set} />;
  }
}

/** Flow blocks have no position of their own; inside a page layer they get x, y and a width. */
const hasOwnPosition = (node: TemplateNode) =>
  ['ptext', 'line', 'rect', 'ellipse', 'picture', 'graphic', 'qr', 'barcode'].includes(node.type);

export function NodeSections(props: NodeSectionProps) {
  const { node, area, set } = props;
  const flowInLayer = area === 'layer' && node.type !== 'layer' && !hasOwnPosition(node);
  return (
    <>
      {flowInLayer && <PositionEditor node={node as Block} set={set} withXY withH={false} />}
      <TypeFields {...props} />
    </>
  );
}
