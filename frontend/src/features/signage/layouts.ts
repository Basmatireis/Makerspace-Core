import type {
  SignageCustomLayoutMode,
  SignageCustomLayoutZone,
  SignageLayoutId,
  SignageWidget,
  SignageZones,
} from '../../api/generated/models';

// Zone layouts: one widget per zone. Built-in layouts are CSS grids with named zones; custom layouts (a manifest entry or
// an admin record) are either grids with `fr` track weights or free layouts with zones placed in percent. Everything is
// resolved to one shape here, shared by the admin pickers, the scene renderer and the player (which cannot call the
// authenticated layouts endpoint). The built-in part must stay identical to backend/internal/signage/layouts.go;
// layouts.test.ts checks the ids against api/openapi.yaml.

export type LayoutZone = { id: string; label: string; col: number; row: number; colSpan: number; rowSpan: number };
export type Layout = { id: SignageLayoutId; name: string; columns: string; rows: string; zones: LayoutZone[] };

/** A zone of a free layout: percentages of the screen. Array order is the stacking order (later on top). */
export type FreeLayoutZone = { id: string; label: string; x: number; y: number; width: number; height: number };

export type ResolvedLayout =
  { kind: 'grid'; columns: string; rows: string; zones: LayoutZone[] } | { kind: 'free'; zones: FreeLayoutZone[] };

/** The part of a custom layout the resolver reads (a manifest entry and an admin record both fit). */
export type CustomLayoutShape = {
  id: string;
  mode: SignageCustomLayoutMode;
  columns: readonly number[];
  rows: readonly number[];
  zones: readonly SignageCustomLayoutZone[];
};

const zone = (id: string, label: string, col: number, row: number, colSpan = 1, rowSpan = 1): LayoutZone => ({
  id,
  label,
  col,
  row,
  colSpan,
  rowSpan,
});

export const LAYOUTS: readonly Layout[] = [
  { id: 'full', name: 'Full screen', columns: '1fr', rows: '1fr', zones: [zone('main', 'Main', 1, 1)] },
  {
    id: 'stack3',
    name: 'Header, main, footer',
    columns: '1fr',
    rows: '14fr 72fr 14fr',
    zones: [zone('header', 'Header', 1, 1), zone('main', 'Main', 1, 2), zone('footer', 'Footer', 1, 3)],
  },
  {
    id: 'stack4',
    name: 'Header, main, info, footer',
    columns: '1fr',
    rows: '10fr 52fr 24fr 14fr',
    zones: [
      zone('header', 'Header', 1, 1),
      zone('main', 'Main', 1, 2),
      zone('info', 'Info', 1, 3),
      zone('footer', 'Footer', 1, 4),
    ],
  },
  {
    id: 'split',
    name: 'Two columns',
    columns: '1fr 1fr',
    rows: '1fr',
    zones: [zone('left', 'Left', 1, 1), zone('right', 'Right', 2, 1)],
  },
  {
    id: 'grid2x2',
    name: 'Four quarters',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    zones: [
      zone('tl', 'Top left', 1, 1),
      zone('tr', 'Top right', 2, 1),
      zone('bl', 'Bottom left', 1, 2),
      zone('br', 'Bottom right', 2, 2),
    ],
  },
  {
    id: 'quad_banner',
    name: 'Four quarters with banner',
    columns: '1fr 1fr',
    rows: '44fr 44fr 12fr',
    zones: [
      zone('tl', 'Top left', 1, 1),
      zone('tr', 'Top right', 2, 1),
      zone('bl', 'Bottom left', 1, 2),
      zone('br', 'Bottom right', 2, 2),
      zone('banner', 'Banner', 1, 3, 2),
    ],
  },
  {
    id: 'main_side',
    name: 'Main with sidebar',
    columns: '2fr 1fr',
    rows: '1fr 1fr',
    zones: [
      zone('main', 'Main', 1, 1, 1, 2),
      zone('side_top', 'Sidebar top', 2, 1),
      zone('side_bottom', 'Sidebar bottom', 2, 2),
    ],
  },
  {
    id: 'main_footer',
    name: 'Main and footer banner',
    columns: '1fr',
    rows: '92fr 8fr',
    zones: [zone('main', 'Main', 1, 1), zone('footer', 'Footer', 1, 2)],
  },
  {
    id: 'banner_main',
    name: 'Banner and main',
    columns: '1fr',
    rows: '16fr 84fr',
    zones: [zone('banner', 'Banner', 1, 1), zone('main', 'Main', 1, 2)],
  },
];

/** Unknown ids (a newer backend) fall back to the first layout so a scene still renders. */
export const layoutById = (id: string): Layout => LAYOUTS.find((layout) => layout.id === id) ?? LAYOUTS[0];

const fr = (weights: readonly number[]) =>
  weights.length > 0 ? weights.map((weight) => `${weight}fr`).join(' ') : '1fr';
const gridOf = (layout: Layout): ResolvedLayout => ({
  kind: 'grid',
  columns: layout.columns,
  rows: layout.rows,
  zones: layout.zones,
});

/**
 * Resolves a scene's layout to a grid or a free layout. `custom` looks the layout up in `customLayouts` (the manifest's
 * or the admin list); an unknown id, a missing custom layout or a malformed zone falls back so a scene still renders.
 */
export function resolveLayout(
  layoutId: string,
  customLayoutId: string | null | undefined,
  customLayouts: readonly CustomLayoutShape[] | undefined,
): ResolvedLayout {
  if (layoutId !== 'custom') return gridOf(layoutById(layoutId));
  const custom = customLayoutId ? customLayouts?.find((item) => item.id === customLayoutId) : undefined;
  if (!custom || custom.zones.length === 0) return gridOf(LAYOUTS[0]);
  if (custom.mode === 'free') {
    return {
      kind: 'free',
      zones: custom.zones.map((item) => ({
        id: item.id,
        label: item.label,
        x: item.rect?.x ?? 0,
        y: item.rect?.y ?? 0,
        width: item.rect?.width ?? 100,
        height: item.rect?.height ?? 100,
      })),
    };
  }
  return {
    kind: 'grid',
    columns: fr(custom.columns),
    rows: fr(custom.rows),
    zones: custom.zones.map((item) => ({
      id: item.id,
      label: item.label,
      col: item.grid?.col ?? 1,
      row: item.grid?.row ?? 1,
      colSpan: item.grid?.colSpan ?? 1,
      rowSpan: item.grid?.rowSpan ?? 1,
    })),
  };
}

/** A layout, given as a built-in id or as an already resolved layout. */
export type LayoutRef = SignageLayoutId | ResolvedLayout;
const resolved = (ref: LayoutRef): ResolvedLayout =>
  typeof ref === 'string' ? resolveLayout(ref, null, undefined) : ref;

const EMPTY: SignageWidget = { type: 'empty' };

/** Changing the layout keeps widgets by position: zone n of the new layout takes the widget of zone n of the old one. */
export function remapZones(zones: SignageZones, from: LayoutRef, to: LayoutRef): SignageZones {
  const previous = resolved(from).zones;
  const result: SignageZones = {};
  resolved(to).zones.forEach((next, index) => {
    result[next.id] = zones[previous[index]?.id ?? ''] ?? EMPTY;
  });
  return result;
}

export function emptyZones(layout: LayoutRef): SignageZones {
  return Object.fromEntries(resolved(layout).zones.map((item) => [item.id, EMPTY]));
}
