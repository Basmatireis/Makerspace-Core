import type { SignageBlock } from '../../../api/generated/models';
import { formatOf, isRichTextWidget } from '../widgets';

/** The topmost block under a point (hidden blocks count: the editor draws them faded). */
export function blockAt(blocks: readonly SignageBlock[], point: { x: number; y: number }): SignageBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) return b;
  }
  return null;
}

/** Text a person can edit right on the canvas: HTML text blocks. */
export const isInlineText = (block: SignageBlock) =>
  block.widget.type === 'text' && isRichTextWidget(block.widget) && formatOf(block.widget) === 'html';
