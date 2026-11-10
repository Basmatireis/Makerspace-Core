import type { SignageAspectRatio, SignageBlock } from '../../api/generated/models';
import { sceneGridSize } from './render/aspect';
import { defaultBlockStyle, defaultWidget } from './widgets';

/** A starter template: zones as fractions `[x, y, w, h]` of the usable area, drawn for a landscape screen. */
export type Starter = { id: string; label: string; zones: readonly (readonly [number, number, number, number])[] };

export const STARTERS: readonly Starter[] = [
  { id: 'blank', label: 'Blank', zones: [] },
  {
    id: 'hmf',
    label: 'Header, two panels, footer',
    zones: [
      [0, 0, 1, 0.12],
      [0, 0.15, 0.58, 0.68],
      [0.6, 0.15, 0.4, 0.68],
      [0, 0.86, 1, 0.14],
    ],
  },
  {
    id: 'side',
    label: 'Main with sidebar',
    zones: [
      [0, 0, 0.7, 1],
      [0.72, 0, 0.28, 0.48],
      [0.72, 0.52, 0.28, 0.48],
    ],
  },
  {
    id: 'full',
    label: 'Full screen + ticker',
    zones: [
      [0, 0, 1, 0.84],
      [0, 0.87, 1, 0.13],
    ],
  },
  {
    id: 'quad',
    label: 'Four tiles',
    zones: [
      [0, 0, 0.49, 0.49],
      [0.51, 0, 0.49, 0.49],
      [0, 0.51, 0.49, 0.49],
      [0.51, 0.51, 0.49, 0.49],
    ],
  },
  {
    id: 'column',
    label: 'Stacked rows',
    zones: [
      [0, 0, 1, 0.14],
      [0, 0.17, 1, 0.38],
      [0, 0.58, 1, 0.42],
    ],
  },
];

/** Distance of a new screen's blocks from the edge, in grid units. */
export const STARTER_MARGIN = 48;

/** The starter's zones for a shape: portrait screens get the landscape arrangement transposed. */
export function starterZones(starter: Starter, ratio: SignageAspectRatio) {
  return ratio.height > ratio.width ? starter.zones.map(([x, y, w, h]) => [y, x, h, w] as const) : starter.zones;
}

const randomId = () => `b${Math.random().toString(36).slice(2, 10)}`;

/** Empty blocks laid out like the starter on the screen's grid, inside a margin of 48 units. */
export function starterBlocks(starter: Starter, ratio: SignageAspectRatio): SignageBlock[] {
  const grid = sceneGridSize(ratio);
  const usableWidth = grid.width - 2 * STARTER_MARGIN;
  const usableHeight = grid.height - 2 * STARTER_MARGIN;
  return starterZones(starter, ratio).map(([x, y, w, h], index) => ({
    id: randomId(),
    name: `Block ${index + 1}`,
    x: Math.round(STARTER_MARGIN + x * usableWidth),
    y: Math.round(STARTER_MARGIN + y * usableHeight),
    w: Math.round(w * usableWidth),
    h: Math.round(h * usableHeight),
    hidden: false,
    locked: false,
    widget: defaultWidget('empty'),
    style: defaultBlockStyle('empty'),
  }));
}
