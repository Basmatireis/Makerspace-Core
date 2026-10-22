import type {
  SignageCustomLayoutMode,
  SignageCustomLayoutZone,
  SignageFreeRect,
  SignageGridPlacement,
  SignageLayoutId,
  SignageWidget,
  SignageZones,
} from '../../api/generated/models';

// Pure logic of the custom layout editor. It mirrors backend/internal/signage/customlayouts.go (limits and rules), so
// the editor does not send what is certain to be rejected, and converts zones between the two layout modes.

export const MAX_ZONES = 12;
export const MAX_TRACKS = 12;
export const MAX_WEIGHT = 100;
export const SNAP_STEP = 0.5;
export const MIN_EXTENT = 1;
const ZONE_ID = /^[a-z][a-z0-9_]{0,39}$/;

export type LayoutDraft = {
  name: string;
  mode: SignageCustomLayoutMode;
  columns: number[];
  rows: number[];
  zones: SignageCustomLayoutZone[];
};

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const snapTo = (value: number, step = SNAP_STEP) => Math.round(value / step) * step;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The next free `z1`, `z2`, … id. Ids of existing zones never change, so scenes keep their widgets when a layout is edited. */
export function nextZoneId(zones: readonly { id: string }[]): string {
  const used = new Set(zones.map((zone) => zone.id));
  for (let n = 1; ; n += 1) if (!used.has(`z${n}`)) return `z${n}`;
}

/** "Zone 3" — the first number not used as a default label yet. */
export function nextZoneLabel(zones: readonly { label: string }[]): string {
  const used = new Set(zones.map((zone) => zone.label));
  for (let n = zones.length + 1; ; n += 1) if (!used.has(`Zone ${n}`)) return `Zone ${n}`;
}

export const blankLayout = (): LayoutDraft => ({
  name: '',
  mode: 'grid',
  columns: [1, 1],
  rows: [1],
  zones: [
    { id: 'z1', label: 'Left', grid: { col: 1, row: 1, colSpan: 1, rowSpan: 1 }, rect: null },
    { id: 'z2', label: 'Right', grid: { col: 2, row: 1, colSpan: 1, rowSpan: 1 }, rect: null },
  ],
});

export const toDraft = (layout: {
  name: string;
  mode: SignageCustomLayoutMode;
  columns: number[];
  rows: number[];
  zones: SignageCustomLayoutZone[];
}): LayoutDraft => ({
  name: layout.name,
  mode: layout.mode,
  columns: [...layout.columns],
  rows: [...layout.rows],
  zones: layout.zones.map((zone) => ({
    ...zone,
    grid: zone.grid && { ...zone.grid },
    rect: zone.rect && { ...zone.rect },
  })),
});

// Grid ------------------------------------------------------------------------------------------------------------------------------

export const placementEnd = (placement: SignageGridPlacement) => ({
  col: placement.col + placement.colSpan - 1,
  row: placement.row + placement.rowSpan - 1,
});

export const placementsOverlap = (a: SignageGridPlacement, b: SignageGridPlacement) => {
  const endA = placementEnd(a);
  const endB = placementEnd(b);
  return a.col <= endB.col && b.col <= endA.col && a.row <= endB.row && b.row <= endA.row;
};

export const placementFits = (placement: SignageGridPlacement, columns: number, rows: number) =>
  placement.col >= 1 &&
  placement.row >= 1 &&
  placement.colSpan >= 1 &&
  placement.rowSpan >= 1 &&
  placementEnd(placement).col <= columns &&
  placementEnd(placement).row <= rows;

/** The zone that covers a cell, if any. */
export const zoneAtCell = (zones: readonly SignageCustomLayoutZone[], col: number, row: number) =>
  zones.find((zone) => zone.grid && placementsOverlap(zone.grid, { col, row, colSpan: 1, rowSpan: 1 }));

/** The zone a placement would collide with, ignoring `exceptId`. */
export const collidingZone = (
  zones: readonly SignageCustomLayoutZone[],
  placement: SignageGridPlacement,
  exceptId = '',
) => zones.find((zone) => zone.id !== exceptId && zone.grid && placementsOverlap(zone.grid, placement));

/** The rectangle of cells between two corner cells, in any direction. */
export const placementBetween = (
  a: { col: number; row: number },
  b: { col: number; row: number },
): SignageGridPlacement => ({
  col: Math.min(a.col, b.col),
  row: Math.min(a.row, b.row),
  colSpan: Math.abs(a.col - b.col) + 1,
  rowSpan: Math.abs(a.row - b.row) + 1,
});

