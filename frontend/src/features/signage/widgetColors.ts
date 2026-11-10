import type { SignageBlock, SignageWidget } from '../../api/generated/models';
import type { Draft } from './sceneDraft';

export type ColorSpec = { key: string; label: string; fallback?: string; emptyText: string };

const STATUS: ColorSpec[] = [
  { key: 'busyColor', label: 'Printing', fallback: '#198038', emptyText: 'Default green' },
  { key: 'idleColor', label: 'Idle', emptyText: 'Default light veil' },
  { key: 'unknownColor', label: 'State unknown', fallback: '#f1c21b', emptyText: 'Default yellow' },
  { key: 'progressColor', label: 'Progress bar', fallback: '#42be65', emptyText: 'Default green' },
];
const LIST: ColorSpec[] = [
  { key: 'accentColor', label: 'Date and time', emptyText: 'Text colour' },
  { key: 'competencyColor', label: 'Competencies', emptyText: 'Text colour' },
];

/** The widget colours each type offers; null for types whose colours are all in the style sections. */
export function widgetColorSpecs(type: SignageWidget['type']): readonly ColorSpec[] | null {
  switch (type) {
    case 'status':
      return STATUS;
    case 'camera':
      return [
        { key: 'liveColor', label: 'Live dot', fallback: '#fa4d56', emptyText: 'Default red' },
        { key: 'progressColor', label: 'Progress bar', fallback: '#42be65', emptyText: 'Default green' },
      ];
    case 'timelapse':
      return [{ key: 'captionColor', label: 'Caption text', fallback: '#ffffff', emptyText: 'Default white' }];
    case 'open_days':
    case 'events':
    case 'agenda':
      return LIST;
    case 'qr':
      return [
        { key: 'darkColor', label: 'Code', fallback: '#161616', emptyText: 'Default black' },
        { key: 'lightColor', label: 'Code background', fallback: '#ffffff', emptyText: 'Default white' },
      ];
    default:
      return null;
  }
}

/** Every colour slot of a screen: its background, each block's style colours, calendar categories and widget colours. */
function slots(draft: Draft): { get: () => string | null | undefined; set: (draft: Draft, color: string) => Draft }[] {
  const list: { get: () => string | null | undefined; set: (draft: Draft, color: string) => Draft }[] = [
    { get: () => draft.backgroundColor, set: (d, color) => ({ ...d, backgroundColor: color }) },
  ];
  const updateBlock = (d: Draft, id: string, change: (b: SignageBlock) => SignageBlock): Draft => ({
    ...d,
    blocks: d.blocks.map((b) => (b.id === id ? change(b) : b)),
  });
  for (const block of draft.blocks) {
    for (const key of ['backgroundColor', 'textColor', 'borderColor'] as const) {
      list.push({
        get: () => block.style[key],
        set: (d, color) => updateBlock(d, block.id, (b) => ({ ...b, style: { ...b.style, [key]: color } })),
      });
    }
    const widget = block.widget;
    if (widget.type === 'calendar') {
      for (const key of ['holiday', 'break', 'openDay', 'event'] as const) {
        list.push({
          get: () => widget.colors[key],
          set: (d, color) =>
            updateBlock(d, block.id, (b) =>
              b.widget.type === 'calendar'
                ? { ...b, widget: { ...b.widget, colors: { ...b.widget.colors, [key]: color } } }
                : b,
            ),
        });
      }
    }
    for (const spec of widgetColorSpecs(widget.type) ?? []) {
      list.push({
        get: () => (widget as unknown as Record<string, string | undefined>)[spec.key],
        set: (d, color) =>
          updateBlock(d, block.id, (b) => ({ ...b, widget: { ...b.widget, [spec.key]: color } as SignageWidget })),
      });
    }
  }
  return list;
}

export type ScreenColor = { color: string; count: number };

/** The colours set anywhere on the screen, most used first (ties keep their first appearance). */
export function screenColors(draft: Draft): ScreenColor[] {
  const counts = new Map<string, number>();
  for (const slot of slots(draft)) {
    const color = slot.get()?.toLowerCase();
    // "transparent" is no colour to change in one place.
    if (color && color !== 'transparent') counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count);
}

/** The screen with every use of `from` replaced by `to`. */
export function replaceScreenColor(draft: Draft, from: string, to: string): Draft {
  return slots(draft).reduce(
    (next, slot) => (slot.get()?.toLowerCase() === from.toLowerCase() ? slot.set(next, to) : next),
    draft,
  );
}
