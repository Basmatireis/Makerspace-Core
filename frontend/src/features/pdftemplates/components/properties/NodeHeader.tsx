import { IconButton, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { ArrowDown, ArrowUp, Copy, Move, TrashCan } from '../../icons';
import {
  canDrop,
  containerKey,
  find,
  getContainer,
  places,
  sameContainer,
  TYPE_LABELS,
  type Container,
  type TemplateDocument,
  type TemplateNode,
} from '../../model';
import { duplicateNode, moveBy, moveNode, removeNode, type EditResult } from '../../ops';
import { KEYS } from '../../../signage/editor/useEditorKeys';
import { toolInfo } from '../../toolbox';
import type { ChangeKind } from '../../history';

/**
 * Type icon and name of the selected node, with move up/down, "Move to…" (the keyboard way into another container,
 * next to dragging in the tree), duplicate and delete.
 */
export function NodeHeader({
  doc,
  node,
  onChange,
  onSelect,
  onExpand,
}: {
  doc: TemplateDocument;
  node: TemplateNode;
  onChange: (next: TemplateDocument, kind?: ChangeKind) => void;
  onSelect: (id: string | null) => void;
  onExpand?: (ids: string[]) => void;
}) {
  const at = find(doc, node.id);
  const siblings = at ? (getContainer(doc, at.container)?.length ?? 0) : 0;
  const Icon = toolInfo(node.type).icon;
  const apply = (result: EditResult | null) => {
    if (!result) return;
    onChange(result.doc, 'step');
    onSelect(result.select);
    onExpand?.(result.expand);
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
      <OverflowMenu
        size="sm"
        flipped
        renderIcon={Move}
        aria-label="Move to…"
        iconDescription="Move to…"
        menuOptionsClass="pdft-flyout pdft-flyout--places"
      >
        {targets(doc, node, at?.container, at?.index).map(({ label, container, index }) => (
          <OverflowMenuItem
            key={containerKey(container)}
            itemText={label}
            title={label}
            onClick={() => apply(moveNode(doc, node.id, container, index))}
          />
        ))}
      </OverflowMenu>
      <IconButton
        label={`Duplicate (${KEYS.mod}D)`}
        kind="ghost"
        size="sm"
        onClick={() => apply(duplicateNode(doc, node.id))}
      >
        <Copy />
      </IconButton>
      <IconButton
        label={`Delete (${KEYS.del})`}
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

/** Every valid place for the node, each at the end of its list; the place it already is last in is left out. */
function targets(doc: TemplateDocument, node: TemplateNode, from: Container | undefined, index: number | undefined) {
  return places(doc, node.id)
    .filter((place) => canDrop(doc, { id: node.id, type: node.type }, place.container))
    .map((place) => ({ ...place, index: getContainer(doc, place.container)?.length ?? 0 }))
    .filter((place) => !(from && sameContainer(from, place.container) && index === place.index - 1));
}
