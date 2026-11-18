import { IconButton } from '@carbon/react';
import { ArrowDown, ArrowUp, Copy, TrashCan } from '../../icons';
import { find, getContainer, TYPE_LABELS, type TemplateDocument, type TemplateNode } from '../../model';
import { duplicateNode, moveBy, removeNode, type EditResult } from '../../ops';
import { toolInfo } from '../../toolbox';
import type { ChangeKind } from '../../history';

/** Type icon and name of the selected node, with move up/down, duplicate and delete. */
export function NodeHeader({
  doc,
  node,
  onChange,
  onSelect,
}: {
  doc: TemplateDocument;
  node: TemplateNode;
  onChange: (next: TemplateDocument, kind?: ChangeKind) => void;
  onSelect: (id: string | null) => void;
}) {
  const at = find(doc, node.id);
  const siblings = at ? (getContainer(doc, at.container)?.length ?? 0) : 0;
  const Icon = toolInfo(node.type).icon;
  const apply = (result: EditResult | null) => {
    if (!result) return;
    onChange(result.doc, 'step');
    onSelect(result.select);
  };
  return (
    <div className="pdft-nodehead">
      <h2 className="pdft-nodehead__title">
        <Icon size={20} />
        {TYPE_LABELS[node.type]}
      </h2>
      <IconButton
        label="Move up"
        kind="ghost"
        size="sm"
        disabled={!at || at.index === 0}
        onClick={() => apply(moveBy(doc, node.id, -1))}
      >
        <ArrowUp />
      </IconButton>
      <IconButton
        label="Move down"
        kind="ghost"
        size="sm"
        disabled={!at || at.index >= siblings - 1}
        onClick={() => apply(moveBy(doc, node.id, 1))}
      >
        <ArrowDown />
      </IconButton>
      <IconButton label="Duplicate" kind="ghost" size="sm" onClick={() => apply(duplicateNode(doc, node.id))}>
        <Copy />
      </IconButton>
      <IconButton
        label="Delete"
        kind="ghost"
        size="sm"
        align="bottom-end"
        onClick={() => apply(removeNode(doc, node.id))}
      >
        <TrashCan />
      </IconButton>
    </div>
  );
}
