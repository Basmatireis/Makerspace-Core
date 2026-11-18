import type { PdfTemplateBox } from '../../api/generated/models';

/** Boxes at least this thick (mm) are hit-tested as they are; thinner ones (lines) get this much grip. */
const MIN_GRIP_MM = 1.6;

/**
 * The box under a point of a page (mm): the smallest one that contains it, the later one among equals, so a block wins over
 * the container around it. Hairlines (a line has no height) are given a little thickness to be clickable.
 */
export function hitTest(boxes: readonly PdfTemplateBox[], page: number, x: number, y: number): PdfTemplateBox | null {
  let best: PdfTemplateBox | null = null;
  let bestArea = Infinity;
  for (const box of boxes) {
    if (box.page !== page) continue;
    const padX = Math.max(0, (MIN_GRIP_MM - box.w) / 2);
    const padY = Math.max(0, (MIN_GRIP_MM - box.h) / 2);
    if (x < box.x - padX || x > box.x + box.w + padX || y < box.y - padY || y > box.y + box.h + padY) continue;
    const area = (box.w + 2 * padX) * (box.h + 2 * padY);
    if (area <= bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

/** `Math.round(v * 2) / 2`: positions snap to half millimetres. */
export const snapHalf = (v: number): number => Math.round(v * 2) / 2;

/** The geometry of a page-layer element's frame: its own properties, with the render's box for what it does not define. */
export function frameGeometry(
  node: { x?: number; y?: number; w?: number; h?: number; type: string },
  box: Pick<PdfTemplateBox, 'x' | 'y' | 'w' | 'h'>,
): { x: number; y: number; w: number; h: number } {
  const ownHeight = ['rect', 'ellipse', 'picture', 'graphic', 'qr', 'barcode', 'line'].includes(node.type);
  return {
    x: node.x ?? box.x,
    y: node.y ?? box.y,
    w: node.w ?? box.w,
    h: ownHeight && node.h != null ? node.h : box.h,
  };
}
