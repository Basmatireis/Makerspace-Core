import { makeBlock, newId, type SchemaHints } from './blocks';
import {
  canDrop,
  find,
  getContainer,
  pageSize,
  POSITIONED,
  SIZED,
  titleOf,
  TYPE_LABELS,
  type BlockType,
  type Container,
  type Layer,
  type PageSetup,
  type TemplateDocument,
  type TemplateNode,
  type ToolType,
  type Visit,
} from './model';

/**
 * Pure edits of a template document. Every function returns a new document (or null when the edit is refused or changes
 * nothing) and leaves its input alone: it works on a deep copy, so React state is never mutated.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The result of an edit that changes what is selected or opened in the structure. */
export interface EditResult {
  doc: TemplateDocument;
  /** The node to select afterwards; null clears the selection. */
  select: string | null;
  /** Nodes whose children the structure should show. */
  expand: string[];
  /** A sentence for a toast. */
  notice?: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Gives a block that enters a page layer a position: the left margin, 40 mm from the top, the full text width. */
export function ensurePos(node: TemplateNode, page: PageSetup): void {
  if (node.type === 'layer') return;
  const [, mr, , ml] = page.margins;
  const [width] = pageSize(page);
  if (node.x == null) node.x = ml;
  if (node.y == null) node.y = 40;
  if (node.w == null) node.w = width - ml - mr;
  if (SIZED.includes(node.type) && !node.h) (node as { h?: number }).h = 20;
}

/** Blocks own a width/height only if their type defines one; a block back in the flow loses the rest of its placement. */
const OWN_SIZE: readonly BlockType[] = ['ptext', 'line', 'rect', 'ellipse', 'picture', 'graphic', 'qr', 'barcode'];
function stripPlacement(node: TemplateNode): void {
  if (node.type === 'layer') return;
  delete node.x;
  delete node.y;
  if (!OWN_SIZE.includes(node.type)) {
    delete node.w;
    delete node.h;
  }
}

function removeAt(doc: TemplateDocument, visit: Visit): void {
  const list = getContainer(doc, visit.container);
  list?.splice(visit.index, 1);
}

/** Puts `node` into a container; among the layers a block first gets a layer of its own. Returns the layer made, if any. */
function place(doc: TemplateDocument, node: TemplateNode, dest: Container, index: number): Layer | null {
  const list = getContainer(doc, dest);
  if (!list) return null;
  let item = node;
  let made: Layer | null = null;
  if ('root' in dest && dest.root === 'layers' && node.type !== 'layer') {
    made = { id: newId(), type: 'layer', title: `Layer for ${titleOf(node)}`, pages: 'all', elements: [node] };
    item = made;
  }
  list.splice(index, 0, item);
  return made;
}

/** Layers to open so a node just placed is visible. */
function layersToOpen(doc: TemplateDocument, id: string): string[] {
  const at = find(doc, id);
  return at?.layer ? [at.layer.id] : [];
}

/**
 * Moves a node to `index` of a container. A block dropped among the layers gets a layer of its own, a block dropped into
 * a layer gets a position, a layer dropped into another layer is merged into it. Null when the drop is refused or the
 * node would stay where it is.
 */
export function moveNode(doc: TemplateDocument, id: string, dest: Container, index: number): EditResult | null {
  const src = find(doc, id);
  if (!src || !canDrop(doc, { id, type: src.node.type }, dest)) return null;
  const same = JSON.stringify(src.container) === JSON.stringify(dest);
  if (same && (index === src.index || index === src.index + 1)) return null;
  const next = clone(doc);
  const from = find(next, id)!;
  const node = from.node;
  if (node.type === 'layer' && !('root' in dest)) {
    // Merge: the layer's elements join the target layer and the emptied layer disappears.
    const elements = node.elements;
    removeAt(next, from);
    const target = getContainer(next, dest);
    const host = find(next, dest.node)!.node as Layer;
    target?.splice(index, 0, ...elements);
    elements.forEach((e) => ensurePos(e, next.page));
    return {
      doc: next,
      select: elements[0]?.id ?? null,
      expand: [host.id],
      notice: `Merged into layer “${titleOf(host)}”`,
    };
  }
  removeAt(next, from);
  const at = same && src.index < index ? index - 1 : index;
  const made = place(next, node, dest, at);
  const now = find(next, id)!;
  if (now.area === 'layer') ensurePos(node, next.page);
  else stripPlacement(node);
  return { doc: next, select: id, expand: [...(made ? [made.id] : []), ...layersToOpen(next, id)] };
}

/** Moves a node one place up or down inside its container (Alt+↑/↓). */
export function moveBy(doc: TemplateDocument, id: string, delta: -1 | 1): EditResult | null {
  const src = find(doc, id);
  if (!src) return null;
  const list = getContainer(doc, src.container);
  const j = src.index + delta;
  if (!list || j < 0 || j >= list.length) return null;
  const next = clone(doc);
  const arr = getContainer(next, src.container)!;
  [arr[src.index], arr[j]] = [arr[j], arr[src.index]];
  return { doc: next, select: id, expand: [] };
}

export interface InsertOptions {
  /** Top-left corner in mm page coordinates (for elements drawn on the page). */
  at?: [number, number];
  /** Drawn size in mm. A width or height of 0 is ignored except for lines. */
  size?: { w?: number; h?: number };
  /** Ids for new nodes; tests pass a counter. */
  id?: () => string;
}

/** Inserts a new block of a tool type at `index` of a container and selects it. */
export function insertNew(
  doc: TemplateDocument,
  type: ToolType,
  dest: Container,
  index: number,
  hints: SchemaHints,
  options: InsertOptions = {},
): EditResult | null {
  if (!canDrop(doc, { type }, dest)) return null;
  const next = clone(doc);
  const node = makeBlock(type, hints, next.styles, options.id);
  const made = place(next, node, dest, index);
  const at = find(next, node.id)!;
  const expand: string[] = [...(made ? [made.id] : []), ...(node.type === 'layer' ? [node.id] : [])];
  if (at.area === 'layer' && node.type !== 'layer') {
    ensurePos(node, next.page);
    if (options.at) [node.x, node.y] = options.at;
    const size = options.size;
    if (size) {
      if (size.w != null && (size.w > 0 || node.type === 'line')) node.w = size.w;
      if (size.h != null) (node as { h?: number }).h = size.h;
    }
    if (at.layer) expand.push(at.layer.id);
  }
  const where =
    at.area === 'layer' ? `layer “${titleOf(at.layer ?? node)}”` : at.area === 'layers' ? 'page layers' : at.area;
  return { doc: next, select: node.id, expand, notice: `${TYPE_LABELS[type]} added to ${where}` };
}

/**
 * The layer a drawn element goes to: the selected layer (or the layer of the selected element), else one per page kind
 * ("Free elements · first page" / "following pages"), created when missing.
 */
export function layerForDrawing(
  doc: TemplateDocument,
  selectedId: string | null,
  pageIndex: number,
): { doc: TemplateDocument; layerId: string } {
  const selected = selectedId && selectedId !== 'page' ? find(doc, selectedId) : null;
  if (selected?.layer) return { doc, layerId: selected.layer.id };
  const kind = pageIndex === 0 ? 'first' : 'next';
  const title = kind === 'first' ? 'Free elements · first page' : 'Free elements · following pages';
  const existing = doc.layers.find((l) => l.title === title);
  if (existing) return { doc, layerId: existing.id };
  const layer: Layer = { id: newId(), type: 'layer', title, pages: kind, elements: [] };
  return { doc: { ...doc, layers: [...doc.layers, layer] }, layerId: layer.id };
}

/** Deep copy of a node with new ids for it and everything inside it. */
export function cloneWithNewIds<T extends TemplateNode>(node: T, id: () => string = newId): T {
  const copy = clone(node);
  const visit = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.id === 'string') o.id = id();
      Object.values(o).forEach(visit);
    }
  };
  visit(copy);
  return copy;
}

