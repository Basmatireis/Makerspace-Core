import type { SignageBlock } from '../../../api/generated/models';
import { type WidgetType, defaultBlockStyle, defaultWidget } from '../widgets';

export const GRID = { width: 1920, height: 1080 };

export function block(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<SignageBlock> = {},
  type: WidgetType = 'empty',
): SignageBlock {
  return {
    id,
    name: id.toUpperCase(),
    x,
    y,
    w,
    h,
    hidden: false,
    locked: false,
    widget: defaultWidget(type),
    style: defaultBlockStyle(type),
    ...extra,
  };
}

export const ids = (blocks: readonly SignageBlock[]) => blocks.map((b) => b.id);
