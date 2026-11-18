import { TextInput } from '@carbon/react';
import { ChevronDown, Draggable } from '../icons';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  canDrop,
  describe,
  paperLabel,
  defaultTitle,
  type Container,
  type TemplateDocument,
  type TemplateNode,
  type ToolType,
} from '../model';
import { iconTone, PAGE_ICON, toolInfo } from '../toolbox';
import { buildRows, dropSpot, type DropKind, type TreeRow } from '../treeRows';

export interface StructureTreeProps {
  doc: TemplateDocument;
  /** A node id, `'page'` or null. */
  selectedId: string | null;
  /** The person's expand/collapse choices by row key. */
  open: Readonly<Record<string, boolean>>;
  /** The active insert tool: a click on a spot inserts there. */
  tool: ToolType | null;
  /** Nodes with an error problem get a red dot. */
  errorIds: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onMove: (id: string, container: Container, index: number) => void;
  onMoveBy: (id: string, delta: -1 | 1) => void;
  onRename: (id: string, title: string) => void;
  onInsert: (container: Container, index: number) => void;
}

const INDENT = 20;
const pad = (depth: number, extra = 0) => 8 + depth * INDENT + extra;

/**
 * The structure of the template. Carbon has no draggable tree (its TreeView cannot reorder or drop into containers), so
 * this is a handwritten WAI-ARIA tree over a flat list of rows; the buttons, text input and icons are Carbon's.
 */