export function duplicateNode(doc: TemplateDocument, id: string, newIds?: () => string): EditResult | null {
  const src = find(doc, id);
  if (!src) return null;
  const next = clone(doc);
  const copy = cloneWithNewIds(find(next, id)!.node, newIds);
  getContainer(next, src.container)?.splice(src.index + 1, 0, copy);
  return { doc: next, select: copy.id, expand: [] };
}

export function removeNode(doc: TemplateDocument, id: string): EditResult | null {
  const src = find(doc, id);
  if (!src) return null;
  const next = clone(doc);
  removeAt(next, find(next, id)!);
  return { doc: next, select: null, expand: [] };
}

/** Sets or clears (empty text) the editor-only title of a node. */
export function renameNode(doc: TemplateDocument, id: string, title: string): TemplateDocument | null {
  const src = find(doc, id);
  const clean = title.trim();
  if (!src || (src.node.title ?? '') === clean) return null;
  const next = clone(doc);
  const node = find(next, id)!.node;
  if (clean) node.title = clean;
  else delete node.title;
  return next;
}

/** Shallow-merges properties into a node: the commit of a move/resize on the page, nudges, simple property edits. */
export function patchNode(
  doc: TemplateDocument,
  id: string,
  patch: Partial<Record<string, unknown>>,
): TemplateDocument | null {
  if (!find(doc, id)) return null;
  const next = clone(doc);
  Object.assign(find(next, id)!.node, patch);
  return next;
}

