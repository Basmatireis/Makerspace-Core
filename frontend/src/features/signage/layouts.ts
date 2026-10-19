import type { SignageLayoutId, SignageWidget, SignageZones } from '../../api/generated/models';

// Zone layouts: a CSS grid with named zones, one widget per zone. This is the single frontend definition, shared by the
// admin pickers and the scene renderer (and later the player, which cannot call the authenticated layouts endpoint).
// It must stay identical to backend/internal/signage/layouts.go; layouts.test.ts checks the ids against api/openapi.yaml.

export type LayoutZone = { id: string; label: string; col: number; row: number; colSpan: number; rowSpan: number };
export type Layout = { id: SignageLayoutId; name: string; columns: string; rows: string; zones: LayoutZone[] };

const zone = (id: string, label: string, col: number, row: number, colSpan = 1, rowSpan = 1): LayoutZone => ({ id, label, col, row, colSpan, rowSpan });

export const LAYOUTS: readonly Layout[] = [
  { id: 'full', name: 'Full screen', columns: '1fr', rows: '1fr', zones: [zone('main', 'Main', 1, 1)] },
  { id: 'stack3', name: 'Header, main, footer', columns: '1fr', rows: '14fr 72fr 14fr', zones: [zone('header', 'Header', 1, 1), zone('main', 'Main', 1, 2), zone('footer', 'Footer', 1, 3)] },
  { id: 'stack4', name: 'Header, main, info, footer', columns: '1fr', rows: '10fr 52fr 24fr 14fr', zones: [zone('header', 'Header', 1, 1), zone('main', 'Main', 1, 2), zone('info', 'Info', 1, 3), zone('footer', 'Footer', 1, 4)] },
  { id: 'split', name: 'Two columns', columns: '1fr 1fr', rows: '1fr', zones: [zone('left', 'Left', 1, 1), zone('right', 'Right', 2, 1)] },
  { id: 'grid2x2', name: 'Four quarters', columns: '1fr 1fr', rows: '1fr 1fr', zones: [zone('tl', 'Top left', 1, 1), zone('tr', 'Top right', 2, 1), zone('bl', 'Bottom left', 1, 2), zone('br', 'Bottom right', 2, 2)] },
  { id: 'quad_banner', name: 'Four quarters with banner', columns: '1fr 1fr', rows: '44fr 44fr 12fr', zones: [zone('tl', 'Top left', 1, 1), zone('tr', 'Top right', 2, 1), zone('bl', 'Bottom left', 1, 2), zone('br', 'Bottom right', 2, 2), zone('banner', 'Banner', 1, 3, 2)] },
  { id: 'main_side', name: 'Main with sidebar', columns: '2fr 1fr', rows: '1fr 1fr', zones: [zone('main', 'Main', 1, 1, 1, 2), zone('side_top', 'Sidebar top', 2, 1), zone('side_bottom', 'Sidebar bottom', 2, 2)] },
  { id: 'main_footer', name: 'Main and footer banner', columns: '1fr', rows: '92fr 8fr', zones: [zone('main', 'Main', 1, 1), zone('footer', 'Footer', 1, 2)] },
  { id: 'banner_main', name: 'Banner and main', columns: '1fr', rows: '16fr 84fr', zones: [zone('banner', 'Banner', 1, 1), zone('main', 'Main', 1, 2)] },
];

/** Unknown ids (a newer backend) fall back to the first layout so a scene still renders. */
export const layoutById = (id: string): Layout => LAYOUTS.find((layout) => layout.id === id) ?? LAYOUTS[0];

const EMPTY: SignageWidget = { type: 'empty' };

/** Changing the layout keeps widgets by position: zone n of the new layout takes the widget of zone n of the old one. */
export function remapZones(zones: SignageZones, from: SignageLayoutId, to: SignageLayoutId): SignageZones {
  const previous = layoutById(from).zones;
  const result: SignageZones = {};
  layoutById(to).zones.forEach((next, index) => { result[next.id] = zones[previous[index]?.id ?? ''] ?? EMPTY; });
  return result;
}

export function emptyZones(layoutId: SignageLayoutId): SignageZones {
  return Object.fromEntries(layoutById(layoutId).zones.map((item) => [item.id, EMPTY]));
}
