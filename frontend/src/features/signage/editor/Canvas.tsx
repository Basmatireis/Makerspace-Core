import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { Button } from '@carbon/react';
import type { SignageBlock } from '../../../api/generated/models';
import { SceneRenderer, ScreenFrame } from '../render/SceneRenderer';
import { sceneGridSize } from '../render/aspect';
import { overflowingBlockIds } from '../render/fit';
import { blockBoxCss, blockInnerCss, sceneFontCss, sceneTextColor } from '../render/style';
import type { RenderData } from '../render/types';
import type { Draft } from '../sceneDraft';
import { WIDGET_LABELS, type WidgetType } from '../widgets';
import { BlockToolbar, GroupToolbar, type BlockAction } from './BlockToolbar';
import { DEFAULT_MARGIN, emptyBlockAt, fitSize, nudge, type ArrangeAction } from './blockOps';
import { blockAt, isInlineText } from './canvasModel';
import { PALETTE_MIME, QUICK_PICKS, WIDGET_ICONS } from './widgetIcons';
import {
  NO_TARGETS,
  boundsOf,
  marqueeHits,
  snapMove,
  snapResize,
  snapTargets,
  type Guide,
  type Handle,
  type Rect,
} from './snapping';
import { InlineTextEditor, TextFormatBar } from './TextFormatBar';

export type Zoom = 'fit' | 0.5 | 1;

/** Screen pixels within which an edge snaps, and the pointer travel that starts a drag. */
const SNAP_PX = 6;
const DRAG_PX = 3;
/** Room around the screen for the floating toolbars. */
const PAD_X = 32;
const PAD_Y = 64;

const HANDLES: { handle: Handle; fx: number; fy: number }[] = [
  { handle: 'nw', fx: 0, fy: 0 },
  { handle: 'n', fx: 0.5, fy: 0 },
  { handle: 'ne', fx: 1, fy: 0 },
  { handle: 'e', fx: 1, fy: 0.5 },
  { handle: 'se', fx: 1, fy: 1 },
  { handle: 's', fx: 0.5, fy: 1 },
  { handle: 'sw', fx: 0, fy: 1 },
  { handle: 'w', fx: 0, fy: 0.5 },
];

const geometry = (b: SignageBlock): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
const sameGeometry = (a: readonly SignageBlock[], b: readonly SignageBlock[]) =>
  a.length === b.length &&
  a.every((block, i) => block.x === b[i].x && block.y === b[i].y && block.w === b[i].w && block.h === b[i].h);

type Live = { blocks: SignageBlock[]; guides: Guide[]; mode: 'move' | 'resize' };

export type CanvasProps = {
  draft: Draft;
  data: RenderData;
  selectedIds: readonly string[];
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (ids: string[]) => void;
  /** A finished gesture: the blocks after it (one undo step). */
  onBlocks: (blocks: SignageBlock[]) => void;
  canEdit: boolean;
  snapping: boolean;
  zoom: Zoom;
  showMargins: boolean;
  overflowIds: ReadonlySet<string>;
  onOverflow: (ids: string[]) => void;
  editingId: string | null;
  onEditText: (id: string | null) => void;
  onCommitText: (id: string, html: string) => void;
  /** The palette item being dragged, for the drop ghost. */
  dragType: WidgetType | null;
  onDropWidget: (type: WidgetType, at: { x: number; y: number } | { intoBlockId: string }) => void;
  onQuickPick: (blockId: string, type: WidgetType) => void;
  onBlockAction: (action: BlockAction) => void;
  onArrange: (action: ArrangeAction) => void;
};

/**
 * The screen at its zoom with an overlay for direct manipulation: hover, selection with eight handles, marquee, move and
 * resize with snapping guides (Alt or the snapping switch turns them off), a dimension badge, palette drops, quick
 * picks in empty blocks, inline text editing and the floating block toolbar. Pointer positions are converted from
 * screen pixels to grid units by dividing by the scale; blocks change only when a gesture ends.
 */
