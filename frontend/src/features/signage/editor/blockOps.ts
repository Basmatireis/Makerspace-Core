// Pure editing model of the screen editor: every operation takes the scene's blocks (array order = stacking order, last
// on top) and returns a new array. Inputs are never mutated. An operation that changes nothing returns the same array,
// so callers can skip a history entry by comparing references. Locked blocks are never moved, resized, arranged or
// deleted by group operations. Geometry is integers within the API limits.
import type { SignageBlock, SignageBlockStyle } from '../../../api/generated/models';
import { isMediaWidget, textSizeIsFontSize } from '../render/style';
import { type Grid, type Rect, boundsOf, clampRect } from './snapping';
import { WIDGET_LABELS, type WidgetType, LIMITS, defaultBlockStyle, defaultWidget } from '../widgets';

export type { Grid, Rect } from './snapping';

export const DEFAULT_MARGIN = 48;
export const DEFAULT_GAP = 24;
export const DUPLICATE_OFFSET = 32;

/** Default size of a new block per widget type, before it is fitted into the screen margins. */
const DEFAULT_SIZES: Record<WidgetType, [number, number]> = {
  empty: [640, 360],
  text: [800, 360],
  image: [800, 450],
  video: [800, 450],
  slideshow: [800, 450],
  qr: [360, 420],
  clock: [480, 200],
  status: [640, 520],
  camera: [960, 540],
  timelapse: [800, 450],
  open_days: [900, 520],
  events: [900, 440],
  agenda: [900, 600],
  calendar: [760, 600],
  announcement: [1400, 360],
};

const MAX_NAME = LIMITS.blockName;
const hasRoom = (blocks: readonly SignageBlock[], extra = 1) => blocks.length + extra <= LIMITS.blocks;
const idSet = (ids: readonly string[]) => new Set(ids);
const geometry = (b: SignageBlock): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
const withRect = (b: SignageBlock, rect: Rect): SignageBlock => ({ ...b, ...clampRect(rect) });
const clone = (b: SignageBlock): SignageBlock => structuredClone(b);

// ---------- ids and names ----------

/** A block id not used in `existing` (matches the API pattern). */
export function newBlockId(existing: readonly Pick<SignageBlock, 'id'>[]): string {
  const used = new Set(existing.map((b) => b.id));
  for (let n = existing.length + 1; ; n++) if (!used.has(`b${n}`)) return `b${n}`;
}

/** `base`, or `base 2`, `base 3` ... the first name no block has (at most 60 characters). */
export function nextBlockName(blocks: readonly Pick<SignageBlock, 'name'>[], base: string): string {
  const used = new Set(blocks.map((b) => b.name));
  const fit = (suffix: string) => base.slice(0, MAX_NAME - suffix.length) + suffix;
  if (!used.has(fit(''))) return fit('');
  for (let n = 2; ; n++) if (!used.has(fit(` ${n}`))) return fit(` ${n}`);
}

/** A name that comes from the widget (or the generic "Block 3") and should follow a change of widget type. */
const isAutoName = (name: string) =>
  /^Block( \d+)?$/.test(name) ||
  Object.values(WIDGET_LABELS).some((label) => name === label || new RegExp(`^${label} \\d+$`).test(name));

// ---------- adding and changing blocks ----------

export const canAddBlocks = (blocks: readonly SignageBlock[], count = 1) => hasRoom(blocks, count);

/** Size of a new block of a type: the default, shrunk uniformly to fit inside the margins, in whole units. */
export function fitSize(type: WidgetType, grid: Grid, margin = DEFAULT_MARGIN): { w: number; h: number } {
  const [w, h] = DEFAULT_SIZES[type];
  const factor = Math.min(1, (grid.width - 2 * margin) / w, (grid.height - 2 * margin) / h);
  const fitted = clampRect({ x: 0, y: 0, w: w * Math.max(factor, 0), h: h * Math.max(factor, 0) });
  return { w: fitted.w, h: fitted.h };
}

/** The topmost visible empty block containing the point, for dropping a palette item into it. */
export function emptyBlockAt(blocks: readonly SignageBlock[], point: { x: number; y: number }): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (
      b.widget.type === 'empty' &&
      !b.hidden &&
      point.x >= b.x &&
      point.x <= b.x + b.w &&
      point.y >= b.y &&
      point.y <= b.y + b.h
    )
      return b.id;
  }
  return null;
}