export function StructureTree({
  doc,
  selectedId,
  open,
  tool,
  errorIds,
  onToggle,
  onSelect,
  onHover,
  onMove,
  onMoveBy,
  onRename,
  onInsert,
}: StructureTreeProps) {
  const rows = useMemo(() => buildRows(doc, open), [doc, open]);
  const list = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<{ id: string; type: TemplateNode['type'] } | null>(null);
  const [indicator, setIndicator] = useState<{ key: string; kind: DropKind } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // A selection made on the page scrolls to its row.
  useEffect(() => {
    if (!selectedId) return;
    list.current?.querySelector(`[data-row-key="${CSS.escape(selectedId)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const spotAt = (row: TreeRow, event: MouseEvent | DragEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return dropSpot(doc, row, box.height ? (event.clientY - box.top) / box.height : 0.5);
  };

  const dragProps = (row: TreeRow) => {
    if (row.kind !== 'node') return {};
    return {
      draggable: renaming !== row.key,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.node.id);
        setDragging({ id: row.node.id, type: row.node.type });
      },
      onDragEnd: () => {
        setDragging(null);
        setIndicator(null);
      },
    };
  };
  const dropProps = (row: TreeRow) => {
    if (row.kind === 'page') return {};
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!dragging) return;
        const spot = spotAt(row, event);
        if (!spot || !canDrop(doc, dragging, spot.container)) {
          event.dataTransfer.dropEffect = 'none';
          setIndicator(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setIndicator((now) =>
          now?.key === row.key && now.kind === spot.kind ? now : { key: row.key, kind: spot.kind },
        );
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setIndicator((now) => (now?.key === row.key ? null : now));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        const spot = spotAt(row, event);
        const moved = dragging;
        setIndicator(null);
        setDragging(null);
        if (moved && spot) onMove(moved.id, spot.container, spot.index);
      },
      // Tool mode: the spot under the pointer shows an insertion line, a click inserts there.
      onMouseMove: (event: MouseEvent<HTMLElement>) => {
        if (!tool) return;
        const spot = spotAt(row, event);
        if (spot && canDrop(doc, { type: tool }, spot.container))
          setIndicator((now) =>
            now?.key === row.key && now.kind === spot.kind ? now : { key: row.key, kind: spot.kind },
          );
        else setIndicator(null);
      },
    };
  };

  const onToolClick = (event: MouseEvent<HTMLUListElement>) => {
    if (!tool) return;
    const li = (event.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
    const row = rows.find((r) => r.key === li?.dataset.rowKey);
    if (!li || !row) return;
    event.stopPropagation();
    event.preventDefault();
    const box = li.getBoundingClientRect();
    const spot = dropSpot(doc, row, box.height ? (event.clientY - box.top) / box.height : 0.5);
    setIndicator(null);
    if (spot && canDrop(doc, { type: tool }, spot.container)) onInsert(spot.container, spot.index);
  };

  const focusNeighbour = (from: HTMLElement, delta: -1 | 1) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    items[items.indexOf(from) + delta]?.focus();
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, row: TreeRow) => {
    if (event.target !== event.currentTarget) return;
    const li = event.currentTarget;
    const toggle = (value: boolean) => {
      if (row.kind === 'section' || (row.kind === 'node' && row.inner)) onToggle(row.key, value);
    };
    if (event.key === 'ArrowUp' && !event.altKey) return (event.preventDefault(), focusNeighbour(li, -1));
    if (event.key === 'ArrowDown' && !event.altKey) return (event.preventDefault(), focusNeighbour(li, 1));
    if (event.key === 'ArrowLeft') return (event.preventDefault(), toggle(false));
    if (event.key === 'ArrowRight') return (event.preventDefault(), toggle(true));
    if (row.kind === 'section' && (event.key === 'Enter' || event.key === ' '))
      return (event.preventDefault(), onToggle(row.key, !row.open));
    if (row.kind === 'page' && (event.key === 'Enter' || event.key === ' '))
      return (event.preventDefault(), onSelect('page'));
    if (row.kind !== 'node') return;
    if (event.key === 'F2') return (event.preventDefault(), setRenaming(row.key));
    if (event.key === 'Enter' || event.key === ' ') return (event.preventDefault(), onSelect(row.node.id));
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      onMoveBy(row.node.id, event.key === 'ArrowUp' ? -1 : 1);
    }
  };

  const markers = (row: TreeRow) =>
    [
      indicator?.key === row.key ? `pdft-drop--${indicator.kind}` : '',
      dragging && row.kind === 'node' && row.node.id === dragging.id ? 'pdft-row--dragging' : '',
    ]
      .filter(Boolean)
      .join(' ');

  const guides = (depth: number) =>
    Array.from({ length: depth }, (_, d) => (
      <span key={d} className="pdft-guide" style={{ insetInlineStart: 8 + d * INDENT + 7 }} />
    ));

  return (
    <ul
      ref={list}
      role="tree"
      aria-label="Template structure"
      className={`pdft-tree${tool ? ' pdft-tree--tool' : ''}`}
      onClickCapture={onToolClick}
      onMouseLeave={() => tool && setIndicator(null)}
    >
      {rows.map((row) => {
        switch (row.kind) {
          case 'page':
            return (
              <li
                key={row.key}
                role="treeitem"
                aria-selected={selectedId === 'page'}
                aria-level={1}
                tabIndex={0}
                data-row-key="page"
                className={`pdft-row pdft-row--page${selectedId === 'page' ? ' pdft-row--sel' : ''}`}
                style={{ paddingInlineStart: pad(0) }}
                onClick={() => onSelect('page')}
                onKeyDown={(event) => onRowKeyDown(event, row)}
              >
                <span className="pdft-tw" />
                <PAGE_ICON size={16} className="pdft-ic" />
                <span className="pdft-lines">
                  <span className="pdft-l1 pdft-l1--strong">Page setup</span>
                  <span className="pdft-l2">
                    {paperLabel(doc.page)} · {doc.page.font} {doc.page.baseSize} pt · margins{' '}
                    {doc.page.margins.join('/')} mm
                  </span>
                </span>
              </li>
            );
          case 'section':
            return (
              <li
                key={row.key}
                role="treeitem"
                aria-expanded={row.open}
                aria-selected={false}
                aria-level={1}
                tabIndex={0}
                data-row-key={row.key}
                className={`pdft-row pdft-row--section ${markers(row)}`}
                onKeyDown={(event) => onRowKeyDown(event, row)}
                {...dropProps(row)}
              >
                <Twisty open={row.open} wide onToggle={() => onToggle(row.key, !row.open)} />
                <span className="pdft-section-text">
                  <span className="pdft-section-title">
                    {row.title}
                    <span className="pdft-count">{row.count}</span>
                  </span>
                  <span className="pdft-section-desc">{row.description}</span>
                </span>
              </li>
            );
          case 'branch':
          case 'empty':
            return (
              <li
                key={row.key}
                role="none"
                data-row-key={row.key}
                className={`pdft-row pdft-row--branch ${markers(row)}`}
                style={{ paddingInlineStart: pad(row.depth, 24) }}
                {...dropProps(row)}
              >
                {guides(row.depth)}
                {row.kind === 'branch' ? row.label : row.text}
              </li>
            );
          case 'node': {
            const node = row.node;
            const d = describe(node);
            const Icon = toolInfo(node.type).icon;
            const tone = iconTone(node.type);
            const selected = selectedId === node.id;
            return (
              <li
                key={row.key}
                role="treeitem"
                aria-selected={selected}
                aria-level={row.depth + 1}
                aria-expanded={row.inner ? row.open : undefined}
                tabIndex={0}
                data-row-key={node.id}
                className={`pdft-row pdft-row--node${d.compact ? ' pdft-row--compact' : ''}${selected ? ' pdft-row--sel' : ''} ${markers(row)}`}
                style={{ paddingInlineStart: pad(row.depth) }}
                onClick={() => onSelect(node.id)}
                onMouseEnter={() => onHover(node.id)}
                onMouseLeave={() => onHover(null)}
                onKeyDown={(event) => onRowKeyDown(event, row)}
                {...dragProps(row)}
                {...dropProps(row)}
              >
                {guides(row.depth)}
                {row.inner ? (
                  <Twisty open={row.open} onToggle={() => onToggle(row.key, !row.open)} />
                ) : (
                  <span className="pdft-tw" />
                )}
                <Icon size={16} className={`pdft-ic${tone ? ` pdft-ic--${tone}` : ''}`} />
                <span className="pdft-lines">
                  {renaming === row.key ? (
                    <RenameField
                      node={node}
                      onDone={(title) => {
                        setRenaming(null);
                        if (title !== null) onRename(node.id, title);
                      }}
                    />
                  ) : (
                    <span
                      className={`pdft-l1${d.strong ? ' pdft-l1--strong' : ''}${d.untitled ? ' pdft-l1--untitled' : ''}`}
                      title="Double-click or F2 to rename"
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        setRenaming(row.key);
                      }}
                    >
                      {d.l1}
                    </span>
                  )}
                  {d.l2 && <span className="pdft-l2">{d.l2}</span>}
                </span>
                {errorIds.has(node.id) && (
                  <span className="pdft-err" role="img" aria-label="Has problems" title="Has problems" />
                )}
                <Draggable size={16} className="pdft-grip" aria-hidden="true" />
              </li>
            );
          }
        }
      })}
    </ul>
  );
}

function Twisty({ open, wide, onToggle }: { open: boolean; wide?: boolean; onToggle: () => void }) {
  // Keyboard users expand with the arrow keys of the row, so the button stays out of the tab order.
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className={`pdft-tw${wide ? ' pdft-tw--wide' : ''}${open ? '' : ' pdft-tw--closed'}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronDown size={16} />
    </button>
  );
}

function RenameField({ node, onDone }: { node: TemplateNode; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(node.title ?? '');
  const done = useRef(false);
  // Entering rename mode is the person's own action, so focus moves to the field.
  const focus = (input: HTMLInputElement | null) => input?.focus();
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? value : null);
  };
  return (
    <TextInput
      id={`pdft-rename-${node.id}`}
      size="sm"
      hideLabel
      labelText="Title in the structure"
      placeholder={defaultTitle(node)}
      value={value}
      ref={focus}
      draggable={false}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