export function Canvas(props: CanvasProps) {
  const { draft, data, selectedIds, canEdit, zoom, editingId } = props;
  const grid = sceneGridSize(draft.aspectRatio);
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(0.5);
  const [live, setLive] = useState<Live | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [ghost, setGhost] = useState<Rect | null>(null);
  const scale = zoom === 'fit' ? fitScale : zoom;
  const blocks = live?.blocks ?? draft.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const selected = selectedIds.map((id) => byId.get(id)).filter((b): b is SignageBlock => Boolean(b));
  const single = selected.length === 1 ? selected[0] : null;

  // Fit: the largest scale (at most 100 %) that shows the whole screen with room for the toolbars.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const width = wrap.clientWidth - 2 * PAD_X;
      const height = wrap.clientHeight - 2 * PAD_Y;
      if (width <= 0 || height <= 0) return;
      setFitScale(Math.max(0.05, Math.min(1, width / grid.width, height / grid.height)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [grid.width, grid.height]);

  // Overflow is measured on the rendered blocks; rich text and fonts arrive later, so it is measured again shortly after.
  const { onOverflow } = props;
  const sceneBlocks = draft.blocks;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const check = () => onOverflow(overflowingBlockIds(box));
    check();
    const timer = setTimeout(check, 400);
    return () => clearTimeout(timer);
  }, [sceneBlocks, draft.aspectRatio, onOverflow]);

  // The block being edited in place hides its rendered content under the editable copy.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !editingId) return;
    const inner = box.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(editingId)}"] > .sg-block__in`);
    if (!inner) return;
    inner.style.visibility = 'hidden';
    return () => {
      inner.style.visibility = '';
    };
  }, [editingId]);

  // Floating toolbars stay inside the visible canvas, so the side panes never cover them.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    const wrap = wrapRef.current;
    if (!bar || !wrap) return;
    bar.style.translate = '';
    const area = wrap.getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    let shift = 0;
    if (rect.right > area.right - 8) shift = area.right - 8 - rect.right;
    if (rect.left + shift < area.left + 8) shift = area.left + 8 - rect.left;
    if (shift) bar.style.translate = `${shift}px 0`;
  });

  const toGrid = (clientX: number, clientY: number) => {
    const box = boxRef.current!.getBoundingClientRect();
    return { x: (clientX - box.left) / scale, y: (clientY - box.top) / scale };
  };

  /** Tracks the pointer until it is released; `move` gets the travel in grid units and the event. */
  const track = (
    start: PointerEvent,
    move: (dx: number, dy: number, event: globalThis.PointerEvent) => void,
    end: (moved: boolean, event: globalThis.PointerEvent) => void,
  ) => {
    let moved = false;
    const onMove = (event: globalThis.PointerEvent) => {
      const px = event.clientX - start.clientX;
      const py = event.clientY - start.clientY;
      if (!moved && Math.abs(px) + Math.abs(py) < DRAG_PX) return;
      moved = true;
      move(px / scale, py / scale, event);
    };
    const onUp = (event: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      end(moved, event);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const startTransform = (event: PointerEvent, ids: string[], handle: Handle | null) => {
    const start = draft.blocks;
    const movable = start.filter((b) => ids.includes(b.id) && !b.locked);
    if (movable.length === 0) return;
    const movableIds = movable.map((b) => b.id);
    const targets = snapTargets(start, grid, DEFAULT_MARGIN, movableIds);
    const bounds0 = boundsOf(movable.map(geometry))!;
    let next = start;
    track(
      event,
      (dx, dy, move) => {
        const snapOn = props.snapping && !move.altKey;
        const threshold = SNAP_PX / scale;
        if (handle) {
          const r0 = geometry(movable[0]);
          const result = snapOn
            ? snapResize(r0, handle, dx, dy, targets, threshold)
            : snapResize(r0, handle, dx, dy, NO_TARGETS, 0, 0);
          next = start.map((b) => (b.id === movable[0].id ? { ...b, ...result.rect } : b));
          setLive({ blocks: next, guides: result.guides, mode: 'resize' });
        } else {
          const moved = { ...bounds0, x: bounds0.x + dx, y: bounds0.y + dy };
          const result = snapOn
            ? snapMove(moved, targets, threshold)
            : { rect: { ...moved, x: Math.round(moved.x), y: Math.round(moved.y) }, guides: [] };
          next = nudge(start, movableIds, result.rect.x - bounds0.x, result.rect.y - bounds0.y);
          setLive({ blocks: next, guides: result.guides, mode: 'move' });
        }
      },
      (moved) => {
        setLive(null);
        if (moved && !sameGeometry(next, start)) props.onBlocks(next);
      },
    );
  };

  const startMarquee = (event: PointerEvent) => {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const base = additive ? [...selectedIds] : [];
    const origin = toGrid(event.clientX, event.clientY);
    const rectTo = (e: globalThis.PointerEvent): Rect => {
      const point = toGrid(e.clientX, e.clientY);
      return {
        x: Math.min(origin.x, point.x),
        y: Math.min(origin.y, point.y),
        w: Math.abs(point.x - origin.x),
        h: Math.abs(point.y - origin.y),
      };
    };
    track(
      event,
      (_dx, _dy, e) => setMarquee(rectTo(e)),
      (moved, e) => {
        setMarquee(null);
        if (!moved) {
          if (!additive) props.onSelect([]);
          return;
        }
        const hits = marqueeHits(draft.blocks, rectTo(e));
        props.onSelect([...base, ...hits.filter((id) => !base.includes(id))]);
      },
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || live) return;
    const target = event.target as Element;
    if (target.closest('[data-canvas-ui]')) return;
    if (!editingId) wrapRef.current?.focus({ preventScroll: true });
    const handle = (target as HTMLElement).dataset?.handle as Handle | undefined;
    if (handle && single && canEdit) {
      event.preventDefault();
      startTransform(event, [single.id], handle);
      return;
    }
    if (editingId) props.onEditText(null);
    const hit = blockAt(draft.blocks, toGrid(event.clientX, event.clientY));
    if (!hit) {
      startMarquee(event);
      return;
    }
    event.preventDefault();
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      props.onSelect(
        selectedIds.includes(hit.id) ? selectedIds.filter((id) => id !== hit.id) : [...selectedIds, hit.id],
      );
      return;
    }
    const group = selectedIds.length > 1 && selectedIds.includes(hit.id);
    if (!group) props.onSelect([hit.id]);
    if (canEdit && !hit.locked) startTransform(event, group ? [...selectedIds] : [hit.id], null);
  };

  // A click on the light area around the screen clears the selection and ends text editing.
  const onBackgroundPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || live || boxRef.current?.contains(event.target as Node)) return;
    if ((event.target as Element).closest('[data-canvas-ui]')) return;
    // Pressing the canvas's own scrollbars scrolls; it does not clear anything.
    const area = event.currentTarget;
    if (event.nativeEvent.offsetX > area.clientWidth || event.nativeEvent.offsetY > area.clientHeight) return;
    if (editingId) props.onEditText(null);
    if (selectedIds.length > 0 && !(event.shiftKey || event.metaKey || event.ctrlKey)) props.onSelect([]);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-canvas-ui]')) return;
    const hit = blockAt(draft.blocks, toGrid(event.clientX, event.clientY));
    if (hit && canEdit && !hit.locked && isInlineText(hit)) props.onEditText(hit.id);
  };

  const onHoverMove = (event: PointerEvent<HTMLDivElement>) => {
    if (live || marquee) return;
    const hit = (event.target as Element).closest('[data-canvas-ui]')
      ? null
      : blockAt(draft.blocks, toGrid(event.clientX, event.clientY));
    if ((hit?.id ?? null) !== props.hoverId) props.onHover(hit?.id ?? null);
  };

  // Palette drops: the ghost shows where the block lands, or the empty block it fills.
  const dropAt = (clientX: number, clientY: number, type: WidgetType) => {
    const point = toGrid(clientX, clientY);
    const into = emptyBlockAt(draft.blocks, point);
    if (into) return { ghost: geometry(byId.get(into)!), at: { intoBlockId: into } };
    const { w, h } = fitSize(type, grid);
    const snap = (value: number) => Math.round(value / 8) * 8;
    const x = snap(Math.max(0, Math.min(grid.width - w, point.x - w / 2)));
    const y = snap(Math.max(0, Math.min(grid.height - h, point.y - h / 2)));
    return { ghost: { x, y, w, h }, at: point };
  };
  const dropProps = canEdit
    ? {
        onDragOver: (event: DragEvent) => {
          if (!props.dragType) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setGhost(dropAt(event.clientX, event.clientY, props.dragType).ghost);
        },
        onDragLeave: (event: DragEvent) => {
          if (event.target === wrapRef.current) setGhost(null);
        },
        onDrop: (event: DragEvent) => {
          const type = (event.dataTransfer.getData(PALETTE_MIME) || props.dragType) as WidgetType | null;
          setGhost(null);
          if (!type || !(type in WIDGET_LABELS)) return;
          event.preventDefault();
          props.onDropWidget(type, dropAt(event.clientX, event.clientY, type).at);
        },
      }
    : {};

  const px = (rect: Rect, inset = 0): CSSProperties => ({
    left: rect.x * scale - inset,
    top: rect.y * scale - inset,
    width: rect.w * scale + 2 * inset,
    height: rect.h * scale + 2 * inset,
  });

  const guides = live?.guides ?? [];
  const hover = props.hoverId && !selectedIds.includes(props.hoverId) && !live ? byId.get(props.hoverId) : undefined;
  const groupBounds = selected.length > 1 ? boundsOf(selected.map(geometry)) : null;
  const toolbarRect = groupBounds ?? (single ? geometry(single) : null);
  const showToolbar = canEdit && toolbarRect && !live && !marquee && (!single || editingId !== single.id);
  // Above unless that would leave the padding around the screen (the toolbar is about 40 pixels high).
  const toolbarAbove = toolbarRect ? toolbarRect.y * scale + PAD_Y >= 56 : true;
  const editing = editingId ? byId.get(editingId) : undefined;
  const textColor = sceneTextColor(draft.theme);
  const index = single ? draft.blocks.findIndex((b) => b.id === single.id) : -1;

  return (
    <div
      className="sg-canvas"
      ref={wrapRef}
      role="application"
      aria-label="Screen canvas"
      aria-describedby="sg-canvas-keys"
      // The canvas is a keyboard widget: it takes the focus for the block shortcuts.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      data-canvas-region
      onPointerDown={onBackgroundPointerDown}
      {...dropProps}
    >
      <p id="sg-canvas-keys" className="sg-sr-only">
        {canEdit
          ? 'Arrow keys move the selected blocks by one unit, Shift with arrows by ten. Enter edits a text block. Delete removes the selection. Escape clears the selection.'
          : 'This screen is read-only.'}
      </p>
      <p className="sg-sr-only" role="status" aria-live="polite">
        {selected.length === 0
          ? 'Nothing selected'
          : selected.length === 1
            ? `${selected[0].name} selected`
            : `${selected.length} blocks selected`}
      </p>
      <div className="sg-canvas__inner" style={{ padding: `${PAD_Y}px ${PAD_X}px` }}>
        <div className="sg-canvas__box" ref={boxRef} style={{ width: grid.width * scale, height: grid.height * scale }}>
          <ScreenFrame aspectRatio={draft.aspectRatio} scale={scale}>
            <SceneRenderer scene={{ ...draft, blocks }} data={data} showHidden selectedBlockIds={selectedIds} />
          </ScreenFrame>
          <div
            className={`sg-canvas__overlay${live ? ' sg-canvas__overlay--dragging' : ''}`}
            data-testid="canvas-overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onHoverMove}
            onPointerLeave={() => {
              if (props.hoverId) props.onHover(null);
            }}
            onDoubleClick={onDoubleClick}
          >
            {props.showMargins && (
              <div
                className="sg-canvas__margins"
                style={px({
                  x: DEFAULT_MARGIN,
                  y: DEFAULT_MARGIN,
                  w: grid.width - 2 * DEFAULT_MARGIN,
                  h: grid.height - 2 * DEFAULT_MARGIN,
                })}
              />
            )}
            {/* Empty blocks keep their choice while another block is dragged; it is their only visible outline. */}
            {canEdit &&
              blocks
                .filter((b) => b.widget.type === 'empty' && !b.hidden && !b.locked)
                .map((b) => (
                  <QuickPicks
                    key={`quick-${b.id}`}
                    block={b}
                    style={px(geometry(b))}
                    onPick={(type) => props.onQuickPick(b.id, type)}
                  />
                ))}
            {blocks
              .filter((b) => props.overflowIds.has(b.id) && !b.hidden)
              .map((b) => (
                <div key={`overflow-${b.id}`} className="sg-canvas__overflow" style={px(geometry(b))} />
              ))}
            {hover && <div className="sg-canvas__hover" style={px(geometry(hover))} />}
            {guides.map((guide, i) => (
              <GuideLine key={i} guide={guide} grid={grid} scale={scale} />
            ))}
            {selected.length > 1 &&
              selected.map((b) => <div key={`sel-${b.id}`} className="sg-canvas__multi" style={px(geometry(b), 1)} />)}
            {groupBounds && <div className="sg-canvas__group" style={px(groupBounds, 6)} />}
            {single && <div className="sg-canvas__selection" style={px(geometry(single), 1)} />}
            {single &&
              canEdit &&
              !single.locked &&
              editingId !== single.id &&
              HANDLES.map(({ handle, fx, fy }) => (
                <div
                  key={handle}
                  className={`sg-canvas__handle sg-canvas__handle--${handle}`}
                  data-handle={handle}
                  aria-hidden="true"
                  style={{ left: (single.x + single.w * fx) * scale, top: (single.y + single.h * fy) * scale }}
                />
              ))}
            {live && toolbarRect && (
              <div
                className="sg-canvas__badge"
                style={{
                  left: (toolbarRect.x + toolbarRect.w / 2) * scale,
                  top: (toolbarRect.y + toolbarRect.h) * scale + 6,
                }}
              >
                {live.mode === 'move'
                  ? `x ${toolbarRect.x}  y ${toolbarRect.y}`
                  : `${toolbarRect.w} × ${toolbarRect.h}`}
              </div>
            )}
            {marquee && <div className="sg-canvas__marquee" style={px(marquee)} />}
            {ghost && props.dragType && <div className="sg-canvas__ghost" style={px(ghost)} />}
            {editing && (
              <div
                className="sg-canvas__edit-layer"
                style={{
                  width: grid.width,
                  height: grid.height,
                  transform: `scale(${scale})`,
                  fontFamily: sceneFontCss(draft, null),
                  color: textColor,
                }}
              >
                <InlineTextEditor
                  key={editing.id}
                  html={editing.widget.type === 'text' ? editing.widget.text : ''}
                  boxStyle={blockBoxCss(editing, {
                    sceneTextColor: textColor,
                    fontName: null,
                    backgroundUrl: editing.style.backgroundAssetId
                      ? data.assetUrl(editing.style.backgroundAssetId)
                      : null,
                  })}
                  innerStyle={blockInnerCss(editing.style)}
                  onCommit={(html) => props.onCommitText(editing.id, html)}
                />
              </div>
            )}
            {editing && (
              <div
                ref={toolbarRef}
                className="sg-canvas__toolbar"
                style={toolbarPosition(geometry(editing), scale, editing.y * scale + PAD_Y >= 56)}
              >
                <TextFormatBar onDone={() => props.onEditText(null)} />
              </div>
            )}
            {showToolbar && toolbarRect && (
              <div
                ref={toolbarRef}
                className="sg-canvas__toolbar"
                data-canvas-ui
                style={toolbarPosition(toolbarRect, scale, toolbarAbove)}
              >
                {single ? (
                  <BlockToolbar
                    block={single}
                    isFront={index === draft.blocks.length - 1}
                    isBack={index === 0}
                    onAction={props.onBlockAction}
                  />
                ) : (
                  <GroupToolbar count={selected.length} onArrange={props.onArrange} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const toolbarPosition = (rect: Rect, scale: number, above: boolean): CSSProperties =>
  above
    ? { left: Math.max(0, rect.x * scale), top: rect.y * scale - 8, transform: 'translateY(-100%)' }
    : { left: Math.max(0, rect.x * scale), top: (rect.y + rect.h) * scale + 8 };

function GuideLine({ guide, grid, scale }: { guide: Guide; grid: { width: number; height: number }; scale: number }) {
  const vertical = guide.axis === 'x';
  const line = (at: number): CSSProperties =>
    vertical
      ? { left: at * scale, top: 0, height: grid.height * scale }
      : { top: at * scale, left: 0, width: grid.width * scale };
  const kind = vertical ? 'v' : 'h';
  return (
    <>
      <div
        className={`sg-canvas__guide sg-canvas__guide--${kind}${guide.mirror ? ' sg-canvas__guide--mirror' : ''}`}
        style={line(guide.at)}
      />
      {guide.mirror && (
        <div
          className={`sg-canvas__guide sg-canvas__guide--${kind} sg-canvas__guide--axis`}
          style={line(vertical ? grid.width / 2 : grid.height / 2)}
        />
      )}
    </>
  );
}

/**
 * Fills an empty block with the choice of what it shows. Small blocks keep only the icons (their labels stay as the
 * accessible names); the space between the buttons still selects and moves the block.
 */
function QuickPicks({
  block,
  style,
  onPick,
}: {
  block: SignageBlock;
  style: CSSProperties;
  onPick: (type: WidgetType) => void;
}) {
  return (
    <div className="sg-quick" style={style}>
      <div className="sg-quick__panel" role="group" aria-label={`Choose what ${block.name} shows`} data-canvas-ui>
        <span className="sg-quick__label">What should {block.name} show?</span>
        <div className="sg-quick__items">
          {QUICK_PICKS.map((type) => (
            <Button
              key={type}
              kind="ghost"
              size="sm"
              className="sg-quick__item"
              renderIcon={WIDGET_ICONS[type]}
              title={WIDGET_LABELS[type]}
              onClick={() => onPick(type)}
            >
              <span className="sg-quick__text">{WIDGET_LABELS[type]}</span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