/**
 * Adds a block of `type` on top. `at` is where the block's centre should be (clamped into the screen, top-left snapped
 * to 8); without it the block is centred. `{ intoBlockId }` switches that block's widget instead. At the block limit
 * nothing is added and `id` is null.
 */
export function addBlock(
  blocks: readonly SignageBlock[],
  type: WidgetType,
  grid: Grid,
  at?: { x: number; y: number } | { intoBlockId: string },
  margin = DEFAULT_MARGIN,
): { blocks: SignageBlock[]; id: string | null } {
  if (at && 'intoBlockId' in at) {
    const exists = blocks.some((b) => b.id === at.intoBlockId);
    return {
      blocks: exists ? setWidgetType(blocks, at.intoBlockId, type) : [...blocks],
      id: exists ? at.intoBlockId : null,
    };
  }
  if (!hasRoom(blocks)) return { blocks: [...blocks], id: null };
  const { w, h } = fitSize(type, grid, margin);
  const snap = (value: number) => Math.round(value / 8) * 8;
  const centreX = at ? at.x : grid.width / 2;
  const centreY = at ? at.y : grid.height / 2;
  const x = snap(at ? Math.max(0, Math.min(grid.width - w, centreX - w / 2)) : (grid.width - w) / 2);
  const y = snap(at ? Math.max(0, Math.min(grid.height - h, centreY - h / 2)) : (grid.height - h) / 2);
  const id = newBlockId(blocks);
  const block: SignageBlock = {
    id,
    name: nextBlockName(blocks, WIDGET_LABELS[type]),
    ...clampRect({ x, y, w, h }),
    hidden: false,
    locked: false,
    widget: defaultWidget(type),
    style: defaultBlockStyle(type),
  };
  return { blocks: [...blocks, block], id };
}

/** Switches a block's widget (fresh default settings) keeping its geometry; media widgets lose padding and background image. */
export function setWidgetType(blocks: readonly SignageBlock[], id: string, type: WidgetType): SignageBlock[] {
  return blocks.map((b) => {
    if (b.id !== id) return b;
    const fresh = defaultBlockStyle(type);
    const style: SignageBlockStyle = { ...b.style };
    if (isMediaWidget(type)) {
      style.padding = 0;
      style.backgroundAssetId = null;
      style.backgroundDim = 0;
    } else if (style.padding === 0) style.padding = fresh.padding;
    if (textSizeIsFontSize(type) !== textSizeIsFontSize(b.widget.type)) style.textSize = fresh.textSize;
    const others = blocks.filter((o) => o.id !== id);
    return {
      ...b,
      name: isAutoName(b.name) ? nextBlockName(others, WIDGET_LABELS[type]) : b.name,
      widget: defaultWidget(type),
      style,
    };
  });
}

/** Cuts a block in two with `gap` between them; the new empty block (inserted above it, keeping its fill) is `newId`. */
export function splitBlock(
  blocks: readonly SignageBlock[],
  id: string,
  direction: 'vertical' | 'horizontal',
  gap = DEFAULT_GAP,
): { blocks: SignageBlock[]; newId: string | null } {
  const index = blocks.findIndex((b) => b.id === id);
  const source = blocks[index];
  const extent = source ? (direction === 'vertical' ? source.w : source.h) : 0;
  const first = Math.round((extent - gap) / 2);
  const second = extent - first - gap;
  const min = LIMITS.blockMinExtent;
  if (!source || source.locked || !hasRoom(blocks) || first < min || second < min)
    return { blocks: [...blocks], newId: null };
  const newId = newBlockId(blocks);
  const style = {
    ...defaultBlockStyle('empty'),
    radius: source.style.radius,
    backgroundColor: source.style.backgroundColor,
    backgroundOpacity: source.style.backgroundOpacity,
  };
  const rect = geometry(source);
  const added: SignageBlock =
    direction === 'vertical'
      ? { ...source, ...rect, x: source.x + first + gap, w: second }
      : { ...source, ...rect, y: source.y + first + gap, h: second };
  Object.assign(added, {
    id: newId,
    name: nextBlockName(blocks, 'Block'),
    hidden: false,
    locked: false,
    widget: defaultWidget('empty'),
    style,
  });
  const shrunk = direction === 'vertical' ? { ...source, w: first } : { ...source, h: first };
  const next = [...blocks];
  next.splice(index, 1, shrunk, added);
  return { blocks: next, newId };
}

