import type { Scene, Template, Widget } from './types';

// Zone layouts: a CSS grid with named zones. Each zone holds exactly one widget.
export const templates: Template[] = [
  { id: 'full', name: 'Full screen', columns: '1fr', rows: '1fr', zones: [{ id: 'main', label: 'Main', col: 1, row: 1, colSpan: 1, rowSpan: 1 }] },
  {
    id: 'stack3', name: 'Header, main, footer', columns: '1fr', rows: '14fr 72fr 14fr',
    zones: [{ id: 'header', label: 'Header', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'main', label: 'Main', col: 1, row: 2, colSpan: 1, rowSpan: 1 }, { id: 'footer', label: 'Footer', col: 1, row: 3, colSpan: 1, rowSpan: 1 }],
  },
  {
    id: 'stack4', name: 'Header, main, info, footer', columns: '1fr', rows: '10fr 52fr 24fr 14fr',
    zones: [
      { id: 'header', label: 'Header', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'main', label: 'Main', col: 1, row: 2, colSpan: 1, rowSpan: 1 },
      { id: 'info', label: 'Info', col: 1, row: 3, colSpan: 1, rowSpan: 1 }, { id: 'footer', label: 'Footer', col: 1, row: 4, colSpan: 1, rowSpan: 1 },
    ],
  },
  {
    id: 'split', name: 'Two columns', columns: '1fr 1fr', rows: '1fr',
    zones: [{ id: 'left', label: 'Left', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'right', label: 'Right', col: 2, row: 1, colSpan: 1, rowSpan: 1 }],
  },
  {
    id: 'grid2x2', name: 'Four quarters', columns: '1fr 1fr', rows: '1fr 1fr',
    zones: [
      { id: 'tl', label: 'Top left', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'tr', label: 'Top right', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      { id: 'bl', label: 'Bottom left', col: 1, row: 2, colSpan: 1, rowSpan: 1 }, { id: 'br', label: 'Bottom right', col: 2, row: 2, colSpan: 1, rowSpan: 1 },
    ],
  },
  {
    id: 'quad_banner', name: 'Four quarters with banner', columns: '1fr 1fr', rows: '44fr 44fr 12fr',
    zones: [
      { id: 'tl', label: 'Top left', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'tr', label: 'Top right', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      { id: 'bl', label: 'Bottom left', col: 1, row: 2, colSpan: 1, rowSpan: 1 }, { id: 'br', label: 'Bottom right', col: 2, row: 2, colSpan: 1, rowSpan: 1 },
      { id: 'banner', label: 'Banner', col: 1, row: 3, colSpan: 2, rowSpan: 1 },
    ],
  },
  {
    id: 'main_side', name: 'Main with sidebar', columns: '2fr 1fr', rows: '1fr 1fr',
    zones: [{ id: 'main', label: 'Main', col: 1, row: 1, colSpan: 1, rowSpan: 2 }, { id: 'side_top', label: 'Sidebar top', col: 2, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'side_bottom', label: 'Sidebar bottom', col: 2, row: 2, colSpan: 1, rowSpan: 1 }],
  },
  {
    id: 'main_footer', name: 'Main and footer banner', columns: '1fr', rows: '92fr 8fr',
    zones: [{ id: 'main', label: 'Main', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'footer', label: 'Footer', col: 1, row: 2, colSpan: 1, rowSpan: 1 }],
  },
  {
    id: 'banner_main', name: 'Banner and main', columns: '1fr', rows: '16fr 84fr',
    zones: [{ id: 'banner', label: 'Banner', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'main', label: 'Main', col: 1, row: 2, colSpan: 1, rowSpan: 1 }],
  },
];

export const templateById = (id: string): Template => templates.find((item) => item.id === id) ?? templates[0];

export const EMPTY_WIDGET: Widget = { type: 'empty' };

/** Changing the template keeps widgets by position: zone n of the new layout takes the widget of zone n of the old one. */
export function remapZones(scene: Scene, nextTemplateId: string): Scene['zones'] {
  const previous = templateById(scene.templateId).zones;
  const next = templateById(nextTemplateId).zones;
  const zones: Scene['zones'] = {};
  next.forEach((zone, index) => { zones[zone.id] = scene.zones[previous[index]?.id ?? ''] ?? EMPTY_WIDGET; });
  return zones;
}

export function emptyZones(templateId: string): Scene['zones'] {
  return Object.fromEntries(templateById(templateId).zones.map((zone) => [zone.id, EMPTY_WIDGET]));
}