/** Grows or shrinks a track list; new tracks weigh 1. */
export const resizeTracks = (tracks: readonly number[], count: number): number[] =>
  Array.from({ length: clamp(count, 1, MAX_TRACKS) }, (_, index) => tracks[index] ?? 1);

/** Clips zones to a smaller grid: a zone that starts outside is removed, one that reaches outside is shortened. */
export function fitZonesToGrid(
  zones: readonly SignageCustomLayoutZone[],
  columns: number,
  rows: number,
): { zones: SignageCustomLayoutZone[]; removed: SignageCustomLayoutZone[] } {
  const kept: SignageCustomLayoutZone[] = [];
  const removed: SignageCustomLayoutZone[] = [];
  for (const zone of zones) {
    const grid = zone.grid;
    if (!grid || grid.col > columns || grid.row > rows) {
      removed.push(zone);
      continue;
    }
    kept.push({
      ...zone,
      grid: {
        ...grid,
        colSpan: Math.min(grid.colSpan, columns - grid.col + 1),
        rowSpan: Math.min(grid.rowSpan, rows - grid.row + 1),
      },
    });
  }
  return { zones: kept, removed };
}

// Free ------------------------------------------------------------------------------------------------------------------------------

/** Keeps a rectangle on the screen with at least 1 % extent, snapped to `step` (hundredths when converting). */
export function normalizeRect(rect: SignageFreeRect, step = SNAP_STEP): SignageFreeRect {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  const width = clamp(snapTo(finite(rect.width), step), MIN_EXTENT, 100);
  const height = clamp(snapTo(finite(rect.height), step), MIN_EXTENT, 100);
  return {
    x: round2(clamp(snapTo(finite(rect.x), step), 0, 100 - width)),
    y: round2(clamp(snapTo(finite(rect.y), step), 0, 100 - height)),
    width: round2(width),
    height: round2(height),
  };
}

export type ResizeHandle = { n?: boolean; s?: boolean; e?: boolean; w?: boolean };

/** Applies a pointer movement (in percent of the screen) to a rectangle: a move without a handle, otherwise a resize. */
export function dragRect(start: SignageFreeRect, dx: number, dy: number, handle?: ResizeHandle): SignageFreeRect {
  if (!handle) return normalizeRect({ ...start, x: start.x + dx, y: start.y + dy });
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.w) left = clamp(snapTo(left + dx), 0, right - MIN_EXTENT);
  if (handle.e) right = clamp(snapTo(right + dx), left + MIN_EXTENT, 100);
  if (handle.n) top = clamp(snapTo(top + dy), 0, bottom - MIN_EXTENT);
  if (handle.s) bottom = clamp(snapTo(bottom + dy), top + MIN_EXTENT, 100);
  return { x: round2(left), y: round2(top), width: round2(right - left), height: round2(bottom - top) };
}

/** A new rectangle that does not sit exactly on the previous one. */
export function newRect(count: number): SignageFreeRect {
  const offset = (count % 6) * 5;
  return normalizeRect({ x: 10 + offset, y: 10 + offset, width: 40, height: 40 });
}

/** Moves a zone one step in the stacking order (later zones are drawn on top). */
export function moveZone<T>(zones: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= zones.length) return [...zones];
  const next = [...zones];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// Conversion between the modes ------------------------------------------------------------------------------------------------------

function trackEdges(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let sum = 0;
  return [0, ...weights.map((weight) => round2((100 * (sum += weight)) / total))];
}