// ---------- duplicate and delete ----------

function copyOf(
  source: SignageBlock,
  all: readonly SignageBlock[],
  suffix: string,
  patch: Partial<Rect>,
): SignageBlock {
  const copy = clone(source);
  copy.id = newBlockId(all);
  copy.name = nextBlockName(all, source.name.slice(0, MAX_NAME - suffix.length) + suffix);
  return { ...copy, ...clampRect({ ...geometry(source), ...patch }) };
}

/** Inserts copies directly above their originals (unlocked originals only, as many as fit under the block limit). */
function insertCopies(
  blocks: readonly SignageBlock[],
  ids: readonly string[],
  suffix: string,
  patch: (b: SignageBlock) => Partial<Rect>,
): { blocks: SignageBlock[]; newIds: string[] } {
  const wanted = idSet(ids);
  let next = [...blocks];
  const newIds: string[] = [];
  for (const source of blocks) {
    if (!wanted.has(source.id) || source.locked || !hasRoom(next)) continue;
    const copy = copyOf(source, next, suffix, patch(source));
    next.splice(next.findIndex((b) => b.id === source.id) + 1, 0, copy);
    newIds.push(copy.id);
  }
  if (newIds.length === 0) next = [...blocks];
  return { blocks: next, newIds };
}

/** Copies blocks `offset` units right and down, above the originals. */
export const duplicateBlocks = (blocks: readonly SignageBlock[], ids: readonly string[], offset = DUPLICATE_OFFSET) =>
  insertCopies(blocks, ids, ' copy', (b) => ({ x: b.x + offset, y: b.y + offset }));

export function deleteBlocks(blocks: readonly SignageBlock[], ids: readonly string[]): SignageBlock[] {
  const doomed = idSet(ids);
  if (!blocks.some((b) => doomed.has(b.id) && !b.locked)) return [...blocks];
  return blocks.filter((b) => !(doomed.has(b.id) && !b.locked));
}

// ---------- stacking order ----------