/** True for blocks that can be moved and resized directly on the page. */
export const isPositioned = (node: TemplateNode): boolean => node.type !== 'layer' && POSITIONED.includes(node.type);

/** Which resize handles an element gets: sized kinds eight, vertical lines top/bottom, everything else left/right. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export function handlesFor(node: TemplateNode): Handle[] {
  if (SIZED.includes(node.type as BlockType)) return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  if (node.type === 'line' && (node.h || 0) > (node.w || 0)) return ['n', 's'];
  return ['w', 'e'];
}

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The geometry after dragging `handle` (or `move`) by dx/dy mm from `start`. Snaps to 0.5 mm unless `free`; `axis` locks a
 * move to the dominant axis. Sizes never drop below 1 mm.
 */
export function dragGeometry(
  start: Geometry,
  handle: Handle | 'move',
  dx: number,
  dy: number,
  mods: { free?: boolean; axis?: boolean } = {},
): Geometry {
  const snap = (v: number) => (mods.free ? round2(v) : Math.round(v * 2) / 2);
  const g = { ...start };
  if (handle === 'move') {
    if (mods.axis) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    g.x = snap(start.x + dx);
    g.y = snap(start.y + dy);
    return g;
  }
  const min = 1;
  if (handle.includes('e')) g.w = Math.max(min, snap(start.w + dx));
  if (handle.includes('w')) {
    const w = Math.max(min, snap(start.w - dx));
    g.x = round2(start.x + start.w - w);
    g.w = w;
  }
  if (handle.includes('s')) g.h = Math.max(min, snap(start.h + dy));
  if (handle.includes('n')) {
    const h = Math.max(min, snap(start.h - dy));
    g.y = round2(start.y + start.h - h);
    g.h = h;
  }
  return g;
}

/** Moves a positioned block by dx/dy mm (arrow keys). */
export function nudgeNode(doc: TemplateDocument, id: string, dx: number, dy: number): TemplateDocument | null {
  const src = find(doc, id);
  if (!src || src.area !== 'layer' || src.node.type === 'layer') return null;
  return patchNode(doc, id, { x: round2((src.node.x ?? 0) + dx), y: round2((src.node.y ?? 0) + dy) });
}