/** Grid zones as rectangles: the track weights decide the positions. */
export function gridToRects(
  columns: readonly number[],
  rows: readonly number[],
  zones: readonly SignageCustomLayoutZone[],
): SignageCustomLayoutZone[] {
  const xs = trackEdges(columns);
  const ys = trackEdges(rows);
  return zones.map((zone) => {
    const grid = zone.grid ?? { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
    const left = xs[Math.min(grid.col - 1, xs.length - 1)];
    const top = ys[Math.min(grid.row - 1, ys.length - 1)];
    const right = xs[Math.min(grid.col - 1 + grid.colSpan, xs.length - 1)];
    const bottom = ys[Math.min(grid.row - 1 + grid.rowSpan, ys.length - 1)];
    return {
      id: zone.id,
      label: zone.label,
      grid: null,
      rect: normalizeRect({ x: left, y: top, width: right - left, height: bottom - top }, 0.01),
    };
  });
}

/** Edges closer than this (percent of the screen) become one grid line when rectangles are turned into a grid. */
const EDGE_TOLERANCE = 2;

/** Merges the closest pair of lines into one; the screen borders never move. */
function mergeClosest(lines: number[]): void {
  let best = 0;
  let gap = Infinity;
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i + 1] - lines[i] < gap) {
      gap = lines[i + 1] - lines[i];
      best = i;
    }
  }
  if (lines[best] === 0) lines.splice(best + 1, 1);
  else if (lines[best + 1] === 100) lines.splice(best, 1);
  else lines.splice(best, 2, round2((lines[best] + lines[best + 1]) / 2));
}

/** Sorted grid lines for a set of edges: edges within the tolerance merge, then the closest merge until `max` tracks remain. */
function gridLines(edges: readonly number[], max: number): number[] {
  const lines = [...new Set([0, 100, ...edges.map(round2)])].sort((a, b) => a - b);
  while (lines.length > 2) {
    const smallest = Math.min(...lines.slice(1).map((line, index) => line - lines[index]));
    if (smallest >= EDGE_TOLERANCE && lines.length - 1 <= max) break;
    mergeClosest(lines);
  }
  return lines;
}

const nearest = (lines: readonly number[], value: number) =>
  lines.reduce((best, line, index) => (Math.abs(line - value) < Math.abs(lines[best] - value) ? index : best), 0);

export type GridConversion = {
  columns: number[];
  rows: number[];
  zones: SignageCustomLayoutZone[];
  /** Zones left out because, snapped to the grid, they would overlap an earlier one. */
  dropped: SignageCustomLayoutZone[];
};

/**
 * Rectangles as the smallest grid that holds them approximately: edges within 2 % share a grid line, zones snap to the
 * nearest lines. Zones that then overlap an earlier zone cannot exist in a grid and are reported as dropped.
 */
export function rectsToGrid(zones: readonly SignageCustomLayoutZone[]): GridConversion {
  const rects = zones.map((zone) => ({ zone, rect: zone.rect ?? { x: 0, y: 0, width: 100, height: 100 } }));
  const xs = gridLines(
    rects.flatMap(({ rect }) => [rect.x, rect.x + rect.width]),
    MAX_TRACKS,
  );
  const ys = gridLines(
    rects.flatMap(({ rect }) => [rect.y, rect.y + rect.height]),
    MAX_TRACKS,
  );
  const weights = (lines: readonly number[]) =>
    lines.slice(1).map((line, index) => clamp(Math.round(line - lines[index]), 1, MAX_WEIGHT));
  const kept: SignageCustomLayoutZone[] = [];
  const dropped: SignageCustomLayoutZone[] = [];
  for (const { zone, rect } of rects) {
    const col = nearest(xs, rect.x);
    const row = nearest(ys, rect.y);
    const grid: SignageGridPlacement = {
      col: col + 1,
      row: row + 1,
      colSpan: Math.max(1, nearest(xs, rect.x + rect.width) - col),
      rowSpan: Math.max(1, nearest(ys, rect.y + rect.height) - row),
    };
    grid.colSpan = Math.min(grid.colSpan, xs.length - 1 - col);
    grid.rowSpan = Math.min(grid.rowSpan, ys.length - 1 - row);
    if (collidingZone(kept, grid)) dropped.push(zone);
    else kept.push({ id: zone.id, label: zone.label, grid, rect: null });
  }
  return { columns: weights(xs), rows: weights(ys), zones: kept, dropped };
}

// Validation ------------------------------------------------------------------------------------------------------------------------

const decimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** The first thing the backend would reject, or null. */
export function layoutError(layout: LayoutDraft): string | null {
  const name = layout.name.trim();
  if (name === '') return 'Give the layout a name.';
  if ([...name].length > 100) return 'The name is limited to 100 characters.';
  if (layout.zones.length < 1) return 'A layout needs at least one zone.';
  if (layout.zones.length > MAX_ZONES) return `A layout has at most ${MAX_ZONES} zones.`;
  if (layout.mode === 'grid') {
    for (const [label, tracks] of [
      ['Columns', layout.columns],
      ['Rows', layout.rows],
    ] as const) {
      if (tracks.length < 1 || tracks.length > MAX_TRACKS) return `${label} need between 1 and ${MAX_TRACKS} tracks.`;
      if (tracks.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT))
        return `${label} weights must be whole numbers between 1 and ${MAX_WEIGHT}.`;
    }
  }
  const seen = new Set<string>();
  const placed: SignageCustomLayoutZone[] = [];
  for (const zone of layout.zones) {
    const label = zone.label.trim();
    if (!ZONE_ID.test(zone.id) || seen.has(zone.id)) return 'Zone ids must be unique.';
    seen.add(zone.id);
    if (label === '' || [...label].length > 60) return `Give every zone a label of up to 60 characters (${zone.id}).`;
    if (layout.mode === 'grid') {
      if (!zone.grid || zone.rect) return `Zone ${label} needs a grid position.`;
      if (!placementFits(zone.grid, layout.columns.length, layout.rows.length))
        return `Zone ${label} lies outside the grid.`;
      const other = collidingZone(placed, zone.grid);
      if (other) return `Zones ${other.label} and ${label} overlap.`;
      placed.push(zone);
    } else {
      const rect = zone.rect;
      if (!rect || zone.grid) return `Zone ${label} needs a position.`;
      if (![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value) && decimals(value)))
        return `Zone ${label}: use at most two decimals.`;
      if (
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width < MIN_EXTENT ||
        rect.height < MIN_EXTENT ||
        rect.x + rect.width > 100 + 1e-6 ||
        rect.y + rect.height > 100 + 1e-6
      )
        return `Zone ${label} must lie on the screen and be at least 1 % wide and high.`;
    }
  }
  return null;
}

/** The request body parts of a draft: trimmed, free layouts without grid fields. */
export function layoutRequest(layout: LayoutDraft) {
  return {
    name: layout.name.trim(),
    mode: layout.mode,
    columns: layout.mode === 'grid' ? layout.columns : [1],
    rows: layout.mode === 'grid' ? layout.rows : [1],
    zones: layout.zones.map((zone) => ({
      id: zone.id,
      label: zone.label.trim(),
      grid: layout.mode === 'grid' ? zone.grid : null,
      rect: layout.mode === 'free' ? zone.rect : null,
    })),
  };
}

// Scenes ----------------------------------------------------------------------------------------------------------------------------

/** A widget counts as content unless it is the plain empty widget (a styled empty widget is a coloured box). */
export const hasContent = (widget: SignageWidget | undefined) =>
  widget !== undefined && (widget.type !== 'empty' || widget.style !== undefined);

export type AffectedScene = { id: string; name: string; zones: string[] };

/**
 * Scenes that use the layout and would lose a widget because its zone is removed. Only zones that hold content are
 * listed; a scene whose removed zones are all empty is not affected.
 */
export function affectedScenes(
  scenes: readonly { id: string; name: string; customLayoutId: string | null; zones: SignageZones }[],
  layoutId: string,
  before: readonly { id: string; label: string }[],
  after: readonly { id: string }[],
): AffectedScene[] {
  const kept = new Set(after.map((zone) => zone.id));
  const removed = before.filter((zone) => !kept.has(zone.id));
  if (removed.length === 0) return [];
  return scenes.flatMap((scene) => {
    if (scene.customLayoutId !== layoutId) return [];
    const lost = removed.filter((zone) => hasContent(scene.zones[zone.id])).map((zone) => zone.label);
    return lost.length > 0 ? [{ id: scene.id, name: scene.name, zones: lost }] : [];
  });
}

/** Replaces one zone of a list. */
export const replaceZone = (
  zones: readonly SignageCustomLayoutZone[],
  id: string,
  change: Partial<SignageCustomLayoutZone>,
): SignageCustomLayoutZone[] => zones.map((zone) => (zone.id === id ? { ...zone, ...change } : zone));

/** The number a NumberInput reports, or null while the field is empty or not a number. */
export const numberOf = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  return value === '' || value === null || !Number.isFinite(number) ? null : number;
};

/** What the layout pickers choose: a built-in layout id, or `custom` with the custom layout's id. */
export type PickedLayout = { layoutId: SignageLayoutId; customLayoutId: string | null };
export const samePickedLayout = (a: PickedLayout, b: PickedLayout) =>
  a.layoutId === b.layoutId && a.customLayoutId === b.customLayoutId;