/** Moves a block to an array index (clamped); the same array when it would not move. */
export function moveBlockTo(blocks: readonly SignageBlock[], id: string, index: number): SignageBlock[] {
  const from = blocks.findIndex((b) => b.id === id);
  if (from < 0) return blocks as SignageBlock[];
  const to = Math.max(0, Math.min(blocks.length - 1, Math.round(index)));
  if (to === from) return blocks as SignageBlock[];
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 'front'/'back' move one step towards the front/back; 'top'/'bottom' to the very front/back. */
export function orderBlock(blocks: readonly SignageBlock[], id: string, step: 'front' | 'back' | 'top' | 'bottom') {
  const i = blocks.findIndex((b) => b.id === id);
  const to = { front: i + 1, back: i - 1, top: blocks.length - 1, bottom: 0 }[step];
  return i < 0 ? (blocks as SignageBlock[]) : moveBlockTo(blocks, id, to);
}

/** Drag-and-drop in the Blocks list (shown front first): drop `draggedId` above or below `targetId` in that list. */
export function reorderFromList(blocks: readonly SignageBlock[], draggedId: string, targetId: string, above: boolean) {
  if (draggedId === targetId || !blocks.some((b) => b.id === draggedId)) return blocks as SignageBlock[];
  const rest = blocks.filter((b) => b.id !== draggedId);
  const target = rest.findIndex((b) => b.id === targetId);
  if (target < 0) return blocks as SignageBlock[];
  const dragged = blocks.find((b) => b.id === draggedId)!;
  // Above in the list means further front, i.e. later in the array.
  const next = [...rest];
  next.splice(above ? target + 1 : target, 0, dragged);
  return next.every((b, i) => b.id === blocks[i].id) ? (blocks as SignageBlock[]) : next;
}

// ---------- geometry edits ----------

function mapUnlocked(blocks: readonly SignageBlock[], ids: readonly string[], fn: (b: SignageBlock) => SignageBlock) {
  const wanted = idSet(ids);
  return blocks.map((b) => (wanted.has(b.id) && !b.locked ? fn(b) : b));
}

/** Moves unlocked blocks by (dx, dy), e.g. for arrow keys. */
export const nudge = (blocks: readonly SignageBlock[], ids: readonly string[], dx: number, dy: number) =>
  mapUnlocked(blocks, ids, (b) => withRect(b, { ...geometry(b), x: b.x + dx, y: b.y + dy }));

/** Sets position and size fields from the properties pane (works on a locked block too); values are rounded and clamped. */
export const setGeometry = (blocks: readonly SignageBlock[], id: string, partial: Partial<Rect>) =>
  blocks.map((b) => (b.id === id ? withRect(b, { ...geometry(b), ...partial }) : b));

/** Applies a change to the given blocks, locked or not (for non-geometry properties such as name, hidden, locked). */
export const updateBlocks = (
  blocks: readonly SignageBlock[],
  ids: readonly string[],
  fn: (b: SignageBlock) => SignageBlock,
) => {
  const wanted = idSet(ids);
  return blocks.map((b) => (wanted.has(b.id) ? fn(b) : b));
};

/** Sets style fields on the given blocks. */
export const setStyle = (
  blocks: readonly SignageBlock[],
  ids: readonly string[],
  partial: Partial<SignageBlockStyle>,
) => updateBlocks(blocks, ids, (b) => ({ ...b, style: { ...b.style, ...partial } }));

/** Stretches blocks when the screen's shape changes, so they keep their relative place and size. */
export function stretchToRatio(blocks: readonly SignageBlock[], oldGrid: Grid, newGrid: Grid): SignageBlock[] {
  const fx = newGrid.width / oldGrid.width;
  const fy = newGrid.height / oldGrid.height;
  return blocks.map((b) => withRect(b, { x: b.x * fx, y: b.y * fy, w: b.w * fx, h: b.h * fy }));
}

// ---------- style ----------

/** Gives every other unlocked block with the same widget type the style of `sourceId`. */
export function applyStyleToSameType(blocks: readonly SignageBlock[], sourceId: string): SignageBlock[] {
  const source = blocks.find((b) => b.id === sourceId);
  if (!source) return [...blocks];
  return blocks.map((b) =>
    b.id !== sourceId && !b.locked && b.widget.type === source.widget.type ? { ...b, style: { ...source.style } } : b,
  );
}

/** Back to the default look of the block's widget type. */
export const resetStyle = (blocks: readonly SignageBlock[], id: string) =>
  blocks.map((b) => (b.id === id ? { ...b, style: defaultBlockStyle(b.widget.type) } : b));

/** The value all selected blocks share, or `mixed` when they differ (compared structurally). */
export function sharedValue<T>(
  blocks: readonly SignageBlock[],
  ids: readonly string[],
  getter: (b: SignageBlock) => T,
): { value: T | undefined; mixed: boolean } {
  const wanted = idSet(ids);
  const values = blocks.filter((b) => wanted.has(b.id)).map(getter);
  if (values.length === 0) return { value: undefined, mixed: false };
  const key = (v: T) => JSON.stringify(v);
  const mixed = values.some((v) => key(v) !== key(values[0]));
  return { value: mixed ? undefined : values[0], mixed };
}

// ---------- arrange ----------

export type ArrangeAction =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  | 'distH'
  | 'distV'
  | 'gapH'
  | 'gapV'
  | 'sameW'
  | 'sameH'
  | 'sameSize'
  | 'mirrorH'
  | 'mirrorV'
  | 'mirrorCopyH'
  | 'mirrorCopyV'
  | 'centerH'
  | 'centerV'
  | 'dup'
  | 'del';

export type ArrangeOptions = {
  /** Align and distribute relative to the selection's bounds or to the screen margins (a single block always uses the margins). */
  rel?: 'selection' | 'screen';
  grid: Grid;
  margin?: number;
  /** Gap for gapH/gapV. */
  gap?: number;
};

/**
 * One function for every arrange tool. Locked blocks are skipped. Returns the new blocks and the ids that should be
 * selected afterwards (copies for dup, original plus mirror for mirrorCopy, nothing for del). When every selected block
 * is locked the same array comes back.
 */
export function arrange(
  blocks: readonly SignageBlock[],
  ids: readonly string[],
  action: ArrangeAction,
  options: ArrangeOptions,
): { blocks: SignageBlock[]; selectIds: string[] } {
  const { grid, rel = 'selection', margin = DEFAULT_MARGIN, gap = DEFAULT_GAP } = options;
  const selected = blocks.filter((b) => ids.includes(b.id));
  const movable = selected.filter((b) => !b.locked);
  if (movable.length === 0) return { blocks: blocks as SignageBlock[], selectIds: [...ids] };
  const movableIds = movable.map((b) => b.id);

  if (action === 'del') return { blocks: deleteBlocks(blocks, movableIds), selectIds: [] };
  if (action === 'dup') {
    const result = duplicateBlocks(blocks, movableIds);
    return { blocks: result.blocks, selectIds: result.newIds };
  }
  if (action === 'mirrorCopyH' || action === 'mirrorCopyV') {
    const horizontal = action === 'mirrorCopyH';
    const result = insertCopies(blocks, movableIds, ' (mirrored)', (b) =>
      horizontal ? { x: grid.width - b.x - b.w } : { y: grid.height - b.y - b.h },
    );
    return { blocks: result.blocks, selectIds: [...ids, ...result.newIds] };
  }

  const bounds = boundsOf(selected.map(geometry))!;
  const area: Rect =
    rel === 'screen' || selected.length === 1
      ? { x: margin, y: margin, w: grid.width - 2 * margin, h: grid.height - 2 * margin }
      : bounds;
  const moveBounds = boundsOf(movable.map(geometry))!;
  const maxW = Math.max(...movable.map((b) => b.w));
  const maxH = Math.max(...movable.map((b) => b.h));
  const next = new Map<string, Rect>(movable.map((b) => [b.id, geometry(b)]));
  const set = (b: SignageBlock, patch: Partial<Rect>) => next.set(b.id, { ...next.get(b.id)!, ...patch });

  for (const b of movable) {
    if (action === 'left') set(b, { x: area.x });
    if (action === 'hcenter') set(b, { x: area.x + area.w / 2 - b.w / 2 });
    if (action === 'right') set(b, { x: area.x + area.w - b.w });
    if (action === 'top') set(b, { y: area.y });
    if (action === 'middle') set(b, { y: area.y + area.h / 2 - b.h / 2 });
    if (action === 'bottom') set(b, { y: area.y + area.h - b.h });
    if (action === 'sameW' || action === 'sameSize') set(b, { w: maxW });
    if (action === 'sameH' || action === 'sameSize') set(b, { h: maxH });
    if (action === 'mirrorH') set(b, { x: grid.width - b.x - b.w });
    if (action === 'mirrorV') set(b, { y: grid.height - b.y - b.h });
    if (action === 'centerH') set(b, { x: b.x + grid.width / 2 - (moveBounds.x + moveBounds.w / 2) });
    if (action === 'centerV') set(b, { y: b.y + grid.height / 2 - (moveBounds.y + moveBounds.h / 2) });
  }

  const axisOf = (horizontal: boolean) => (horizontal ? (['x', 'w'] as const) : (['y', 'h'] as const));
  if (action === 'distH' || action === 'distV') {
    const [pos, size] = axisOf(action === 'distH');
    const [start, span] = action === 'distH' ? [area.x, area.w] : [area.y, area.h];
    const sorted = [...movable].sort((p, q) => p[pos] - q[pos]);
    if (sorted.length < 2) set(sorted[0], { [pos]: start + span / 2 - sorted[0][size] / 2 });
    else {
      const space = (span - sorted.reduce((t, b) => t + b[size], 0)) / (sorted.length - 1);
      let cursor = start;
      for (const b of sorted) {
        set(b, { [pos]: Math.round(cursor) });
        cursor += b[size] + space;
      }
    }
  }
  if (action === 'gapH' || action === 'gapV') {
    const [pos, size] = axisOf(action === 'gapH');
    const sorted = [...movable].sort((p, q) => p[pos] - q[pos]);
    let cursor = sorted[0][pos];
    for (const b of sorted) {
      set(b, { [pos]: cursor });
      cursor += b[size] + gap;
    }
  }

  return {
    blocks: blocks.map((b) => (next.has(b.id) ? withRect(b, next.get(b.id)!) : b)),
    selectIds: [...ids],
  };
}
