import { useState, type KeyboardEvent } from 'react';
import { Button, IconButton } from '@carbon/react';
import { Locked, Unlocked, View, ViewOff, WarningAltFilled } from '@carbon/icons-react';
import type { SignageBlock } from '../../../api/generated/models';
import { orderBlock, reorderFromList, updateBlocks } from './blockOps';
import { WIDGET_ICONS } from './widgetIcons';

type Drop = { id: string; above: boolean };

/**
 * The scene's blocks, front first. A click selects, ⇧/⌘-click adds or removes; dragging a row or Alt with the arrow
 * keys changes the stacking order. Rows show a warning when the content does not fit, and toggles to lock and hide.
 */
export function BlocksList({
  blocks,
  selectedIds,
  overflowIds,
  canEdit,
  onSelect,
  onBlocks,
  onHover,
}: {
  blocks: readonly SignageBlock[];
  selectedIds: readonly string[];
  overflowIds: ReadonlySet<string>;
  canEdit: boolean;
  onSelect: (ids: string[]) => void;
  onBlocks: (blocks: SignageBlock[]) => void;
  onHover: (id: string | null) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const rows = [...blocks].reverse();

  const select = (id: string, additive: boolean) => {
    if (!additive) onSelect([id]);
    else onSelect(selectedIds.includes(id) ? selectedIds.filter((other) => other !== id) : [...selectedIds, id]);
  };

  const onKeyDown = (event: KeyboardEvent, id: string) => {
    if (!canEdit || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    // The list runs front first: up moves a block towards the front.
    const next = orderBlock(blocks, id, event.key === 'ArrowUp' ? 'front' : 'back');
    if (next !== blocks) onBlocks(next);
    // The row moved; keep the focus on it.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"] .sg-layers__name`)?.focus(),
    );
  };

  const toggle = (id: string, field: 'hidden' | 'locked') =>
    onBlocks(updateBlocks(blocks, [id], (b) => ({ ...b, [field]: !b[field] })));

  return (
    <section className="sg-layers" aria-labelledby="sg-layers-title">
      <h2 id="sg-layers-title" className="sg-pane__title">
        Blocks
      </h2>
      <p className="sg-pane__hint">Top first. Drag to reorder, ⇧-click to select several.</p>
      <p id="sg-layers-keys" className="cds--visually-hidden">
        Alt with the up or down arrow changes the order.
      </p>
      {rows.length === 0 ? (
        <p className="sg-pane__hint">No blocks yet. Add one above.</p>
      ) : (
        <ul className="sg-layers__list">
          {rows.map((block) => {
            const Icon = WIDGET_ICONS[block.widget.type];
            const selected = selectedIds.includes(block.id);
            const classes = [
              'sg-layers__row',
              selected ? 'sg-layers__row--selected' : '',
              block.hidden ? 'sg-layers__row--hidden' : '',
              dragId === block.id ? 'sg-layers__row--dragging' : '',
              drop?.id === block.id ? `sg-layers__row--drop-${drop.above ? 'above' : 'below'}` : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <li
                key={block.id}
                className={classes}
                data-layer-id={block.id}
                draggable={canEdit}
                onPointerEnter={() => onHover(block.id)}
                onPointerLeave={() => onHover(null)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', block.name);
                  setDragId(block.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDrop(null);
                }}
                onDragOver={(event) => {
                  if (!dragId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  const above = event.clientY < rect.top + rect.height / 2;
                  setDrop(block.id === dragId ? null : { id: block.id, above });
                }}
                onDrop={(event) => {
                  if (!dragId) return;
                  event.preventDefault();
                  const next = drop ? reorderFromList(blocks, dragId, drop.id, drop.above) : null;
                  setDragId(null);
                  setDrop(null);
                  if (next && next !== blocks) onBlocks(next);
                }}
              >
                <Button
                  type="button"
                  kind="ghost"
                  size="sm"
                  className="sg-layers__name"
                  aria-pressed={selected}
                  aria-describedby={canEdit ? 'sg-layers-keys' : undefined}
                  onClick={(event) => select(block.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                  onKeyDown={(event) => onKeyDown(event, block.id)}
                >
                  <Icon aria-hidden="true" />
                  <span className="sg-layers__label">{block.name}</span>
                </Button>
                {overflowIds.has(block.id) && (
                  <WarningAltFilled className="sg-layers__warning" role="img" aria-label="Content does not fit">
                    <title>Content does not fit</title>
                  </WarningAltFilled>
                )}
                {canEdit ? (
                  <>
                    <IconButton
                      label={block.locked ? `Unlock ${block.name}` : `Lock ${block.name}`}
                      kind="ghost"
                      size="sm"
                      align="left"
                      className={block.locked ? 'sg-layers__toggle--on' : 'sg-layers__toggle'}
                      onClick={() => toggle(block.id, 'locked')}
                    >
                      {block.locked ? <Locked /> : <Unlocked />}
                    </IconButton>
                    <IconButton
                      label={block.hidden ? `Show ${block.name}` : `Hide ${block.name} on the display`}
                      kind="ghost"
                      size="sm"
                      align="left"
                      className={block.hidden ? 'sg-layers__toggle--on' : 'sg-layers__toggle'}
                      onClick={() => toggle(block.id, 'hidden')}
                    >
                      {block.hidden ? <ViewOff /> : <View />}
                    </IconButton>
                  </>
                ) : (
                  <>
                    {block.locked && <Locked aria-label="Locked" role="img" />}
                    {block.hidden && <ViewOff aria-label="Hidden" role="img" />}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
