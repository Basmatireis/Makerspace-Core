import { Tile } from '@carbon/react';
import { defaultTitle, find, type Area, type Block, type TemplateNode } from '../model';
import { setProps } from '../propertyOps';
import { toolInfo } from '../toolbox';
import type { ChangeKind } from '../history';
import type { PropertiesPanelProps } from '../types';
import { PanelProvider } from './fields/PanelProvider';
import { usePanel } from './fields/panelContext';
import { TextField } from './fields/Inputs';
import { Appearance } from './properties/Appearance';
import { NodeHeader } from './properties/NodeHeader';
import { NodeNotices } from './properties/NodeNotices';
import { NodeSections } from './properties/NodeSections';
import { PagePanel } from './properties/PagePanel';
import { Hint } from './properties/shared';

function NodePanel({ node, area, props }: { node: TemplateNode; area: Area; props: PropertiesPanelProps }) {
  const { doc, edit } = usePanel();
  const set = (changes: Record<string, unknown>, kind: ChangeKind = 'typing') =>
    edit((d) => setProps(d, node.id, changes), kind);
  const misplaced = area !== 'body' && (node.type === 'sheet' || node.type === 'pagebreak');
  return (
    <div className="pdft-props">
      <NodeHeader doc={doc} node={node} onChange={props.onChange} onSelect={props.onSelect} onExpand={props.onExpand} />
      <Hint>{toolInfo(node.type).description}</Hint>
      <NodeNotices doc={doc} node={node} problems={props.problems} redacted={props.redacted} />
      <TextField
        label="Title in the structure"
        value={node.title ?? ''}
        maxLength={120}
        helper={`Empty shows “${defaultTitle(node)}”. Not printed.`}
        onChange={(v, kind) => set({ title: v || undefined }, kind)}
      />
      {misplaced && (
        <p className="pdft-warn" role="note">
          {node.type === 'sheet'
            ? 'A form table makes its own pages, so it only takes effect in the body.'
            : 'A page break only takes effect in the body.'}
        </p>
      )}
      <NodeSections node={node} area={area} set={set} />
      {node.type !== 'layer' && <Appearance node={node as Block} set={set} />}
    </div>
  );
}

/** Properties tab of the right pane: the selected node, or the page setup. */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const { doc, selectedId, schema, onChange } = props;
  const at = selectedId && selectedId !== 'page' ? find(doc, selectedId) : null;
  return (
    <div data-testid="properties-panel" className="pdft-panel">
      <PanelProvider doc={doc} schema={schema} onChange={onChange}>
        {selectedId === 'page' ? (
          <PagePanel />
        ) : at ? (
          <NodePanel key={at.node.id} node={at.node} area={at.area} props={props} />
        ) : (
          <div className="pdft-props">
            <h2 className="pdft-nodehead__title">{doc.name}</h2>
            <Hint>
              Select a block in the structure or click into the preview to edit it. Use the tools below the page to add
              blocks.
            </Hint>
            <Tile>
              <b>How templates work.</b> The body flows across pages; tables and loops break onto new pages and repeat
              their header. Page layers hold fixed-position elements such as a letterhead or a form frame. Variables
              come from the document’s data and are checked when you save.
            </Tile>
          </div>
        )}
      </PanelProvider>
    </div>
  );
}
